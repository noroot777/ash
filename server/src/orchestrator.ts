import { mkdirSync, createWriteStream, existsSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type { AgentType, SessionRole, TaskStatus } from "@ash/shared";
import { db } from "./db/index.js";
import { tasks, projects, sessions } from "./db/schema.js";
import { bus } from "./bus.js";
import { id, now, attachmentsPrompt } from "./util.js";
import { setTaskStatus } from "./status.js";
import { bindNativeSteer, trackRun, untrackRun, takeSteered, takeStopped, claimTurn, reclaimTurn, releaseTurn } from "./runs.js";
import { consumeSingleRun, afterSettlement } from "./single-run.js";
import { refreshTaskBase, taskWorkspace } from "./task-workspace.js";
import type { Workspace } from "./git.js";
import { resolveExecutorWithProfile } from "./executors/index.js";
import type { RunHandle } from "./executors/types.js";
import { detachedPathsFor } from "./executors/detached.js";
import { inspectProcess } from "./proc.js";
import { RUNS_DIR } from "./paths.js";
import { writeTurn, runTracePaths } from "./transcript.js";
import { recordUserConversationTurn } from "./conversation-turn.js";
import { deliverToLead } from "./team/session.js";
import { workerPreambleFor } from "./team/dispatch.js";
import { clearAcceptedSnapshot, peekAcceptedStage } from "./task-stage.js";
import { reviewReminderFor, verifyReminderFor } from "./review-prompts.js";
import { peerNoticeFor } from "./peer-context.js";
import { reconcileTurnBaseline, recordTurnBaseline } from "./turn-baseline.js";
import { recordTurnStart } from "./turn-output.js";
import { abortIfFrozen } from "./turn-freeze.js";
import { freeReviewReminder } from "./free-workflow.js";
import { nativeCliCommand, withSkillInvocation } from "./skills.js";
import { invitedTaskBrief } from "./invited-task-brief.js";
import { withGlobalBrowserPolicy } from "./browser-verification-policy.js";
import { isAcceptingTask } from "./acceptance-lock.js";
import { handoffBlockReason } from "./handoff-guard.js";
import { reportTurnFailure } from "./turn-failure.js";
// 每一轮 prompt 上下拼的固定措辞(前言、完成协议、续聊尾巴、工作目录重建告警)。
import {
  COLLAB_INVITE, SYS_MARKER,
  COMPLETION_REMINDER, FOLLOW_UP_REMINDER, followUpRailNote,
  WORKSPACE_RESET, WORKSPACE_RESET_MARKER,
} from "./run-prompts.js";
// 「登记的基线被换掉了」这句话：说不说、怎么说、失败那条路怎么补，全在这一份里。
import { announceBaseFallback, baseFallbackNote } from "./base-fallback-notice.js";
import { readCodexCliVersion } from "./executors/codex-rollout.js";
import { affectedCodexSessionWarning } from "./executors/version-policy.js";
import { LOST_SESSION_PATCH } from "./executors/session-lost.js";

// Why a task is being (re)started — only used to label the resume; all reasons
// behave the same (resume if there's a resumable session, else fresh). Note: a
// scheduled cron fire is NOT here — it always starts a fresh run via runTask
// (schedules.ts), so it never resumes. `wake` = an upstream task just settled
// done and the settle hook is auto-resuming this paused dependent.
export type ResumeReason = "group" | "run" | "retry" | "wake" | "queue";

async function setStatus(taskId: string, status: Parameters<typeof setTaskStatus>[1]) {
  await setTaskStatus(taskId, status);
}


export { reconcileInterrupted } from "./task-reconcile.js";


// fresh run(从任务描述起一条全新会话)住在 task-run.ts；这里保留原路径的具名导出，
// 免得 schedules / 路由 / 重试那几处调用方跟着改。
export { runTask } from "./task-run.js";


// Continue a single task. By default this resumes the task's own agent (answer
// an agent that stopped to ask). With opts.agent it targets another agent: if
// that agent already has a session here, resume it; otherwise invite it fresh
// into the SAME working directory (same-dir collaboration). Single-flight by
// taskId keeps invitees from running concurrently with the main agent.
//
// opts.executorId / opts.model / opts.reasoningEffort 是 @ 提及那一步选定的**具体执行器、
// 模型与思考强度**（对话框里那个「智能体 · 模型」框）。只作用于这一回合：任务自己的
// executorId/model/reasoningEffort 是它的常设配置，被 @ 换成别的执行器时不该被这一次召唤改写。
//
// **返回值 = 这一次调用有没有接管这个回合**。false 只有一种来源：单飞锁被别人占着，
// 这一句话**一个字都没送出去**。以前这里 `return`（Promise<void>），调用方无从分辨
// 「跑完了」和「压根没跑」，于是排队消息被标成 sent 之后凭空消失（`docs/incidents.md`
// 「排队消息凭空消失」）。凡是拿着**用户原话**来调它的调用方，都必须处理 false —— 要么
// 退回待发送队列重试，要么如实告诉用户没送出去，绝不许静默丢字。
export async function continueTask(
  taskId: string,
  userText: string,
  opts: {
    agent?: AgentType;
    executorId?: string | null;
    model?: string | null;
    reasoningEffort?: string | null;
    attachments?: string[];
    system?: ResumeReason;
    /** 旁路回合结束后恢复进入旁路前的任务状态。 */
    sideTurn?: boolean;
    sessionRole?: Extract<SessionRole, "single" | "reviewer">; freshSession?: boolean;
    /** 内部旁路回合可钉在一个准确工作目录（例如验收快照的 detached worktree）。 */
    cwd?: string;
    /**
     * 指名续**这一条**会话行（而不是按 agentType+role 现挑）。给「重跑上一回合」用：
     * 那条路的硬要求就是落回崩掉的那一条会话，挑错人 = 换个人重说一遍。
     * 行已不存在时退回新开会话（读它的调用方刚读过库，正常不会发生）。
     */
    resumeSessionId?: string;
    /**
     * 这一轮的字是**后端代写**的（验证打回的报告、验收冲突的交接说明），但它必须占一个
     * 真人回合 —— 带 system 会被当成「系统续跑」，followUpFrom 就护不住任务原来的终态。
     * 于是落盘时标一位 by:"system"，让读端（Inspector 的「后续追问」、侧边栏铺开那一列）
     * 能把它跟我自己打的字分开。默认 false = 真人发的。
     */
    byBackend?: boolean;
    /**
     * 调用方已在入口**原子占住** turn（claimTurn 成功后传 true）：这里不再抢锁，用
     * sessionRole 接管（reclaimTurn）并照常在 finally 释放。入口占位是并发双 202 谎报
     * 的唯一解——只读预检查后的任何 await 间隙都可能被另一次启动抢先。
     */
    turnHeld?: boolean;
    /**
     * 起跑前再查一遍冻结事实（分组暂停 / 任务被删或归档），命中就在 spawn 之前撤回。
     *
     * 给「预检查离 spawn 很远」的启动路径开：重试按钮、自由审查重跑 —— 它们从只读预检查
     * 到真正拉起 CLI 之间隔着权威重读、执行器解析、工作目录准备、上一条输入的读取，中途
     * 还会把回合锁交接一次。普通续聊不开：在一个排队中/分组暂停的任务上发消息本来就允许，
     * 那不是被冻结的启动（说明见 turn-freeze.ts）。
     */
    freezeGuard?: boolean;
    /**
     * 「用户这句话已经**落盘**了」的回调 —— 在原话作为一个真人回合写进会话之后立刻调，
     * 不等这一轮跑完（`continueTask` 要等整轮结束才 resolve，那时早过了）。
     *
     * 给排队/定时消息用：它们要在这一刻、而不是更早，才把库里那条标成 sent。早一步标，
     * 进程死在中间就是「托盘里没了、会话里也没有」——用户那句话凭空蒸发
     * （见 docs/incidents.md「排队消息凭空消失」）。
     */
    onDelivered?: () => void | Promise<unknown>;
    throwOnTeamUnavailable?: boolean;
  } = {},
): Promise<boolean> {
  // 这条消息是不是 CLI 原生命令(`/compact`):整条归 CLI 本地执行,不进模型 —— 它既不是
  // 任务的执行,也不是「新指令」。这一轮必须当旁路回合(下面的 sideTurn),否则「压一下
  // 上下文」既会被打成 failed,也会顺手把已验收的牌子摘掉——旁路回合不拍工作目录快照,
  // 没有任何基线能把摘掉的牌子挂回去,压一次就永久丢掉一次验收。
  const head = (await db
    .select({ mode: tasks.mode, agentType: tasks.agentType, handoff: tasks.handoff })
    .from(tasks)
    .where(eq(tasks.id, taskId))).at(0);
  const nativeCommand = nativeCliCommand(
    opts.agent ?? (head?.agentType as AgentType) ?? "claude",
    userText,
  );
  // 团队任务(§Team):插话直接写进常驻调度台的 stdin —— 即时、同一会话、用户侧
  // 感觉不断线。不占这里的单飞锁(那把锁是给「一次运行 = 一个回合」的单任务用的,
  // 调度台的一次运行是整段常驻)。于是 /reply、/answer、@提及全都自动生效。
  // 验收互斥对 team 只能靠这一次检查（调度台没有 turn 锁）；调度台不走验收链，
  // 摘牌对它本来就是 no-op，破坏面只有消息时序。
  if (head?.mode === "team") {
    if (opts.turnHeld) releaseTurn(taskId); // 占位对常驻调度台无意义，原样还回
    if (isAcceptingTask(taskId)) return false;
    // 调度台明确拒收(离线时收到 `/compact` 这类原生命令,拼上唤醒前言就不再是命令)
    // 时,这一句**一个字都没送出去** —— 绝不能顺手 onDelivered():那是 pending → sent
    // 的唯一写点,标了 sent 排队/定时的那条就从托盘里消失、会话里也没有,用户的话凭空
    // 蒸发(docs/incidents.md「排队消息凭空消失」)。跟单飞锁挡回同一口径:返回 false。
    const delivered = await deliverToLead(taskId, userText, {
      attachments: opts.attachments,
      throwOnOpenFailure: opts.throwOnTeamUnavailable,
    });
    if (!delivered) return false;
    if (opts.onDelivered) {
      try { await opts.onDelivered(); } catch { /* 记账失败不拖累这一轮 */ }
    }
    return true;
  }
  // 接力出去的任务在本机只是历史存档 —— 路由层各有 409,但队列推进/排队消息投递等
  // 程序化续聊全汇到这里,必须在占位之前收口(消息按「未投递」留在托盘,事实不丢)。
  if (handoffBlockReason(head?.handoff)) {
    if (opts.turnHeld) releaseTurn(taskId);
    return false;
  }
  // 抢不到 = 这个任务此刻正跑着别的回合,这一句话没送出去。调用方必须知道(见函数注释)。
  // turnHeld = 调用方已在入口原子占好位(consulted continueWhenIdle / run 路由),这里
  // 用真实身份接管——只读预检查代替不了原子所有权(审查实测:两个并发启动双双 202)。
  const sessionRole = opts.sessionRole ?? "single";
  if (opts.turnHeld) reclaimTurn(taskId, sessionRole);
  else if (!claimTurn(taskId, sessionRole)) return false;
  // 验收互斥：**先占己锁（turn），再查彼锁（acceptance），两步之间没有 await**——
  // acceptTask 那边是镜像（beginAccepting 先占，acceptanceGuard 再查 isTurnClaimed）。
  // 任意交错下至少一方看到对方已占而退避；只查不占是 TOCTOU（审查实测 40/40：检查刚
  // 通过验收就开始，回复照样启动并摘牌）。退避 = 消息按「未投递」排队，验收事实原封不动。
  if (isAcceptingTask(taskId)) {
    releaseTurn(taskId);
    return false;
  }
  // catch 那边署名用的就是它：出错时 task 可能压根没读出来，所以按 head 的快照兜底，
  // 而不是硬写 "claude"（该任务是 codex 时，错误会挂到一个从没参与过的智能体名下）。
  const agentType = opts.agent ?? (head?.agentType as AgentType) ?? "claude";
  let handle: RunHandle | undefined;
  // 同 runTask：基线降级在解析工作目录那一刻就落了库，说明却写在 spawn 之后，所以这两件
  // 事挂在 try 外面，失败那条路才补得上（见 base-fallback-notice.ts）。
  let baseFallback: Workspace["baseFallback"];
  let baseFallbackTold = false;
  try {
    const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
    if (!task) throw new Error("task not found");
    if (task.mode !== "single") throw new Error("reply is for single tasks");

    const agent = opts.agent ?? (task.agentType as AgentType) ?? "claude";
    // 对话框里 @ 出来的那一步是**显式选择**（智能体 + 执行器 + 模型 + 思考强度），这一回合
    // 整套按它跑；没 @ 就沿用任务自己的常设配置。三个字段必须同进同出：思考强度的档位表
    // 是跟着 CLI 走的，只要换了智能体，任务自带的强度就属于另一张表，不能漏过来。
    const summoned = !!opts.agent;
    // 续聊(follow-up):任务已经到终态了,用户又发来一条消息 —— 这一轮是「任务
    // 之后的对话」,不是任务的执行。把续聊前的终态记下来:队列一律按它看待这个
    // 成员(既不算「有人在跑」冻住整条线,也不会被当成可启动项拉起来),结算时
    // 再回到它(见 settleTaskStatus 的续聊分支)。
    // 只认真人消息:后端发起的续跑(retry / 手点运行 / 队列推进 / 上游唤醒)带
    // opts.system,那是真的在执行这个任务,照旧占住队列位置。
    // 例外是旁路回合(opts.sideTurn,就地验证):它虽然由后端发起,却同样不是这个
    // 任务的执行 —— 验证没通过不该把一个 done 打成 failed。任务身上还挂着 verify_round
    // 时,这一轮同样算旁路:验证中途提问、答复回来续跑的那一回合仍属于这轮验证,
    // 走的却是普通的 /answer,不带 sideTurn。
    // 旁路回合恢复的是**进这一轮之前的原状态**,不限 done/failed/canceled —— 用户可以
    // 对一个 paused 的任务手点「再验一轮」,验完它该还是 paused。
    // **这一段必须排在所有可能抛错的解析之前**(执行器解析、工作目录解析都会抛:模型与
    // 思考强度不兼容、worktree 建不出来),catch 那边只认库里的 followUpFrom —— 落库晚
    // 一步,一个 done 的任务就会因为「验证没起来」被打成 failed。
    // 自由审查回合的身份**只认 opts 显式传递**（派审投递、/answer 路由、checkpoint 续跑
    // 各自带上 sessionRole=reviewer），不查库猜——库里的 reviewing run 可能是并发派审刚
    // 插入的，按它猜会把一个普通用户回合整套套上 reviewer 语义（审查实测）。
    const freeReviewTurn = sessionRole === "reviewer";
    // `/compact` 这类 CLI 原生命令(在函数顶部就算好了):整条消息归 CLI 本地执行,不进
    // 模型 —— 没有产出、也不可能交卷,所以必须当旁路回合,否则「压一下上下文」会把任务
    // 打成 failed。
    const sideTurn = !!opts.sideTurn || !!task.verifyRound || freeReviewTurn || !!nativeCommand;
    // DB 里的 verifyRound/nativeTurn 会在结算中途先清，handle/turn 要到 finally 才释放。
    // 把旁路身份也钉进运行时 turn role，关闭那段“标记已清、进程仍可被引导”的小窗口。
    if (sideTurn && sessionRole === "single") reclaimTurn(taskId, nativeCommand ? "native" : "side");
    const followUpFrom = sideTurn
      ? (task.status === "running" || task.status === "queued" ? null : task.status)
      : !opts.system && ["done", "failed", "canceled"].includes(task.status)
        ? task.status
        : null;
    // 新回合起点:顺手清掉上一轮残留的完成确认(确认只在本回合内有效)。
    // nativeTurn 落库而不是只留在内存里:结算钩子跟这里可能不在同一个进程(重启后由
    // reattach 接着消费同一条流),内存标记会丢,而丢了就等于「压缩被算成一轮验证跑完」。
    const turnToken = id();
    await db
      .update(tasks)
      .set({ followUpFrom, nativeTurn: !!nativeCommand, completeConfirmedAt: null, activeTurnToken: turnToken, updatedAt: now() })
      .where(eq(tasks.id, taskId));

    const { executor: ex, profileId, profileFingerprint } = await resolveExecutorWithProfile({
      executorId: summoned ? opts.executorId ?? null : task.executorId,
      type: agent,
      model: summoned ? opts.model ?? null : task.model,
      reasoningEffort: summoned ? opts.reasoningEffort ?? null : task.reasoningEffort,
    });
    const project = (await db.select().from(projects).where(eq(projects.id, task.projectId))).at(0);

    // A single task can now host several agents — one session line per agentType,
    // each invited via @-mention. Newest first.
    const all = (await db.select().from(sessions).where(eq(sessions.taskId, taskId)))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    let prev = opts.freshSession
      ? undefined
      // 指名道姓要续哪一条会话行（「重跑上一回合」）：按 agentType+role 挑会在同一位
      // 智能体有多条会话时挑错人，而重投必须落回**崩掉的那一条**，否则等于换个人重说。
      : opts.resumeSessionId
        ? all.find((s) => s.id === opts.resumeSessionId)
        : all.find((s) => s.agentType === agent && s.role === sessionRole);
    let sessionUpgradeNote: string | undefined;
    if (agent === "codex" && prev?.cliSessionId) {
      const warning = affectedCodexSessionWarning(await readCodexCliVersion(prev.cliSessionId));
      if (warning) {
        await db.update(sessions).set(LOST_SESSION_PATCH).where(eq(sessions.id, prev.id));
        sessionUpgradeNote = `${warning} 本轮已使用全新会话。`;
        prev = undefined;
      }
    }
    const resuming = !!prev?.cliSessionId;

    // Where the work lives: the agent's own cwd, else any session's cwd (so the
    // invitee sees prior output), else materialize the task workdir.
    const recorded = opts.cwd || prev?.cwd || prev?.worktreePath || all[0]?.cwd || all[0]?.worktreePath || "";
    // A recorded cwd that has since vanished (worktree cleaned up, project moved)
    // used to be handed to spawn as-is — which stuck the task in 'running' forever.
    // Re-resolve through the same path a fresh run takes: it RESTORES the worktree
    // when the branch outlived the directory, and only rebuilds an empty one when
    // the branch is gone too.
    let cwd = recorded;
    let workspaceReset = false;
    let freshWorkspace = false;
    if (!existsSync(cwd)) {
      if (project) {
        const ws = await taskWorkspace(task, project.repoPath);
        cwd = ws.path;
        freshWorkspace = !!ws.fresh;
        baseFallback = ws.baseFallback;
        // Only a resumed session carries stale memory worth correcting; a fresh
        // session starts empty-handed and needs no warning.
        workspaceReset = freshWorkspace && resuming;
      } else if (!cwd) {
        cwd = ".";
      }
    } else if (project) {
      // 目录还在 = 这一轮不重新解析工作目录，可登记的**验收目标**照样可能已经没了
      //（验收合并后目标分支被删，worktree 却留着）。不查的话这一轮跑得好好的，用户
      // 到 diff / 验收那头才撞墙 —— 那正是上一轮修的「起得来但交不掉」。
      baseFallback = await refreshTaskBase(task, project.repoPath);
    }

    await setStatus(taskId, "running");
    // 已验收的任务收到真人消息 = 旧验收不再覆盖新增改动,stage 清回「进行中」。摘牌
    // 刻意排在**所有可能抛错的解析之后**(执行器解析、工作目录解析都会抛):解析失败时
    // 什么都还没破坏,catch 恢复 status 就是完整恢复(审查实测:claude+haiku+high 在
    // 执行器解析处抛错,stage 与合并快照被清了回不来)。
    // 三步是 write-ahead:①只读探快照(peek)→ ②快照随基线**先落盘**→ ③才执行清空
    // (commit)。中间任何一处崩溃,磁盘上都有完整快照供结算挂回;先清后存的老顺序,
    // 崩在中间快照就永久丢了。纯询问的挂回同样吃这份基线(turn-baseline.ts)。
    // 只认真人消息(!opts.system),旁路回合(sideTurn:就地验证/审查轮)也不摘——
    // 那些回合的约定就是「维持原状」,摘了牌又不落基线,挂回机制够不着。
    const reopened = opts.system || sideTurn ? null : await peekAcceptedStage(taskId);
    // 起跑前给工作目录拍一张照，**并当场把上一版的验证/验收记录清掉**：新指令一到，
    // 上一版的成绩就作废，线退回「让 AI 干活」那一站（不然这几十分钟里线路图还写着
    // 「已过关口、停在验证站」，那两颗会真合并的按钮此刻就能点）。结算时再拍一张比对，
    // 这一轮要是一个字节都没改，刚才清掉的原样放回 —— 纯询问不该重置任何东西。
    // 只给真人消息拍 —— 系统续跑、队列推进、验证打回后叫 agent 修，那些轮次改代码是
    // 本分，清账反而打断正在跑的流程。详见 turn-baseline.ts。
    if (!opts.system && !sideTurn) {
      const recorded = await recordTurnBaseline(taskId, cwd, freshWorkspace, reopened);
      // 基线内的清账已把 stage 摘下并广播；这里收掉同生命周期的合并快照列——且**只在
      // 基线确实落盘后**才清（失败关闭：快照没持久化就不动验收事实）。
      if (reopened && recorded) await clearAcceptedSnapshot(taskId);
    }
    // 「有产出却没交卷」的探针跟上面那张照片是两回事:它只管通知怎么措辞,所以**每一轮都记**
    // (系统续跑、队列推进的回合同样会漏交卷)。详见 turn-output.ts。
    await recordTurnStart(taskId, cwd);
    const invited = !prev; // first time this agent is pulled into the task
    const userTurnText = userText + attachmentsPrompt(opts.attachments);
    const promptedUserTurnText = withSkillInvocation({ agentType: agent, cwd, text: userTurnText });
    const sharedTeamWorker = !task.useWorktree && (await workerPreambleFor(task)).length > 0;
    // 验证回合（旧的独立审查任务，或这个任务自己身上的就地验证轮）：完成协议的
    // 验收那一句要换掉 —— 这一轮的产出是结论和证据，不是「这个任务可以合并了」。
    const reviewTask = !!task.reviewOf;
    const verifying = reviewTask || !!task.verifyRound || freeReviewTurn;
    const freeWorkflow = task.workflowMode === "free";
    // 每回合都重贴一遍「你现在在干什么」：验证轮可能中途提问、被打断再续跑，
    // 那些回合都不带最初那段协议，只有从任务状态派生的提醒能跟到底。
    const reviewReminder = reviewTask
      ? reviewReminderFor(task)
      : task.verifyRound
        ? verifyReminderFor(task.id, task.verifyRound)
        : freeReviewTurn
          ? await freeReviewReminder(task.id)
          : "";
    // 「本任务里还有别人」的告知。触发条件是**有新面孔**（上一轮跑完之后才进来的
    // 同伴），不是 invited —— 挂在 invited 上恰好漏掉最需要它的那个：任务的原生
    // agent 第一轮走 runTask 直接起跑、从没被「召唤」过，于是后来 @ 进来的同伴它
    // 一次都不会知道（正是 2026-08-04 那个「claude 自己考古 codex 会话」的现场）。
    // prev 必须是**更新 session 行之前**的快照：锚点取的 endedAt 会在 resume 时被清空。
    const peerNotice = peerNoticeFor({ taskId, self: agent, all, prev });
    // 验证轮/审查任务不提这条线：那一轮的产出是结论，不是新一版代码。
    const railNote = followUpFrom && !verifying ? await followUpRailNote(taskId) : "";
    // 原生命令必须**独占整条 prompt**:前面垫一个字它就退化成普通模型请求,压缩不会
    // 发生;后面跟的字则会被 CLI 整条丢弃,拼上去只是自欺(见 skills.ts NATIVE_COMMANDS)。
    // 浏览器策略那段同理 —— 它也是拼在正文外面的字。
    const prompt = nativeCommand
      ? promptedUserTurnText
      : withGlobalBrowserPolicy(
          (invited ? COLLAB_INVITE : "") +
          invitedTaskBrief(task.body, invited, verifying) +
          peerNotice +
          promptedUserTurnText +
          (workspaceReset ? WORKSPACE_RESET(cwd) : "") +
          (followUpFrom
            ? FOLLOW_UP_REMINDER(taskId, followUpFrom, sharedTeamWorker, verifying, railNote, freeWorkflow)
            : COMPLETION_REMINDER(taskId, sharedTeamWorker, verifying, freeWorkflow)) +
          (reviewReminder ? `\n${reviewReminder}` : ""),
          resuming ? "reminder" : "full",
        );
    // 起跑前的最后一道闸（说明见 turn-freeze.ts）：这一句之后到 `trackRun` 之间不再有
    // await，暂停请求要么在这里被消费、要么之后才到——那时已有 handle 可杀。
    // freezeGuard 的启动路径（重试按钮、自由审查重跑）还会再查一遍库：它们的预检查离
    // spawn 隔着好几个 await，且中途会经过一次「先释放锁、排队再起」的交接。
    await abortIfFrozen(taskId, { checkFacts: !!opts.freezeGuard, restorable: !!followUpFrom });
    const turnStart = now();
    const sessId = resuming ? prev!.id : id();
    const runDir = join(RUNS_DIR, taskId);
    mkdirSync(runDir, { recursive: true });
    // 续聊/重试/队列推进/唤醒这一路也要解绑 —— 漏掉它等于只保护「全新起跑」的
    // 回合，而任务被 resume 的次数远多于第一次起跑（实测:重启时在跑的任务里
    // 一半是 resume 回合，全都还挂在匿名管道上）。
    const detach = detachedPathsFor(runDir, sessId, turnStart);
    const run = ex.runSteerable?.bind(ex) ?? ex.run.bind(ex);
    handle = run({
      prompt,
      cwd,
      sessionId: resuming ? prev!.cliSessionId! : undefined,
      trace: runTracePaths(runDir, sessId, turnStart),
      detach,
      env: { ASH_TASK_ID: taskId, ASH_TURN_TOKEN: turnToken },
    });
    trackRun(taskId, handle);

    // Reuse the agent's session row when resuming; otherwise open a fresh line,
    // inheriting the task's worktree/branch from its first session.
    let cliSessionId = resuming ? prev!.cliSessionId! : handle.sessionId;
    if (resuming) {
      // New turn on the same session row: mark it live (clear the prior turn's
      // end) and stamp this turn's start, so execution-time accounting and the
      // live 用时 both track the turn actually running now. commandLine must also
      // reflect this invocation because task-level model/effort can change between turns.
      await db
        .update(sessions)
        .set({
          turnStartedAt: turnStart,
          endedAt: null,
          exitStatus: null,
          commandLine: handle.commandLine,
          executor: ex.label,
          // 回合保真四件套整组刷新（说明见 db/schema.ts）：profile / 环境指纹 / 模型 /
          // 思考强度都可能在两轮之间被改，留着上一轮的值就会让重试按着别人的配置跑。
          executorId: profileId,
          executorFingerprint: profileFingerprint,
          turnModel: ex.model ?? null,
          turnReasoningEffort: ex.reasoningEffort ?? null,
          sideTurn,
          // 新回合开始 = 上一轮「是被停的」这件事翻篇，不清就会一直挡着重试入口。
          stoppedAs: null,
          // 恢复命令三件套整组刷新(cwd 也可能在两轮之间变):少刷一列就是一条
          // 恢复不了的恢复命令,见 ResumeFields。
          ...ex.resumeFields(cwd, cliSessionId),
          // 这一轮的解绑线索。**必须整组刷新**:沿用上一轮的 pid/offset 会让重启
          // 去接一个早就没了的进程,或者从上一轮的字节位置读这一轮的新文件。
          agentPid: handle.detached?.pid ?? null,
          agentStartedAt: handle.detached ? inspectProcess(handle.detached.pid)?.startedAt ?? null : null,
          agentOutPath: handle.detached ? detach.out : null,
          agentErrPath: handle.detached ? detach.err : null,
          agentRcPath: handle.detached ? detach.rc : null,
          agentOffset: 0,
        })
        .where(eq(sessions.id, sessId));
    } else {
      const base = all[0];
      await db.insert(sessions).values({
        id: sessId,
        taskId,
        role: sessionRole,
        agentType: agent,
        executor: ex.label,
        executorId: profileId,
        executorFingerprint: profileFingerprint,
        turnModel: ex.model ?? null,
        turnReasoningEffort: ex.reasoningEffort ?? null,
        sideTurn,
        worktreePath: base?.worktreePath ?? null,
        branch: base?.branch ?? null,
        cwd,
        cliSessionId,
        ...ex.resumeFields(cwd, cliSessionId),
        commandLine: handle.commandLine,
        startedAt: turnStart,
        turnStartedAt: turnStart,
        activeMs: 0,
        exitStatus: null,
        agentPid: handle.detached?.pid ?? null,
        agentStartedAt: handle.detached ? inspectProcess(handle.detached.pid)?.startedAt ?? null : null,
        agentOutPath: handle.detached ? detach.out : null,
        agentErrPath: handle.detached ? detach.err : null,
        agentRcPath: handle.detached ? detach.rc : null,
        agentOffset: 0,
      });
    }

    const out = createWriteStream(join(runDir, `${sessId}.md`), { flags: "a" });
    bindNativeSteer(taskId, handle, {
      agentType: agent,
      record: (text, at) => recordUserConversationTurn({
        taskId, sessionId: sessId, role: sessionRole, agentType: agent, out, text, at,
      }),
    });
    if (opts.system) {
      // Backend-initiated 继续: a 〔系统〕 trace (its own bubble), NOT a 你→ reply.
      // Persist as a structured turn (reload) and emit a matching system event (live).
      writeTurn(out, { t: "system", agent, text: SYS_MARKER }, turnStart);
      bus.publish({ type: "agent.event", taskId, sessionId: sessId, role: sessionRole, agentType: agent, event: { kind: "system", text: SYS_MARKER, at: turnStart } });
    } else {
      // 你→@agent reply, persisted as a structured turn so a reloaded thread shows
      // the human/backend turn as its own bubble; the matching event keeps every client live.
      recordUserConversationTurn({ taskId, sessionId: sessId, role: sessionRole, agentType: agent, out, text: userTurnText, at: turnStart, bySystem: opts.byBackend });
    }
    // 到这里这句话已经**两处落地**:agent 进程早在上面就带着它起来了,原文也刚写进会话
    // 落盘文件。排队/定时消息就是在这一刻、而不是更早,才把库里那条标成 sent。
    // 回调自己出错不许影响这一轮(它只是记账)。
    if (opts.onDelivered) {
      try { await opts.onDelivered(); } catch { /* 记账失败不拖累这一轮 */ }
    }
    if (workspaceReset) {
      // 让用户也看见:agent 这一轮是在一个空目录上重新开始的。只发 toast 不算数,
      // 刷新后仍要能看出来(见 AGENTS.md 关于持久可见状态的约定)。
      writeTurn(out, { t: "system", agent, text: WORKSPACE_RESET_MARKER }, turnStart);
      bus.publish({ type: "agent.event", taskId, sessionId: sessId, role: sessionRole, agentType: agent, event: { kind: "system", text: WORKSPACE_RESET_MARKER, at: turnStart } });
    }
    if (sessionUpgradeNote) {
      writeTurn(out, { t: "system", agent, text: sessionUpgradeNote }, turnStart);
      bus.publish({ type: "agent.event", taskId, sessionId: sessId, role: sessionRole, agentType: agent, event: { kind: "system", text: sessionUpgradeNote, at: turnStart } });
    }
    const baseNote = baseFallbackNote(baseFallback);
    if (baseNote) {
      // 同上,这一条说的是「基线去哪了」:任务登记的 base 已经没了(验收合并后分支被删是
      // 最常见的一种)。工作目录是不是跟着新建了、是从谁起的、登记值有没有一并改掉,措辞
      // 里三件分开说 —— 紧挨着上面那条 WORKSPACE_RESET_MARKER,含糊一点两条就会互相打架。
      writeTurn(out, { t: "system", agent, text: baseNote }, turnStart);
      bus.publish({ type: "agent.event", taskId, sessionId: sessId, role: sessionRole, agentType: agent, event: { kind: "system", text: baseNote, at: turnStart } });
      baseFallbackTold = true;
    }

    // 跟 fresh run 共用同一份消费+结算(autoTitle=false:标题在第一轮就定了)。
    // 原来这里是一份几乎一样的内联拷贝,两份会漂 —— 而且那份没有 offset 持久化,
    // 于是 resume 回合被重启接管时会从字节 0 重放整轮输出。
    await consumeSingleRun({
      taskId, sessId, agentType: agent, ex, cwd,
      handle, out, turnStart, cliSessionId, autoTitle: false, role: sessionRole,
    });
  } catch (err) {
    // 与 consumeSingleRun 的正常收流分支对称：有些 CLI 被 kill 后会让 parser 直接抛。
    // 「引导会话」已经在 releaseTurn 后登记了同会话续送，这里不能再把旧回合结算成 failed。
    const steered = await takeSteered(taskId);
    const stopped = takeStopped(taskId);
    if (steered && !stopped) return true;
    const message = String(err instanceof Error ? err.message : err);
    // 基线的事先说：它在这一轮更早的时候就**已经落库**了（解析工作目录那一刻），说在
    // 失败交代之前才对得上发生顺序；没说过才补。
    if (!baseFallbackTold) {
      await announceBaseFallback(taskId, baseFallback, {
        sessionId: opts.resumeSessionId, agentType, role: sessionRole,
      });
    }
    // handle 还没赋值 = 连 spawn 都没到，这句话一个字都没送出去（判据与措辞见
    // turn-failure.ts）；这条交代要落到被 @ 的那位、或指名续的那条会话上。
    await reportTurnFailure({
      taskId, message, role: sessionRole, agentType,
      undelivered: handle || opts.system ? undefined : userText + attachmentsPrompt(opts.attachments),
      target: { sessionId: opts.resumeSessionId, agentType, role: sessionRole },
    });
    // 这一轮已拍过基线的话(资源都解析成功、spawn 才挂),先按基线对账:失败回合的工作
    // 目录多半一个字节没动,开头摘掉的验收事实(stage + 合并快照 + 尾段进度)会整套挂回。
    // 不对账的话,下一轮的 recordTurnBaseline 会直接覆盖这份基线,快照永久丢失(审查
    // 实测:解析失败后 stage/快照回不来)。必须在 afterSettlement 之前(turn-baseline.ts
    // 的约定);正常路径的结算已经对过账时,基线文件已被消费,这里是 no-op。
    await reconcileTurnBaseline(taskId, false).catch(() => undefined);
    // 续聊回合里出的岔子(典型:worktree 建不出来)不该把任务状态打差 —— 同
    // settleTaskStatus 的约定:续聊只能让任务变好,不能让它变坏。
    const row = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
    const back = row?.followUpFrom as TaskStatus | null | undefined;
    // 原生命令标记跟 followUpFrom 一样**只在本回合内有效**:CLI 还没起来就抛错时,
    // 正常那条清理路(settleTaskStatus)根本没跑过 —— 不在这儿清掉,标记就漏给下一轮,
    // 下一轮的真实结算会被整段跳过(当成「那是次压缩」)。
    const nativeTurn = !!row?.nativeTurn;
    if (back || nativeTurn) {
      await db
        .update(tasks)
        .set({ ...(back ? { followUpFrom: null } : {}), ...(nativeTurn ? { nativeTurn: false } : {}), updatedAt: now() })
        .where(eq(tasks.id, taskId));
    }
    const status = stopped ?? back ?? "failed";
    await setStatus(taskId, status);
    // 压缩连启动都没启动,更谈不上有结论 —— 跟正常结算同一口径(single-run.ts):整段
    // 跳过结算钩子。交给它的话,正在跑的那轮就地验证会被当成「验完了」收掉(清 verifyRound、
    // 涨 verifyRounds,却给不出 verified/verify_failed),白耗用户一轮验证配额。
    if (!nativeTurn) await afterSettlement(taskId, status, false, false, sessionRole);
  } finally {
    if (handle) untrackRun(taskId, handle);
    releaseTurn(taskId);
  }
  // 走到这里 = 这一回合确实由本次调用接管了(跑成还是跑挂都算,错误已经在 catch 里
  // 落到时间线/状态上)。只有「被单飞锁挡回」才返回 false,那才是「一个字没送出去」。
  return true;
}
