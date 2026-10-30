// 「运行/重试/队列推进」时选 resume 还是 fresh（从 orchestrator.ts 拆出，纯行数拆分）。
// 依赖方向单向：这里 import orchestrator，orchestrator 不回头 import 这里。
import { eq } from "drizzle-orm";
import type { AgentType } from "@ash/shared";
import { db } from "./db/index.js";
import { sessions, tasks } from "./db/schema.js";
import { continueTask, runTask, type ResumeReason } from "./orchestrator.js";
import { handDuePendingMessageToRun } from "./pending-messages.js";
import { RESUME_PROMPT } from "./run-prompts.js";
import { freeReviewResumeOptions } from "./free-workflow.js";
import {
  acknowledgeCheckpointRun, claimCheckpointForRun, holdCheckpointOwnership, settleStrandedCheckpointRun,
} from "./task-checkpoint-delivery.js";
import { preparePendingCheckpointStart } from "./pending-checkpoint-recovery.js";
import { activeReviewEvidence } from "./review-continuation.js";
import { takeResumePrompt } from "./task-resume-prompt.js";
import { withTurnPreflight } from "./turn-entry-guard.js";
import { checkpointWaitOrigin } from "./task-wait-ownership.js";
import { releaseTurn, turnIdentity } from "./runs.js";

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
  opts: { reason?: ResumeReason; turnHeld?: boolean; actingUserId?: string | null } = {},
): Promise<void> {
  return withTurnPreflight(taskId, opts.turnHeld, () => resumeOrRunClaimedTask(taskId, opts));
}

async function resumeOrRunClaimedTask(taskId: string,
  opts: { reason?: ResumeReason; turnHeld?: boolean; actingUserId?: string | null }): Promise<void> {
  const checkpointBlocked = await preparePendingCheckpointStart(taskId);
  if (checkpointBlocked) throw new Error(checkpointBlocked);
  // `actingUserId` 一路原样往下传:它决定这一轮烧谁的 key(§八)。这里只是个中转,
  // 不给默认值 —— 后端触发的那几路本来就该退回任务归属人。
  const acting = opts.actingUserId ?? undefined;
  const held = opts.turnHeld ? turnIdentity(taskId) : null;
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
        onDelivered: async () => { await takeResumePrompt(taskId, rp, task.resumePromptGeneration); },
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
      // 这一轮的账还该不该由我来结。失权之后一个字都不许写:那边可能已经按别的结论处置过
      // 这张票了(第 2 轮自由审查 F1 的第 5 条 —— 早先这里 return 之后 finally 照旧了结旧票)。
      let owned = true;
      try {
        // 认领与起跑之间隔着几个 await:这段里对账可能已经把这张凭证接管走、并按「没送出去」
        // 把交代还给了任务(多开实例时尤其)。那种情况下再送一遍就是执行两遍。资格这一问是
        // 一次**条件写**而不是一次读,读不出来按失权算(holdCheckpointOwnership 的头部)。
        owned = await holdCheckpointOwnership(receipt);
        if (!owned) {
          console.warn(`[ash] 续跑凭证已不在本进程名下 task=${taskId} message=${receipt.id}：这一趟不再起跑`);
          return;
        }
        launched = await continueTask(taskId, rp, {
          system: opts.reason ?? "run", turnHeld: opts.turnHeld, freezeGuard,
          actingUserId: acting, ...(reviewerRoute ?? {}),
          pendingMessageIds: [receipt.id], crossingRequired: true,
          onDelivered: async () => {
            delivered = true;
            await acknowledgeCheckpointRun(receipt);
          },
        });
      } finally {
        // 没走到送达回调 ≠ 没送出去:spawn 排在 persistRunner 与 onDelivered **之前**,崩在
        // 中间那条缝里时这段话已经在 agent 手上了。三态判定与三条出路统一在
        // settleStrandedCheckpointRun(第 1 轮审查 F1:这里原先一律归还)。
        if (!delivered && owned) {
          await settleStrandedCheckpointRun(receipt, "本轮续跑交代未走到送达确认", !launched);
        }
      }
      return;
    }
    if (held && turnIdentity(taskId) === held) releaseTurn(taskId);
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
  if (prev?.cliSessionId) {
    const reviewerRoute = await freeReviewResumeOptions(taskId);
    await continueTask(taskId, RESUME_PROMPT, { system: opts.reason ?? "run", turnHeld: opts.turnHeld, freezeGuard, actingUserId: acting, ...(reviewerRoute ?? {}) });
    return;
  }
  return runTask(taskId, { turnHeld: opts.turnHeld, freezeGuard, actingUserId: acting }); // no resumable session → fresh
}
