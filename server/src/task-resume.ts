// 「运行/重试/队列推进」时选 resume 还是 fresh（从 orchestrator.ts 拆出，纯行数拆分）。
// 依赖方向单向：这里 import orchestrator，orchestrator 不回头 import 这里。
import { eq } from "drizzle-orm";
import type { AgentType } from "@ash/shared";
import type { InputAcceptance } from "./executors/types.js";
import { lastWordOnInput } from "./turn-input-acceptance.js";
import { db } from "./db/index.js";
import { sessions, tasks } from "./db/schema.js";
import { continueTask, runTask, type ResumeReason } from "./orchestrator.js";
import { handDuePendingMessageToRun } from "./pending-messages.js";
import { RESUME_PROMPT } from "./run-prompts.js";
import { freeReviewResumeOptions } from "./free-workflow.js";
import {
  acknowledgeCheckpointRun, claimCheckpointForRun, type CheckpointHold, holdCheckpointOwnership,
  settleStrandedCheckpointRun,
} from "./task-checkpoint-delivery.js";
import { preparePendingCheckpointStart } from "./pending-checkpoint-recovery.js";
import { activeReviewEvidence } from "./review-continuation.js";
import { takeResumePrompt } from "./task-resume-prompt.js";
import { withHeldTurn } from "./turn-entry-guard.js";
import { checkpointWaitOrigin } from "./task-wait-ownership.js";
import { releaseTurn } from "./runs.js";
import type { TurnIdentity } from "./runs.js";

// Decide between a fresh run and a resume when (re)starting a single task. A task
// that was interrupted keeps a session row with a cliSessionId (server restart
// leaves exitStatus null; manual stop / non-zero exit keep the id too) — resume
// THAT session so the agent continues from where it stopped, like the user typing
// 继续. A never-started task (no resumable session) runs fresh. paused 任务带着
// agent 写下的 resumePrompt 进来 —— 把它当作 user 输入回灌给 CLI 会话再清空，所以
// 不会反复触发同一段 prompt。Tail-returns the delegate so callers (esp. the
// scheduler) keep chaining on the same promise.
export async function resumeOrRunTask(
  taskId: string,
  // turnHeld:入口占下的那把锁的身份(不是 true),见 continueTask 同名选项。
  opts: { reason?: ResumeReason; turnHeld?: TurnIdentity | null; actingUserId?: string | null } = {},
): Promise<void> {
  // 返回时还没交出去的锁由这一层还(检查点凭证失权、待发送交接被别人接管那几条出路),见 withHeldTurn。
  return withHeldTurn(taskId, opts.turnHeld, () => resumeOrRunClaimedTask(taskId, opts));
}

async function resumeOrRunClaimedTask(taskId: string,
  opts: { reason?: ResumeReason; turnHeld?: TurnIdentity | null; actingUserId?: string | null }): Promise<void> {
  const checkpointBlocked = await preparePendingCheckpointStart(taskId);
  if (checkpointBlocked) throw new Error(checkpointBlocked);
  // `actingUserId` 一路原样往下传:它决定这一轮烧谁的 key(§八)。这里只是个中转,
  // 不给默认值 —— 后端触发的那几路本来就该退回任务归属人。
  const acting = opts.actingUserId ?? undefined;
  const held = opts.turnHeld ?? null;
  // 启动来源与回合所有权是两件事,不能共用 turnHeld 当判据(第 6 轮审查:队列推进带
  // turnHeld 后,待发送交接误享了手动运行的冻结豁免,穿透分组暂停)。无人值守的启动
  // (队列推进/恢复分组/上游唤醒)从预检查到 spawn 隔着一串 await,用户可能在认领之前
  // 刚按下暂停 —— 那一刻既没有回合可打内存冻结标记、isPaused 预检查又已经读过旧值,
  // 唯一可靠的是 spawn 前按持久事实复查(turn-freeze.ts 的 checkFacts);手动运行/重试
  // 是用户显式动作,照旧不加闸。
  const freezeGuard =
    opts.reason === "queue" || opts.reason === "group" || opts.reason === "wake" ? true : undefined;
  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!task || task.mode !== "single") return runTask(taskId, { turnHeld: opts.turnHeld, freezeGuard, actingUserId: acting }); // duets/missing → unchanged path
  // 检查点续跑：resumePrompt 当 user 消息回灌同一会话，先清空避免再次 settle 时又认成
  // paused（调度器会先标 queued，不能只看 paused）。reviewing run 挂着 = 中断的是审查
  // 回合：续跑必须带回 reviewer 身份与配置，否则以 single 恢复实现会话，审查链收不了尾。
  const rp = task.resumePrompt;
  if (rp) {
    const origin = await db.transaction((transaction) => checkpointWaitOrigin(transaction, task), { behavior: "immediate" });
    const ordinary = origin.kind === "ordinary";
    const reviewerRoute = ordinary ? null : await freeReviewResumeOptions(taskId);
    if (!ordinary) {
      const evidence = await db.transaction((transaction) => activeReviewEvidence(transaction, task), { behavior: "immediate" });
      const started = await continueTask(taskId, rp, { system: opts.reason ?? "run", turnHeld: opts.turnHeld, freezeGuard,
        actingUserId: acting, ...(reviewerRoute ?? {}),
        reviewDelivery: { kind: "checkpoint", generation: evidence?.generation ?? null, text: rp, promptGeneration: task.resumePromptGeneration },
        // 只有**确认收下**才消费这段交代。`refused`/`unknown` 一律不消费:这条路(审查链的
        // 续跑)没有 scheduled_messages 那张票可以留在「在途」,交代就在任务行上那一格 ——
        // 消费掉就再也回不来,而留着最坏是下一次运行重投一遍。审查链卡死不可恢复,重投可以。
        onInputSettled: async (acceptance) => {
          if (acceptance === "accepted") { await takeResumePrompt(taskId, rp, task.resumePromptGeneration); return; }
          console.warn(`[ash] 任务 ${taskId} 审查续跑交代没拿到「agent 收下了」的回执（${acceptance}），`
            + "这段交代原样留在任务上，下一次运行会重投");
        },
      });
      if (!started) await (await import("./regression-settlement.js")).reconcileRegressionSettlements(taskId);
      return;
    }
    const receipt = await claimCheckpointForRun(taskId, rp, task.resumePromptGeneration);
    if (receipt) {
      let delivered = false;
      // `continueTask` 返回 false = 这一轮**一个字都没送出去**(起跑前被冻结闸撤回,或者越线
      // 凭据写不下来而原地撤回)。抛错那条路不给这个结论,所以初值按「不知道」算。
      let launched = true;
      // 协议层给的那一档(拿不到就是 null)。注意它可能是**几十秒前**有界等待的结果,所以
      // finally 不拿它直接下结论 —— 见下面 lastWordOnInput 那一段。
      let settledAs: InputAcceptance | null = null;
      // 回执本体:结算之前再问它最后一句(回合都结束了,那时它早已落定)。
      let receiptPromise: Promise<InputAcceptance> | undefined;
      // 这一轮的账还该不该由我来结。失权之后一个字都不许写:那边可能已经按别的结论处置过
      // 这张票了(第 2 轮自由审查 F1 的第 5 条 —— 早先这里 return 之后 finally 照旧了结旧票)。
      // 三态:`mine` 才由我结账;`lost`/`unknown` 两条路的善后(交回本地投递登记、必要时
      // 退避重排一趟对账)都已经在 holdCheckpointOwnership 里做完,这里只负责不起跑、不写账。
      let hold: CheckpointHold = "mine";
      try {
        // 认领与起跑之间隔着几个 await:这段里对账可能已经把这张凭证接管走、并按「没送出去」
        // 把交代还给了任务(多开实例时尤其)。那种情况下再送一遍就是执行两遍。资格这一问是
        // 一次**条件写**而不是一次读,问不出来也一律不起跑(holdCheckpointOwnership 的头部)。
        hold = await holdCheckpointOwnership(receipt);
        if (hold !== "mine") {
          console.warn(`[ash] 续跑凭证${hold === "lost" ? "已不在本进程名下" : "的归属这会儿问不出来"}`
            + ` task=${taskId} message=${receipt.id}：这一趟不再起跑`);
          return;
        }
        launched = await continueTask(taskId, rp, {
          system: opts.reason ?? "run", turnHeld: opts.turnHeld, freezeGuard,
          actingUserId: acting, ...(reviewerRoute ?? {}),
          pendingMessageIds: [receipt.id], crossingRequired: true,
          onInputReceipt: (promise) => { receiptPromise = promise; },
          // 只有 `accepted` 才确认消费;另两档交给下面的 finally。这个回调**会被调第二次**
          // (初次 unknown 之后回执还在落定,见 task-continue-options.ts),所以它只记事实 +
          // 幂等地补记账,不在这里做归还那种一次性动作。
          onInputSettled: async (acceptance) => {
            settledAs = acceptance;
            if (acceptance !== "accepted") return;
            delivered = true;
            await acknowledgeCheckpointRun(receipt);
          },
        });
      } finally {
        // 没走到送达回调 ≠ 没送出去:spawn 排在 persistRunner 与 onDelivered **之前**,崩在
        // 中间那条缝里时这段话已经在 agent 手上了。三态判定与三条出路统一在
        // settleStrandedCheckpointRun(第 1 轮审查 F1:这里原先一律归还)。
        if (!delivered && hold === "mine") {
          // **结算之前再问回执最后一句**(第 2 轮自由审查 F1 的那一半):初次那一档是有界等待的
          // 结果,`unknown` 多半只是「应答还没回来」;而这一刻回合都结束了,进程一关、未完成的
          // 请求一律落定。拿过期的 `unknown` 结算,就会把一段**明确被拒收**的交代结成「交付
          // 不明」,而它本该原样归还 —— 实测那一跑里垫片只读了 initialize 就退出,日志先说
          // 「输入没能送进 agent」,随后却把交代当成已送达补记掉了。
          const fact = !launched ? "not-launched" : await lastWordOnInput(receiptPromise, settledAs);
          if (fact === "accepted") {
            // 迟到的确认:这段交代确实到了 agent 手里 —— 只能往前走,绝不归还。
            delivered = true;
            await acknowledgeCheckpointRun(receipt);
          } else {
            await settleStrandedCheckpointRun(receipt, "本轮续跑交代未走到送达确认",
              fact === "not-launched" ? "not-launched" : fact === "refused" ? "refused" : "unknown");
          }
        }
      }
      return;
    }
    // 还的只能是入口交给我们的那一把(核验在 releaseTurn 里按 seq 做)。
    if (held) releaseTurn(taskId, held);
    return;
  }
  const agent = (task.agentType as AgentType) ?? "claude";
  // 让位交接:托盘里已有**到期**的用户回复时,这次(队列推进/手动运行/重试)启动的
  // 输入就是那条回复,而不是空泛「继续」—— 否则任务先按旧方向跑完一整轮,排队期间
  // 的修改要求迟到到回合之后(第 xNb655YqYzcA 链第 3 轮实测)。checkpoint resumePrompt
  // 在上面仍然优先(那是 agent 自己的流水线交接,消息投递时会消费它);终态任务的
  // 续聊不经过本函数,照旧不受影响。记账与去重都在 handDuePendingMessageToRun 里走
  // 投递链路同一套租约,tick / 终态钩子不会把同一条再发一遍;执行/记录语义见
  // continueTask 的 executionTurn 注释(第 4 轮审查:执行意图与输入来源分开表示)。
  if (await handDuePendingMessageToRun(taskId, {
    turnHeld: opts.turnHeld,
    freezeGuard,
    actingUserId: acting ?? null,
  })) return;
  const prev = (await db.select().from(sessions).where(eq(sessions.taskId, taskId)))
    .filter((s) => s.agentType === agent)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .at(0);
  // 删过消息的会话(contextRebuildAt)即便 cliSessionId 已置空(接力导入、会话失效)也走续聊:
  // 那条路会拿删除后的记录重建上下文,runTask 则是从任务正文全新起跑、整段历史都丢了。
  if (prev?.cliSessionId || prev?.contextRebuildAt) {
    const reviewerRoute = await freeReviewResumeOptions(taskId);
    await continueTask(taskId, RESUME_PROMPT, { system: opts.reason ?? "run", turnHeld: opts.turnHeld, freezeGuard, actingUserId: acting, ...(reviewerRoute ?? {}) });
    return;
  }
  return runTask(taskId, { turnHeld: opts.turnHeld, freezeGuard, actingUserId: acting }); // no resumable session → fresh
}
