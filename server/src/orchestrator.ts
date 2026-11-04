import { mkdirSync, createWriteStream } from "node:fs";
import { loadMarkdownImageSeed, markdownImageAccounting } from "./agent-image-journal.js";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type { AgentType, SessionRole, TaskStatus } from "@ash/shared";
import { isGoalRecovery } from "@ash/shared/cli-commands";
import { deliverLeadInterjection } from "./team/lead-interjection.js";
import { db } from "./db/index.js";
import { tasks, projects, sessions } from "./db/schema.js";
import { bus } from "./bus.js";
import { id, now, attachmentsPrompt } from "./util.js";
import { closeTaskTurns, freshTurnFields, nextTurnStart, openTurn, primeTurnStarts, resumedTurnFields } from "./session-turns.js";
import type { ContinueTaskOptions, TurnStartDecline } from "./task-continue-options.js";
import { setTaskStatus } from "./status.js";
import { trackRun, discardStartingRun, takeSteered, takeStopped, bindTurnToken, reclaimTurn, releaseTurn, turnSourceReview, turnSourceRole } from "./runs.js";
import { turnDirectionStart } from "./task-direction-epoch.js";
import { assertReviewTurnStart, beginReviewContinuation, commitReviewTurnDelivery } from "./review-continuation.js";
import { restoreUndeliveredReviewStart } from "./review-start-retry.js";
import { recordReviewStartNotLaunched } from "./guarded-turn-start.js";
import { ReviewSuperseded } from "./review-ownership.js";
import { withdrawReviewStart, type ReviewStartReceipt } from "./review-start-withdrawal.js";
import { retireHistoricalReview } from "./review-retirement.js";
import { consumeSingleRun } from "./single-run.js";
import { pickTurnSession } from "./turn-session-pick.js";
import { pickTurnWorkspace } from "./turn-workspace-pick.js";
import type { Workspace } from "./git.js";
import { resolveExecutorWithProfile } from "./executors/index.js";
import { dispatchRejection, executorOwnerScope, noteExecutorDowngrade } from "./auth/dispatch-gate.js";
import type { RunHandle } from "./executors/types.js";
import { detachedPathsFor } from "./executors/detached.js";
import { inspectProcess } from "./proc.js";
import { RUNS_DIR } from "./paths.js";
import { DeliveryCrossingUnwritable, recordDeliveryCrossing } from "./delivery-crossing.js";
import { createTurnInputSettlement } from "./turn-input-settlement.js";
import { writeTurn, runTracePaths } from "./transcript.js";
import { isMonitorWakeTurn, recordUserConversationTurn } from "./conversation-turn.js";
import { workerPreambleFor } from "./team/dispatch.js";
import { clearAcceptedSnapshot, peekAcceptedStage } from "./task-stage.js";
import { reviewReminderFor, verifyReminderFor } from "./review-prompts.js";
import { peerNoticeFor } from "./peer-context.js";
import { reseedHistory } from "./history-reseed.js";
import { clearHandoffNotice, handoffNoticeFrom } from "./handoff-notice.js";
import { recordTurnBaseline } from "./turn-baseline.js";
import { recordTurnStart } from "./turn-output.js";
import { hintAshMcpForTurn } from "./ash-mcp-turn-hint.js";
import { abortFrozen, freezeFacts, takeFreeze, FrozenTurn } from "./turn-freeze.js";
import { recoverFailedTurnStart } from "./turn-start-failure.js";
import { freeReviewReminder } from "./free-workflow.js";
import { NO_REMINDER, assembleTurnPrompt } from "./turn-prompt.js";
import { withSkillInvocation } from "./skills.js";
import { prepareCliInvocation, readCliState } from "./task-cli-state.js";
import { prepareContinuationEntry } from "./task-continuation-entry.js";
import { taskStartStatus } from "./task-start-status.js";
import { invitedTaskBrief } from "./invited-task-brief.js";
import { enterTurn, withTurnPreflight } from "./turn-entry-guard.js";
import { cliConfigDirColumn, runEnvForOwner } from "./auth/run-env.js";
import { turnIdentityEnv } from "./turn-identity.js";
import { takeResumePrompt } from "./task-resume-prompt.js";
// 每一轮 prompt 上下拼的固定措辞(前言、完成协议、续聊尾巴、工作目录重建告警)。
import {
  COLLAB_INVITE, SYS_MARKER,
  backgroundWaitFor, COMPLETION_REMINDER, DIRECTION_PROTOCOL, FOLLOW_UP_REMINDER, followUpRailNote, PLANNING_TURN,
  WORKSPACE_RESET, WORKSPACE_RESET_MARKER,
} from "./run-prompts.js";
// 「登记的基线被换掉了」这句话：说不说、怎么说、失败那条路怎么补，全在这一份里。
import { baseFallbackNote } from "./base-fallback-notice.js";

// 这一回合的**调用契约**(连 ResumeReason 一起)住在 task-continue-options.ts；这里原样
// 再导出，调用方（task-resume、runs 那几处）不用跟着改导入路径。
export type { ContinueTaskOptions, ResumeReason, TurnStartDecline } from "./task-continue-options.js";


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
  opts: ContinueTaskOptions = {},
): Promise<boolean> {
  // 这条消息是不是 CLI 原生命令(`/compact`):整条归 CLI 本地执行,不进模型 —— 它既不是
  // 任务的执行,也不是「新指令」。这一轮必须当旁路回合(下面的 sideTurn),否则「压一下
  // 上下文」既会被打成 failed,也会顺手把已验收的牌子摘掉——旁路回合不拍工作目录快照,
  // 没有任何基线能把摘掉的牌子挂回去,压一次就永久丢掉一次验收。
  /**
   * **这一轮没起跑的原因,只报一次** —— 返回 false 的每一条出路都要配一个(契约与四个档位
   * 见 `TurnStartDecline`)。压成一个光秃秃的 false 的代价在第 1 轮审查问题 2 实测过:锁被
   * 别的执行合法接走(瞬时、确证一个字节都没动)和用户撤回在调用方眼里一样,于是一次瞬时
   * 争用就让整轮审查落了终态。
   *
   * 只报一次是因为 `enterTurn` 那边也会报它自己那一档:两边共用这一个闸门,不会报两声。
   */
  let declined = false;
  const decline = (reason: TurnStartDecline): false => {
    if (!declined) {
      declined = true;
      try { opts.onDecline?.(reason); } catch (error) { console.error(`[ash] 起跑未成的原因上报失败 task=${taskId}:`, error); }
    }
    return false;
  };
  const { head, nativeCommand, slash, goalExecution, options, retired } = await withTurnPreflight(taskId, opts.turnHeld, async () => {
    const prepared = await prepareContinuationEntry(taskId, userText, opts);
    // **原生命令不退休任何审查轮**。退休要拦的是「新方向来了,旧轮次不许回来把它改回去」
    // (review-retirement.ts 顶部),而原生命令整条归 CLI 本地执行、不进模型,既不是执行也
    // 不是新指令(上面那段注释)——它一个字都不改工作区,没有任何东西需要被它作废。
    //
    // 少这一道的代价是双份的:在飞的就地验证轮被它收口(verifyRound 清掉、凭空记一轮验证
    // 账),而且 `continueTask` 会返回 false 说「这一轮没被接管」,于是调用方把原话当成没送
    // 出去——可它明明已经送进 CLI 跑过了。test-native-command-turn 两头都钉着。
    const retired = !prepared.nativeCommand && prepared.head?.mode === "single"
      && await retireHistoricalReview(prepared.head,
        prepared.options.turnSource, prepared.options.reviewDelivery, prepared.options.turnHeld);
    return { ...prepared, retired };
  });
  opts = options;
  // 历史审查退役:这一笔的目标早就不是「现在那一次」了,确证没送出去,但重排毫无意义。
  if (retired) return decline("backoff");
  // 团队任务(§Team):插话直接写进常驻调度台的 stdin —— 整条在 team/lead-interjection.ts。
  // 团队插话没送达同样是退避(调度台不在线/正忙),不是锁被抢走。
  if (head?.mode === "team") {
    return await deliverLeadInterjection(taskId, userText, opts) || decline("backoff");
  }
  // 起跑前的那串闸（接力存档 / 回合占位 / 验收互斥 / 唤醒资格）收在一处，见
  // turn-entry-guard.ts 的文件头：它们共享的不变量是「从占住位到交给下面那个大 try
  // 之间，每一条出路都得自己把位还回去」，散着写时新加一道闸就会漏掉这件事。
  const sessionRole = turnSourceRole(opts.turnSource) as Extract<SessionRole, "single" | "reviewer">;
  // 交回来的是**这一把锁的身份**:这一整轮里凡是要还锁、要转正的地方都拿它核(本轮审查
  // F1 —— 按任务 id 还锁会撤掉人工放开之后那一轮的互斥,见 turn-lock.ts `endOwnTurn`)。
  const turn = await enterTurn({
    taskId,
    handoff: head?.handoff,
    turnHeld: opts.turnHeld,
    wakeGuard: opts.wakeGuard,
    pendingMessageIds: opts.pendingMessageIds,
    source: opts.turnSource ?? { role: "single" },
    // 那一侧每条拒绝出路都由类型强制带原因(turn-entry-guard.ts 的 `decideTurnEntry`),
    // 其中 `turn-taken` 是唯一的瞬时档 —— 原样转出去,别在这里压成一个 false。
    onDecline: decline,
  });
  if (!turn) return false;
  // catch 那边署名用的就是它：出错时 task 可能压根没读出来，所以按 head 的快照兜底，
  // 而不是硬写 "claude"（该任务是 codex 时，错误会挂到一个从没参与过的智能体名下）。
  const agentType = opts.agent ?? (head?.agentType as AgentType) ?? "claude";
  let handle: RunHandle | undefined;
  const priorStatus = head ? taskStartStatus(head) : null;
  let goalStartFrom: TaskStatus | null = goalExecution && priorStatus && !["running", "queued"].includes(priorStatus) ? priorStatus : null;
  // 同 runTask：基线降级在解析工作目录那一刻就落了库，说明却写在 spawn 之后，所以这两件
  // 事挂在 try 外面，失败那条路才补得上（见 base-fallback-notice.ts）。
  let baseFallback: Workspace["baseFallback"];
  let baseFallbackTold = false;
  // FrozenTurn(spawn 前被冻结闸撤回)= 输入没送出去,函数尾据此返回 false。
  let frozenBeforeSpawn = false;
  /** 那条 false 该报成哪一种(见 `TurnStartDecline`);默认是用户撤回,写库故障另算。 */
  let frozenReason: TurnStartDecline = "withdrawn";
  let reviewStart: ReviewStartReceipt | undefined;
  let checkingReviewStart = false;
  const inputSettlement = createTurnInputSettlement(taskId, opts, () => reviewStart);
  try {
    const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
    if (!task) throw new Error("task not found");
    // 这个任务上挂着一次**说不清有没有投喂**的交付(服务死在交付期,原输入按「不会自动重发」
    // 保留着)。本次确证没送出去,但调用方不能据此声称「一个字都没送出去」—— 那句话会被读成
    // 对那次悬着的交付的判词。
    if (task.waitOwnership?.start?.phase === "uncertain") return decline("uncertain");
    if (task.mode !== "single") throw new Error("reply is for single tasks");
    const startStatus = taskStartStatus(task);
    goalStartFrom = goalExecution && !["running", "queued"].includes(startStatus) ? startStatus : null;

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
    let sideTurn = !!opts.sideTurn || !!task.verifyRound || freeReviewTurn || !!nativeCommand;
    // DB 里的 verifyRound/nativeTurn 会在结算中途先清，handle/turn 要到 finally 才释放。
    // 把旁路身份也钉进运行时 turn role，关闭那段“标记已清、进程仍可被引导”的小窗口。
    if (sideTurn && sessionRole === "single") reclaimTurn(taskId, turn, nativeCommand ? "native" : "side");
    // 「这一回合是任务的执行」:system(后端代写的续跑)或 executionTurn(让位交接
    // 把用户回复当启动输入)。只影响续聊判定,输入来源各自另算(见 opts.executionTurn)。
    const execution = !!opts.system || !!opts.executionTurn || isGoalRecovery(slash);
    const checkpointFollowUp = !execution && !opts.byBackend
      && task.status === "paused" && !!task.resumePrompt;
    const goalPriorStatus = startStatus;
    const followUpFrom = goalExecution
      ? !isGoalRecovery(slash) && !opts.system && ["done", "failed", "canceled"].includes(goalPriorStatus) ? goalPriorStatus : null
      : sideTurn
        ? (task.status === "running" || task.status === "queued" ? null : task.status)
        : !execution && (["done", "failed", "canceled"].includes(task.status) || checkpointFollowUp)
          ? task.status
          : null;
    // 新回合起点:顺手清掉上一轮残留的完成确认(确认只在本回合内有效)。
    // nativeTurn 落库而不是只留在内存里:结算钩子跟这里可能不在同一个进程(重启后由
    // reattach 接着消费同一条流),内存标记会丢,而丢了就等于「压缩被算成一轮验证跑完」。
    const turnToken = id();
    const directionToken = id();
    reviewStart = await db.transaction(async (transaction) => {
      const reviewStart = await beginReviewContinuation(transaction, task, opts.turnSource ?? { role: "single" }, turnToken, directionToken, opts.reviewDelivery);
      await transaction.update(tasks)
        // 方向身份那几列同 task-run.ts:走 `turnDirectionStart`,世代跟着这一次起跑一起前进。
        .set({ followUpFrom, nativeTurn: !!nativeCommand, goalTurn: goalExecution, completeConfirmedAt: null, ...turnDirectionStart(turnToken, directionToken), updatedAt: now() })
        .where(eq(tasks.id, taskId));
      return reviewStart;
    }, { behavior: "immediate" });
    // 令牌落库的同一处把它绑到这一轮的运行时身份上:来源核验要的是「库里的令牌」和
    // 「内存里这一轮」是同一件事,而不是两份各自独立的读(见 runs.ts `bindTurnToken`)。
    bindTurnToken(taskId, turnToken);
    await (await import("./review-recurrence-gate.js")).carryRecurrenceBreaker(taskId, { ...opts, native: !!nativeCommand });

    // 续聊/重跑同样按**这一回合是谁点的**解析执行器(§八)。跨人时降级到本人的默认
    // 执行器,并把这次降级写进时间线 —— 换执行器可能换模型档位,产出会变,不能静默。
    // 后端发起的回合不带 actingUserId,退回任务归属人。
    const runOwner = opts.actingUserId ?? task.ownerUserId;
    const owner = await executorOwnerScope(runOwner);
    const dispatchBlocked = await dispatchRejection({
      agentType: agent,
      executorId: summoned ? opts.executorId ?? null : task.executorId,
      ...owner,
    });
    if (dispatchBlocked) throw new Error(dispatchBlocked);
    const { executor: ex, profileId, profileFingerprint, downgradedFrom } = await resolveExecutorWithProfile({
      executorId: summoned ? opts.executorId ?? null : task.executorId,
      type: agent,
      model: summoned ? opts.model ?? null : task.model,
      reasoningEffort: summoned ? opts.reasoningEffort ?? null : task.reasoningEffort,
      ...owner,
    });
    if (downgradedFrom) await noteExecutorDowngrade(taskId, downgradedFrom, ex.label);
    const preserveCliState = !!opts.sideTurn || !!task.verifyRound || freeReviewTurn;
    const resetPlan = !!opts.system && !preserveCliState;
    const planning = !resetPlan && !goalExecution && !sideTurn && readCliState(task.cliState, agent, profileId, runOwner).plan === true;
    if (planning) {
      sideTurn = true;
      if (sessionRole === "single") reclaimTurn(taskId, turn, "side");
      await db.update(tasks).set({ nativeTurn: true, followUpFrom: ["running", "queued"].includes(task.status) ? null : task.status }).where(eq(tasks.id, taskId));
    }
    const project = (await db.select().from(projects).where(eq(projects.id, task.projectId))).at(0);

    // 这一轮续哪一条会话行(同一位智能体可能有好几条;接不接得上还要看 CLI 配置目录与
    // codex 版本守卫)——判据与两处持久说明都在 turn-session-pick.ts。
    const { all, prev, resuming, reseed } = await pickTurnSession({
      taskId, task, agent, sessionRole, profileId, runOwner, slash,
      freshSession: opts.freshSession, resumeSessionId: opts.resumeSessionId,
    });
    // 删过消息(reseed):会话行照旧续,CLI 会话换新的、拿删除后的记录重建(history-reseed.ts)。
    const cliResume = resuming && !reseed;
    // Where the work lives: the agent's own cwd, else any session's cwd (so the
    // invitee sees prior output), else materialize the task workdir.
    const recorded = opts.cwd || prev?.cwd || prev?.worktreePath || all[0]?.cwd || all[0]?.worktreePath || "";
    // 目录没了怎么办、还在又要刷什么,都在 turn-workspace-pick.ts。
    const { cwd, workspaceReset, freshWorkspace, baseFallback: resolvedFallback } = await pickTurnWorkspace({
      task, project, recorded, resuming,
    });
    baseFallback = resolvedFallback;
    await setTaskStatus(taskId, "running");
    // 已验收的任务收到真人消息 = 旧验收不再覆盖新增改动,stage 清回「进行中」。摘牌
    // 刻意排在**所有可能抛错的解析之后**(执行器解析、工作目录解析都会抛):解析失败时
    // 什么都还没破坏,catch 恢复 status 就是完整恢复(审查实测:claude+haiku+high 在
    // 执行器解析处抛错,stage 与合并快照被清了回不来)。
    // 三步是 write-ahead:①只读探快照(peek)→ ②快照随基线**先落盘**→ ③才执行清空
    // (commit)。中间任何一处崩溃,磁盘上都有完整快照供结算挂回;先清后存的老顺序,
    // 崩在中间快照就永久丢了。纯询问的挂回同样吃这份基线(turn-baseline.ts)。
    // 只认真人消息(!opts.system),旁路回合(sideTurn:就地验证/审查轮)也不摘——
    // 那些回合的约定就是「维持原状」,摘了牌又不落基线,挂回机制够不着。
    const reopened = opts.system || sideTurn || reviewStart?.acceptedRepair ? null : await peekAcceptedStage(taskId);
    // 起跑前给工作目录拍一张照，**并当场把上一版的验证/验收记录清掉**：新指令一到，
    // 上一版的成绩就作废，线退回「让 AI 干活」那一站（不然这几十分钟里线路图还写着
    // 「已过关口、停在验证站」，那两颗会真合并的按钮此刻就能点）。结算时再拍一张比对，
    // 这一轮要是一个字节都没改，刚才清掉的原样放回 —— 纯询问不该重置任何东西。
    // 只给真人消息拍 —— 系统续跑、队列推进、验证打回后叫 agent 修，那些轮次改代码是
    // 本分，清账反而打断正在跑的流程。详见 turn-baseline.ts。
    if (!opts.system && !sideTurn && !reviewStart?.acceptedRepair) {
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
    const promptedUserTurnText = withSkillInvocation({ agentType: agent, cwd, text: userTurnText, userId: runOwner });
    const sharedTeamWorker = !task.useWorktree && (await workerPreambleFor(task)).length > 0;
    // 验证回合（旧的独立审查任务，或这个任务自己身上的就地验证轮）：完成协议的
    // 验收那一句要换掉 —— 这一轮的产出是结论和证据，不是「这个任务可以合并了」。
    const reviewTask = !!task.reviewOf;
    const verifying = reviewTask || !!task.verifyRound || freeReviewTurn;
    const freeWorkflow = task.workflowMode === "free";
    // 每回合都重贴一遍「你现在在干什么」：验证轮可能中途提问、被打断再续跑，
    // 那些回合都不带最初那段协议，只有从任务状态派生的提醒能跟到底。
    // 照常算（这三条提醒顺带刷新本轮的回归证据清单，少刷一次就是清单停在上一轮）；
    // 正文已经逐字讲过的那几段**静态契约**由 `assembleTurnPrompt` 摘掉，本轮的证据状态、
    // 清单入口和正文没覆盖到的读法一律留着。去重放在拼装那一层，不放在这里：放这里就成了
    // 每个投递点各判一次，漏判一次就是一条双份消息（或者少一条本轮才有的警告）。
    const reviewReminder = reviewTask
      ? await reviewReminderFor(task)
      : task.verifyRound
        ? await verifyReminderFor(task.id, task.verifyRound)
        : freeReviewTurn
          ? await freeReviewReminder(task.id)
          : NO_REMINDER;
    // 「本任务里还有别人」的告知。触发条件是**有新面孔**（上一轮跑完之后才进来的
    // 同伴），不是 invited —— 挂在 invited 上恰好漏掉最需要它的那个：任务的原生
    // agent 第一轮走 runTask 直接起跑、从没被「召唤」过，于是后来 @ 进来的同伴它
    // 一次都不会知道（正是 2026-08-04 那个「claude 自己考古 codex 会话」的现场）。
    // prev 必须是**更新 session 行之前**的快照：锚点取的 endedAt 会在 resume 时被清空。
    const peerNotice = peerNoticeFor({ taskId, self: agent, all, prev });
    // 「你被搬过机器了」——接力导入时挂在 handoff 标记上的一次性前言（不占 resume_prompt
    // 那一列，理由见 handoff-notice.ts）。只投给任务自己的正式回合：审查/验证/就地旁路
    // 回合吃掉它，任务本人就再也收不到了。
    const handoffNotice = sideTurn || verifying ? "" : handoffNoticeFrom(task.handoff);
    // 验证轮/审查任务不提这条线：那一轮的产出是结论，不是新一版代码。
    const railNote = followUpFrom && !verifying ? await followUpRailNote(taskId) : "";
    // 原生命令必须**独占整条 prompt**:前面垫一个字它就退化成普通模型请求,压缩不会
    // 发生;后面跟的字则会被 CLI 整条丢弃,拼上去只是自欺(见 skills.ts NATIVE_COMMANDS)。
    // 产出质量规则这一轮的事实(判据本体见 craft-rules.ts):`!resuming` 为真的那几种(首次被
    // @ 进来、旧会话接不上、/clear 之后新开)都是没有旧上下文的首条消息。原生命令那一支拿不到
    // 它 —— 它独占整条 prompt(见上)。
    const craft = { freshContext: !cliResume, verifying };
    const history = reseed ? await reseedHistory(taskId, prev!.id, task.body) : "";
    const prompt = nativeCommand
      ? promptedUserTurnText
      : planning ? PLANNING_TURN(craft, history + promptedUserTurnText)
      : assembleTurnPrompt({
        invite: invited ? COLLAB_INVITE : "",
        brief: invitedTaskBrief(task.body, invited, verifying),
        handoffNotice,
        peerNotice,
        craft,
        history,
        userText: promptedUserTurnText,
        workspaceReset: workspaceReset ? WORKSPACE_RESET(cwd) : "",
        completion: followUpFrom
          ? FOLLOW_UP_REMINDER(taskId, followUpFrom, sharedTeamWorker, verifying, railNote, freeWorkflow)
          : COMPLETION_REMINDER(taskId, sharedTeamWorker, verifying, freeWorkflow),
        backgroundWait: backgroundWaitFor(agent),
        direction: DIRECTION_PROTOCOL(directionToken),
        reviewReminder,
      });
    const runEnv = {
      ...(await runEnvForOwner(runOwner, agent)),
      ...turnIdentityEnv({ taskId, turnToken, directionToken }),
    };
    await ex.prepareResume?.({ cwd, sessionId: cliResume ? prev!.cliSessionId! : undefined, env: runEnv, steerable: !!ex.runSteerable });
    const cli = await prepareCliInvocation(task, agent, userText, profileId, runOwner ?? null, { resetPlan, preserveState: preserveCliState });
    // 复用同一行会话之前,先把库里这条会话用过的最晚起点接回分配水位。重启之后水位是空的,
    // 墙钟又恰好回拨到上一轮开工那一刻时,不接就会把那个历史身份原样重发一遍 —— 开始行被
    // 唯一键合进旧行、收尾看见已收口直接返回,这一轮在库里一个字都没有（第 1 轮审查 F2,
    // 机制见 session-turns.ts 的 primeTurnStarts）。
    if (resuming) await primeTurnStarts(prev!.id);
    // 续聊接回正文图片的身份种子(要读 trace,异步):子智能体的文档跨回合累加,不接上,
    // 重开后的第一处引用又从 0 号发起,跟刷新重建那一路撞身份(agent-image-journal.ts)。
    const imageSeed = resuming ? await loadMarkdownImageSeed(taskId, prev!.id) : undefined;
    // 这道闸到 spawn 之间还隔着查冻结事实那一个 await:这期间审查被顶掉的那一种照样起跑,由
    // spawn 之后的 `commitReviewTurnDelivery` 接着拦。
    checkingReviewStart = true;
    // 这道闸要问的是「**我属于的那一轮审查**还是当下这一轮吗」,所以只对**绑定了审查**的回合
    // 开:收据在手,或者任务自己挂着就地验证轮 / 是审查任务,或者回合身份里写明了是哪一次审查。
    // 显式写 `"unbound"` 的 reviewer 回合(duet 研讨、辩论、审查者哨兵唤醒)不在其列——它那句
    // 话的意思正是「这一轮不代表任何审查」(turn-lock.ts 的 TurnSource),而这道闸在缺少身份时
    // 退回去查「现在活跃的是哪一轮」,那恰是 pending-verdict.ts 明令禁止的补绑。
    // 少这一条的代价实测:一个 unbound 的 reviewer 旁路回合会被判成「原目标方向已失效」而抛,
    // 而那条 catch 分支只撤回收据——没有收据就什么都不做,任务从此**卡在 running**、回合锁却
    // 已经放掉,连 PATCH status 都会被 409 挡回(test-cli-plan-scheduling 钉的就是这一条)。
    const boundReviewTurn = !!turnSourceReview(opts.turnSource);
    await assertReviewTurnStart(taskId, turnToken, directionToken, opts.reviewDelivery,
      !!reviewStart || (!nativeCommand && (!!task.verifyRound || boundReviewTurn || !!task.reviewOf)));
    checkingReviewStart = false;
    // 顺序定死:查冻结事实(最后一个 await)→ 同步定论 → spawn。为什么只能这么排、以及
    // freezeGuard 为什么只在那几条路上查库,见 task-run.ts 同一段与 turn-freeze.ts。
    const frozen = await freezeFacts(taskId, !!opts.freezeGuard);
    // ↓ 这里往下到 `trackRun` 全同步(撤回那条岔路除外,它不起进程):暂停请求要么在
    // takeFreeze 被消费、要么之后才到 —— 那时已有 handle 可杀。
    const freeze = takeFreeze(taskId, frozen);
    if (freeze) await abortFrozen(taskId, freeze, { restorable: !!followUpFrom });
    const sessId = resuming ? prev!.id : id();
    // 起点从身份层分配（同 task-run）。续聊复用同一行会话,所以这一轮的起点必须严格晚于那条
    // 会话上已经见过的全部起点 —— 撞上就会被当成同一个回合身份,既不插行也不加数。
    const turnStart = nextTurnStart(sessId);
    const runDir = join(RUNS_DIR, taskId);
    mkdirSync(runDir, { recursive: true });
    // 续聊/重试/队列推进/唤醒这一路也要解绑 —— 漏掉它等于只保护「全新起跑」的
    // 回合，而任务被 resume 的次数远多于第一次起跑（实测:重启时在跑的任务里
    // 一半是 resume 回合，全都还挂在匿名管道上）。
    const detach = detachedPathsFor(runDir, sessId, turnStart);
    const run = ex.runSteerable?.bind(ex) ?? ex.run.bind(ex);
    // **交出 prompt 之前**把「这几条输入即将越线」同步落到磁盘:下面这一句 run(...) 才是不可逆
    // 的那一刻,它之后的 persistRunner / onDelivered 都只是记账。两档策略(凭据档写不成当场抛,
    // 走下面 catch 的「一个字都没送出去」那一支)与跨进程实测都在 delivery-crossing.ts 的文件头。
    if (opts.pendingMessageIds?.length) {
      recordDeliveryCrossing(taskId, opts.pendingMessageIds, { sessionId: sessId, turnStart }, opts.crossingRequired);
    }
    handle = run({
      prompt,
      ...cli,
      cwd,
      sessionId: cliResume || slash?.name === "fork" ? prev?.cliSessionId ?? undefined : undefined,
      trace: runTracePaths(runDir, sessId, turnStart),
      // 正文图片的持久账本:交代关系不再跟这条 for-await 消费者同生共死(agent-image-journal.ts)。
      images: markdownImageAccounting(taskId, sessId, turnStart, imageSeed),
      detach,
      // 多人模式:个人 CLI 配置目录 + git 署名(auth/run-env.ts)。自用模式恒为空对象。
      env: runEnv,
    });
    trackRun(taskId, handle);
    // 回执责任**此刻**就交出去,不等下面那一串可失败的本地记账(第 2 轮自由审查 F1,见
    // turn-input-settlement.ts 文件头)。
    inputSettlement.handOver(handle);
    // 前言已经随 prompt 交到 agent 手上，这一刻起就该划掉（放在 spawn 之后：起跑前
    // 还有 takeFreeze 那道闸，清早了被冻住的那一轮就把它白白吃掉了）。

    // Reuse the agent's session row when resuming; otherwise open a fresh line,
    // inheriting the task's worktree/branch from its first session.
    let cliSessionId = cliResume ? prev!.cliSessionId! : handle.sessionId;
    const runningHandle = handle;
    const persistRunner = async (store: Pick<typeof db, "insert" | "update">) => {
      if (resuming) {
        // New turn on the same session row: mark it live (clear the prior turn's
        // end) and stamp this turn's start, so execution-time accounting and the
        // live 用时 both track the turn actually running now. commandLine must also
        // reflect this invocation because task-level model/effort can change between turns.
        await store
          .update(sessions)
          .set({
            // 回合三件套（起点 / 计数 / 清掉上一轮的收尾）一起来自 helper——见
            // session-turns.ts 顶部：八个起跑入口手写就一定会漏掉其中一处。
            ...resumedTurnFields(turnStart),
            exitStatus: null,
            commandLine: runningHandle.commandLine,
            executor: ex.label,
            // 这一轮跑在谁名下 —— 跨人续聊会换人(runOwner 上面刚算过),而 CLI 的会话
            // 文件跟着这个人的配置目录走。不刷新,接力就会去上一个人的目录里找。
            runOwnerUserId: runOwner ?? null,
            // 目录本身跟着一起刷新。走到这一支说明它与记下来的那个相同(不同的话
            // resumableHere 早把这条会话排除了),刷新只是不让这一列停在老值上。
            cliConfigDir: await cliConfigDirColumn(runOwner, agent),
            // 回合保真四件套整组刷新（说明见 db/schema.ts）：profile / 环境指纹 / 模型 /
            // 思考强度都可能在两轮之间被改，留着上一轮的值就会让重试按着别人的配置跑。
            executorId: profileId,
            executorFingerprint: profileFingerprint,
            turnModel: ex.model ?? null,
            turnReasoningEffort: ex.reasoningEffort ?? null,
            sideTurn,
            // 恢复命令三件套整组刷新(cwd 也可能在两轮之间变):少刷一列就是一条
            // 恢复不了的恢复命令,见 ResumeFields。
            ...ex.resumeFields(cwd, cliSessionId),
            // 重建上下文那一轮:换上新的 CLI 会话。标记**这里不清** —— 进程起来不等于新会话
            // 已经收下并存好重建的历史(init 之前就失败、被停、重启时没接回都有可能),这一轮
            // 成功收尾时才了结(single-run.ts);没了结,下一轮就再按删除后的记录重建一次。
            ...(reseed ? { cliSessionId } : {}),
            // 这一轮的解绑线索。**必须整组刷新**:沿用上一轮的 pid/offset 会让重启
            // 去接一个早就没了的进程,或者从上一轮的字节位置读这一轮的新文件。
            agentPid: runningHandle.detached?.pid ?? null,
            agentStartedAt: runningHandle.detached ? inspectProcess(runningHandle.detached.pid)?.startedAt ?? null : null,
            agentOutPath: runningHandle.detached ? detach.out : null,
            agentErrPath: runningHandle.detached ? detach.err : null,
            agentRcPath: runningHandle.detached ? detach.rc : null,
            agentOffset: 0,
            // 跟 pid 同组刷新:沿用上一轮的记号会让清理去找上一轮那批后代。
            agentUnitToken: runningHandle.detached?.unitToken ?? null,
          })
          .where(eq(sessions.id, sessId));
      } else {
        const base = all[0];
        await store.insert(sessions).values({
          id: sessId,
          taskId,
          role: sessionRole,
          agentType: agent,
          executor: ex.label,
          runOwnerUserId: runOwner ?? null,
          cliConfigDir: await cliConfigDirColumn(runOwner, agent),
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
          commandLine: runningHandle.commandLine,
          startedAt: turnStart,
          ...freshTurnFields(turnStart),
          activeMs: 0,
          exitStatus: null,
          agentPid: runningHandle.detached?.pid ?? null,
          agentStartedAt: runningHandle.detached ? inspectProcess(runningHandle.detached.pid)?.startedAt ?? null : null,
          agentOutPath: runningHandle.detached ? detach.out : null,
          agentErrPath: runningHandle.detached ? detach.err : null,
          agentRcPath: runningHandle.detached ? detach.rc : null,
          agentOffset: 0,
          agentUnitToken: runningHandle.detached?.unitToken ?? null,
        });
      }
    };
    if (reviewStart) await commitReviewTurnDelivery(taskId, reviewStart, handle.detached, persistRunner, sessId);
    else await persistRunner(db);
    // 后台问一句够不够得着 ash MCP:只提示不拦、不等(ash-mcp-turn-hint.ts);旁路回合在起跑处已过闸。
    if (!sideTurn) void hintAshMcpForTurn({ taskId, agentType: agent, executorId: profileId, ownerUserId: runOwner ?? null, cwd, sessionId: sessId });
    if (handoffNotice) await clearHandoffNotice(taskId);
    // 两条分支都算开了一个回合：开始就落行,收尾时按同一身份补 ended_at（见 session-turns.ts）。
    await openTurn({
      sessionId: sessId, taskId, cwd, startedAt: turnStart,
      // 跟下面落转录那一句同一个判据:系统回合不落用户发言,也就不算唤醒。
      monitorWake: !opts.system && isMonitorWakeTurn({ bySystem: opts.byBackend, monitorWake: opts.monitorWake }),
    });

    const out = createWriteStream(join(runDir, `${sessId}.md`), { flags: "a" });
    if (opts.system) {
      // Backend-initiated 继续: a 〔系统〕 trace (its own bubble), NOT a 你→ reply.
      // Persist as a structured turn (reload) and emit a matching system event (live).
      writeTurn(out, { t: "system", agent, text: SYS_MARKER }, turnStart);
      bus.publish({ type: "agent.event", taskId, sessionId: sessId, role: sessionRole, agentType: agent, event: { kind: "system", text: SYS_MARKER, at: turnStart } });
    } else {
      // 你→@agent reply, persisted as a structured turn so a reloaded thread shows
      // the human/backend turn as its own bubble; the matching event keeps every client live.
      recordUserConversationTurn({ taskId, sessionId: sessId, role: sessionRole, agentType: agent, out, text: userTurnText, at: turnStart, bySystem: opts.byBackend, monitorWake: opts.monitorWake, eventKey: opts.deliveryKey, answerIds: opts.answerIds });
    }
    // 上一回合尚未结算就收到回复时，消息会先排队，真正送达时任务已不再 paused；这条
    // 路径要在落盘后消费旧检查点，避免它继续挡完成与预约派审。若起点本来就是 paused，
    // 这句话也可能只是“怎么样了”一类追问：先保留检查点并用 followUpFrom 护住 paused，
    // 只有本轮明确 complete 时再由结算清掉。
    if (!opts.system && !opts.byBackend && task.resumePrompt && task.status !== "paused") {
      await takeResumePrompt(taskId, task.resumePrompt);
    }
    // 原文已经写进会话落盘文件了,但「落 sent」还缺最后一个事实:**agent 到底收下了没有**。
    // `run()` 返回只证明进程起来了 —— codex app-server 的回合输入是 spawn 之后才走协议发出去
    // 的,服务端死在那条缝里就会留下「进程活着、输入一个字没出去、消息却已经是终态 sent」的
    // 现场(2026-11-02 WfLfTjaGzcA8,1.5 小时零输出)。三态与取舍整份住在 turn-input-acceptance.ts;
    // 没有这条缝的执行器当场返回 accepted,零额外延迟。
    //
    // **三档一律如实往上报,这一层不替调用方做决定**(第 1 轮自由审查 F2/F3),各档的调用方义务
    // 写在 task-continue-options.ts 的 onInputSettled 上。这里只是正常出口;异常出口在 catch
    // 里结同一笔(turn-input-settlement.ts)。
    await inputSettlement.settle(handle);
    if (workspaceReset) {
      // 让用户也看见:agent 这一轮是在一个空目录上重新开始的。只发 toast 不算数,
      // 刷新后仍要能看出来(见 AGENTS.md 关于持久可见状态的约定)。
      writeTurn(out, { t: "system", agent, text: WORKSPACE_RESET_MARKER }, turnStart);
      bus.publish({ type: "agent.event", taskId, sessionId: sessId, role: sessionRole, agentType: agent, event: { kind: "system", text: WORKSPACE_RESET_MARKER, at: turnStart } });
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
      nativeSteer: {
        prepare: (text) => withSkillInvocation({ agentType: agent, cwd, text, userId: runOwner }),
        record: (text, at) => recordUserConversationTurn({
          taskId, sessionId: sessId, role: sessionRole, agentType: agent, out, text, at,
        }),
      },
    });
  } catch (err) {
    // **spawn 之后才抛的,输入事实照样要交给调用方**(第 2 轮自由审查 F1):会话持久化、交接提示、
    // 登记回合任何一步失败都会跳到这里,而协议层可能早就收下(或明确拒收)了这一轮。先把进程收掉
    // —— 这一轮反正要按失败收口,进程一关,未完成的请求一律落定 —— 再按协议定论结算。
    if (handle && !inputSettlement.settled()) {
      discardStartingRun(taskId, handle);
      await inputSettlement.settle(handle);
    }
    // 与 consumeSingleRun 的正常收流分支对称：有些 CLI 被 kill 后会让 parser 直接抛。
    // 「引导会话」已经在 releaseTurn 后登记了同会话续送，这里不能再把旧回合结算成 failed。
    // 两个抛出点:起跑前的 assertReviewTurnStart,和 spawn **之后**的 commitReviewTurnDelivery。后一种
    // 输入已交到 CLI 手上(finally 收掉它之前它可能已经动过),只能交给越线记号去判,不许说「没送出去」。
    const superseded = err instanceof ReviewSuperseded;
    // 撤回那条路**自己**写结算、自己把状态恢复到原值 —— 但它第一行就是「没有收据直接
    // return」(review-start-withdrawal.ts)。于是「**闸**抛了、而这一轮压根没拿到收据」那一支
    // 过去什么都不做:任务早在上面 setStatus 那一步改成了 running,回合锁又在下面 finally 里
    // 放掉,从此**卡在 running**,连 PATCH status 都会被 409 挡回(server/CLAUDE.md)。这形状
    // 真能走到:一个历史审查任务(reviewOf 挂着、轮次目录那套上线前跑完的那批压根没有证据行)
    // 收到任何一条回复 —— 退休扫描按「已收口」放它过去,闸这边却因为查不到证据行而判「原目标
    // 方向已失效」。所以这一支落回通用失败恢复:失败交代照发,状态按 followUpFrom 回到原值,
    // 返回值仍然如实说「一个字没送出去」(下面 frozenBeforeSpawn)。
    //
    // **判据必须是 `checkingReviewStart`,不能只问「有没有收据」**:同一个异常还有一个更早的
    // 抛出点 —— `beginReviewContinuation` 在**同一笔事务里**抛(过期的投递世代、身份被顶掉),
    // 那时状态一个字都还没改、followUpFrom 也随事务回滚了,没有任何东西需要恢复。那一支要是
    // 也走进通用恢复,`back` 读回 null 就会把一个 paused 的任务按 failed 结算掉,检查点连带
    // 被清空(test-review-history「过期检查点世代不许清掉同文本的新检查点」钉的就是这条)。
    if (superseded && !(checkingReviewStart && !reviewStart && !handle)) {
      await withdrawReviewStart(taskId, reviewStart, priorStatus, !!handle);
      frozenBeforeSpawn = !handle;
      // spawn 之前的审查撤回 = 这一笔已经不是当事人了,按撤回报(重排只会把同一笔过期的
      // 交接再撞一遍)。spawn 之后不算没送出去,所以那一支返回 true,压根不走这里。
      return frozenBeforeSpawn ? decline(frozenReason) : true;
    }
    const steered = await takeSteered(taskId);
    const stopped = takeStopped(taskId);
    if (steered && !stopped) return true;
    // 起跑前被冻结闸撤回(FrozenTurn 只在 spawn 之前抛):输入一个字都没进 CLI,对
    // 调用方就是「没送出去」—— 返回 true 会让 resumePrompt 那路把检查点当已消费,
    // 暂停撤回一次、指定继续内容永久丢失,恢复分组后只剩通用「继续」(第 7 轮审查)。
    // 状态结算(落回 paused)仍由失败恢复完成,只是返回值改说实话。
    // 越线凭据写不下来(DeliveryCrossingUnwritable)同属这一类:它也只在 spawn 之前抛,
    // 而且**必须**说实话 —— 调用方据此确知「没投喂」,直接归还,不必再去读那张读不出来的记号。
    // 走到这里的 ReviewSuperseded 必然是「闸抛的、且没有收据」那一支(上面已经把另外几种拦走
    // 了),输入同样一个字都没送出去,所以跟冻结撤回同一档。
    frozenBeforeSpawn = superseded || err instanceof FrozenTurn || err instanceof DeliveryCrossingUnwritable;
    // 三种都**确证没投喂**,但不是一件事:冻结闸是用户的动作(分组暂停 / 归档 / 删除),审查被
    // 顶替与上面那支同一个异常、同报撤回;越线凭据写不下来是一次写库故障。按原因分开报,别让
    // 调用方把一次故障读成「用户撤回」。
    if (frozenBeforeSpawn) frozenReason = err instanceof DeliveryCrossingUnwritable ? "backoff" : "withdrawn";
    if (!handle && (frozenBeforeSpawn || checkingReviewStart)) {
      await recordReviewStartNotLaunched(taskId, reviewStart);
      if (await restoreUndeliveredReviewStart(taskId, reviewStart, true)) return decline("withdrawn");
    }
    // 失败交代 + 基线对账 + 状态恢复,整段住在 turn-start-failure.ts(顺序讲究见其顶部)。
    await recoverFailedTurnStart({
      startReceipt: reviewStart,
      taskId,
      message: String(err instanceof Error ? err.message : err),
      sessionRole, agentType,
      spawned: !!handle,
      goalStarted: handle?.goalStarted?.() ?? !!handle?.goal?.(),
      goalStartFrom,
      systemTurn: !!opts.system,
      undeliveredText: userText + attachmentsPrompt(opts.attachments),
      resumeSessionId: opts.resumeSessionId,
      stopped, baseFallback, baseFallbackTold,
    });
  } finally {
    // 这一轮归谁:到 consumeSingleRun 认领之前都归起跑方,所以**失败出口必须连进程一起
    // 收掉**,只注销会留下一个没人读输出、停止按钮也碰不到的 CLI(第 1 轮审查 F1;三态
    // 和「为什么认领过的只注销不杀」见 runs.ts 顶部)。认领过的走到这里只是注销。
    if (handle) discardStartingRun(taskId, handle);
    releaseTurn(taskId, turn);
    // 同 task-run：全出口注销,不依赖走到收尾函数（第 6 轮审查必须修 1）。
    closeTaskTurns(taskId);
    if (slash?.name === "goal" && /^(clear|stop|off|reset|none|cancel)$/.test(slash.args)) void import("./scheduler.js").then(({ advanceQueueFromTask }) => advanceQueueFromTask(taskId)).catch((error) => console.error("[ash] 清除目标后的队列推进失败:", error));
  }
  // 走到这里 = 这一回合确实由本次调用接管了(跑成还是跑挂都算,错误已经在 catch 里
  // 落到时间线/状态上)。返回 false 的只有「一个字没送出去」的几类:被单飞锁挡回,起跑前
  // 被冻结闸撤回,以及 spawn 之前的审查撤回(让 resumePrompt/待发送消息的调用方把原文安全放回)。
  return frozenBeforeSpawn ? decline(frozenReason) : true;
}
