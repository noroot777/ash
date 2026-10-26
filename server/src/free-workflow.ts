import type {
  AgentType,
  FreeReviewDispatchInput,
  SessionRole,
  TaskStatus,
} from "@ash/shared";
import type { TurnReview } from "./runs.js";
import { and, eq } from "drizzle-orm";
import { bus } from "./bus.js";
import { db } from "./db/index.js";
import {
  freeReviewRounds,
  freeReviewRuns,
  freeWorkflowStates,
  reviewerProfiles,
  regressionEvidence,
  tasks,
} from "./db/schema.js";
import { clearReservationForDispatch, noteReservationStillWaiting, readFreeReviewReservation, consumeFreeReviewReservation, reservationWaitReason, startReservedFreeReview } from "./free-review-reservations.js";
import {
  checkMode,
  overrideLabel,
  overrideSuffix,
  reservedOverride,
  retryLimit,
  reviewNote,
  reviewOverride,
  reviewRunConfig,
} from "./free-review-input.js";
export { freeManualRepairPrompt, freeRepairPrompt, freeReviewPrompt } from "./free-review-prompts.js";
// 「按意见修复」那条链(入口校验 + 放行证明 + 投递回调)住在 free-review-manual-repair.ts;
// 入口仍从这里导出,调用方(路由/测试/裁定链)不必知道它搬了家。
export { startManualFreeReviewRepair } from "./free-review-manual-repair.js";
// 驳回与辩论那条支线（执行者不认某一轮结论 → 用户裁定 / 让双方各说几段）住在
// free-review-dispute.ts 与 free-review-debate.ts；这里只接两个口：辩论段的结算，
// 和「这一轮还在辩，别起下一轮」的挡板。裁定之后的修复交接在 free-review-manual-repair.ts。
import { activeDebateOf, settleDebateTurn } from "./free-review-debate.js";
// 一轮审查的生命周期（起一轮 / 续下一轮 / 启动失败收尾 / 重跑崩掉的那一轮）住在
// free-review-round.ts；这里只做「派/预约/结算」这一层的编排。
import {
  failReviewStart,
  latestWorkspaceRun,
  launchReviewRound,
  nextRound,
  reviewingRun,
} from "./free-review-round.js";
import { releaseFreeWorkflowAction, tryAcquireFreeWorkflowAction } from "./free-workflow-lock.js";
import { freeReviewEvidenceDir, freeReviewReportPath, readFreeReviewReport } from "./free-review-files.js";
import { checkRegressionConclusion, refreshRegressionEvidence } from "./regression-evidence-lifecycle.js";
import { assertConclusionTask, commitRegressionConclusion, type ConclusionTask } from "./regression-conclusion-commit.js";
import { completeRegressionSettlement, regressionSettlementConclusion } from "./regression-settlement.js";
import { retireHistoricalReview } from "./review-retirement.js";
import { activeReviewEvidence, preserveReviewWait, reviewContinuationPending } from "./review-continuation.js";
import { drainRegressionFinalization, finalization } from "./regression-finalization.js";
import { freeWorkflowState, type FreeWorkflowApiState } from "./free-workflow-state.js";
import { claimTurn, isTurnClaimed, releaseTurn, turnRole } from "./runs.js";
import { appendTaskTimeline } from "./task-timeline.js";
import { REPORT_SUMMARY_REMINDER } from "./review-report-format.js";
import { REVIEW_SWEEP_REMINDER } from "./review-sweep.js";
import { id, now } from "./util.js";
import type { Actor } from "./auth/context.js";
import { canUseOwned } from "./auth/owned.js";

type ReviewRunRow = typeof freeReviewRuns.$inferSelect;

export { freeWorkflowState };
export function freeReviewOutcome(input: {
  turnOk: boolean;
  conclusion: string | null;
  currentRound: number;
  retryLimit: number;
}): "failed" | "passed" | "repair" | "exhausted" {
  if (!input.turnOk || (input.conclusion !== "verified" && input.conclusion !== "verify_failed")) return "failed";
  if (input.conclusion === "verified") return "passed";
  return input.currentRound <= input.retryLimit ? "repair" : "exhausted";
}

// 唯一的「活」状态是 reviewing（审查旁路回合正在跑）。修复中/等待复审这些叙事不落库，
// 由「任务在跑 + 预约槽」推导（见 shared/free-workflow.ts 状态注释）。
/** 审查旁路回合是否正在进行（验收等不可逆操作要等它结束）。 */
export async function hasActiveFreeReview(taskId: string): Promise<boolean> {
  return !!(await reviewingRun(taskId));
}

export function assertBeforeAcceptance(task: { stage: string | null }): void {
  if (task.stage === "accepted" || task.stage === "merged") {
    throw new Error("任务已进入验收结果；如需继续修改，请先重新运行任务");
  }
}

/**
 * **把一条审查会话续起来要带的全套身份**:执行器 + 「这一轮是为哪一次审查的哪一轮起的」。
 *
 * 两样必须一起给。上一版这里只给 `sessionRole: "reviewer"`,于是手动恢复、答复审查者提问
 * 续起来的那一轮身份里 `review=null` —— 还活着的审查者再挂哨兵会被判成「这次审查已经结束」
 * (本轮审查 F2 实测 HTTP 409,照提示「在现在这一轮重挂」也没用)。
 *
 * 绑的是**正在恢复的那一轮**:`reviewingRun` 这一次查询既挑出执行器、也定下 run 与轮次,
 * 是同一个事实的两面 —— 不是在创建哨兵那一刻另查一次「现在最新是哪一轮」(那条现查正是
 * 第 10 轮审查 F1 的错投来源)。
 */
export type ReviewResumeRoute = {
  agent: AgentType;
  executorId: string | null;
  model: string | null;
  reasoningEffort: string | null;
  /** **不可缺**:reviewer 回合必须说出它为哪一次审查的哪一轮而起(runs.ts 的 `TurnSource`)。 */
  turnSource: { role: "reviewer"; review: TurnReview };
};

// 返回类型**显式写出来**,不靠推断:这几个调用点都是 `...spread` 进 `continueTask` 的,而
// spread 不受「多余属性检查」约束 —— 推断型返回值里写成 `sessionRole` 照样编译得过,那正是
// 本轮审查 F2 漏传的形状。标注之后,少带 `turnSource`(或者改回只带角色)在这一行就编译不过。
export async function freeReviewResumeOptions(taskId: string): Promise<ReviewResumeRoute | null> {
  const run = await reviewingRun(taskId);
  if (!run) return null;
  return {
    agent: run.agentType as AgentType,
    executorId: run.executorId,
    model: run.model,
    reasoningEffort: run.reasoningEffort,
    turnSource: { role: "reviewer", review: { run: run.id, round: run.currentRound } },
  };
}

export async function freeReviewReminder(taskId: string): Promise<string> {
  const run = await reviewingRun(taskId);
  if (!run) return "";
  const { reference } = await refreshRegressionEvidence(taskId,
    freeReviewEvidenceDir(taskId, run.id, run.currentRound), run.targetKind === "accepted_merge");
  // 中途提问后续跑那条路上，只有这条提醒还在重贴要求（崩掉重拉走 freeReviewResumeMessage，
  // 两条路各带一份），所以报告格式和扫描义务两份契约都得在 —— 原先这里只有浏览器提醒，
  // 而就地验证那侧的 `verifyReminderFor` 一直带着摘要契约：两个对称端点只做了一个。
  // 浏览器提醒由投递点统一贴(带项目授权),这里不内嵌 —— 理由同 review-prompts.ts。
  return `自由工作流审查提醒：你正在执行第 ${run.currentRound} 轮${run.checkMode === "logic" ? "逻辑" : "语法"}审查。` +
    `报告必须写到 ${freeReviewReportPath(taskId, run.id, run.currentRound)}，` +
    REPORT_SUMMARY_REMINDER +
    REVIEW_SWEEP_REMINDER +
    reference +
    `结束前调用 report_stage(verified|verify_failed) 并传最新【当前方向身份】directionToken，` +
    `不要调用 complete_task 或 accept_task。`;
}

// 预约在下一次执行回合正常结束时消费；任务完成确认仍由 complete_task 单独记账。
// 不论那个回合是在预约之前还是之后开跑的——任务正在跑（含已 claim、status 尚未落 running 的窗口）时挂
// 预约，本回合完成即触发审查，这正是「修复中先把复审预约上」的常规用法。所以这里刻意
// **不与 turn 互斥**；预约不动工作区、不投消息，写入本身没有并发危害。
// `actor` = 发起这次预约的人。审查者配置是**个人面**资源(§八),只能选自己那份 ——
// 不认归属的话,拿到别人的 profile id 就能把它存进自己的预约槽(第 2 轮审查 P1 实测)。
export async function reserveFreeReview(
  taskId: string,
  input: FreeReviewDispatchInput,
  actor?: Actor,
): Promise<FreeWorkflowApiState> {
  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!task) throw new Error("任务不存在");
  if (task.mode !== "single" || task.parentId || task.reviewOf) throw new Error("自由工作流只适用于普通单任务");
  if (task.workflowMode !== "free") throw new Error("当前任务不是自由工作流");
  if (task.archived) throw new Error("归档任务不能预约审查");
  if (task.status === "backlog") throw new Error("任务尚未运行，开始执行后再预约审查");
  assertBeforeAcceptance(task);
  if (!tryAcquireFreeWorkflowAction(taskId)) throw new Error("当前已有自由工作流操作正在进行");
  try {
    if (await reviewingRun(taskId)) throw new Error("审查回合正在进行，结束后再预约");
    // done 且最近一轮没有停在「未通过」→ 没有要等的修改，直接派审即可。
    // stopped 时放行：用户可以先预约、再发修复消息（顺序不限）。
    const last = await latestWorkspaceRun(taskId);
    if (task.status === "done" && last?.status !== "stopped") throw new Error("任务已完成，请直接派审查");
    const profile = (await db.select().from(reviewerProfiles).where(eq(reviewerProfiles.id, input.reviewerId))).at(0);
    // 「不是我的」与「根本没有」报同一句话(owned.ts `notYours` 同一个理由)。
    if (!profile || (actor && !(await canUseOwned(profile, actor)))) throw new Error("所选审查者不存在");
    const mode = checkMode(input.checkMode);
    const retries = retryLimit(input.retryLimit);
    const note = reviewNote(input.note);
    const override = await reviewOverride(input.override, actor);
    const at = now();
    const existing = (await db.select({ reviewArmed: freeWorkflowStates.reviewArmed }).from(freeWorkflowStates)
      .where(eq(freeWorkflowStates.taskId, taskId))).at(0);
    // 用户手动保存的预约是一条**新链**：清掉可能挂着的自动续轮 runId，改按新配置开新 run。
    // 覆盖四列同样整套写（没有覆盖就整套写 null），不能只写有值的那几个——留着上一条
    // 预约的残值会拼出用户从没选过的执行器组合。
    const slot = {
      selectedReviewerId: profile.id, reviewArmed: true, reviewCheckMode: mode, reviewRetryLimit: retries,
      reviewNote: note, reviewRunId: null,
      reviewAgentType: override?.agentType ?? null,
      reviewExecutorId: override?.executorId ?? null,
      reviewModel: override?.model ?? null,
      reviewReasoningEffort: override?.reasoningEffort ?? null,
      updatedAt: at,
    };
    await db.insert(freeWorkflowStates).values({ taskId, ...slot }).onConflictDoUpdate({
      target: freeWorkflowStates.taskId,
      set: slot,
    });
    await appendTaskTimeline(taskId, `${existing?.reviewArmed ? "已更新审查预约" : "已预约审查"}：${profile.name}${overrideSuffix(override)} · ` +
      `${mode === "logic" ? "逻辑检查" : "语法检查"} · 自动复审 ${retries} 轮${note ? " · 含附言" : ""}。执行回合正常结束后自动开始。`);
    bus.publish({ type: "task.review", taskId });
    return freeWorkflowState(taskId);
  } finally {
    releaseFreeWorkflowAction(taskId);
  }
}
export async function cancelFreeReviewReservation(taskId: string): Promise<FreeWorkflowApiState> {
  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!task) throw new Error("任务不存在");
  if (task.mode !== "single" || task.parentId || task.reviewOf || task.workflowMode !== "free") throw new Error("当前任务不支持自由审查");
  if (!tryAcquireFreeWorkflowAction(taskId)) throw new Error("当前已有自由工作流操作正在进行");
  try {
    const state = (await db.select({ reviewArmed: freeWorkflowStates.reviewArmed }).from(freeWorkflowStates)
      .where(eq(freeWorkflowStates.taskId, taskId))).at(0);
    if (state?.reviewArmed) {
      const at = now();
      await db.update(freeWorkflowStates)
        .set({
          reviewArmed: false, reviewNote: null, reviewRunId: null, updatedAt: at,
          // 覆盖跟着这条预约一起作废，否则会在下一条预约的表单里复活。
          reviewAgentType: null, reviewExecutorId: null, reviewModel: null, reviewReasoningEffort: null,
        })
        .where(eq(freeWorkflowStates.taskId, taskId));
      await appendTaskTimeline(taskId, "已取消审查预约。");
      bus.publish({ type: "task.review", taskId });
    }
    return freeWorkflowState(taskId);
  } finally {
    releaseFreeWorkflowAction(taskId);
  }
}

/**
 * 启动对账（排在 reattach 与 reconcileInterrupted 之后）：`reviewing` 是持久状态，真正的
 * 审查会话却在内存投递链上——进程死在「run 已落 reviewing、reviewer 回合还没起」的当口，
 * 重启后 run 会永远挂在 reviewing，验收与再审持续 409。
 * 判据用**任务的运行事实**，不用 sessions 表（session 行的 endedAt 既不代表进程活着、也
 * 不代表回合归属：reviewer 正常提问后 session 已结束、进程死了行却可能留 null，两个方向
 * 都会判错，审查实测复现）：
 * - 任务 running/queued 或 turn 已被占 → reattach 接回的回合活着，让它自己结算；
 * - 任务挂着 question / resumePrompt → 审查回合在等答复或续跑，是正常的等待态；
 * - 其余 → 这条审查已经没有任何东西能把它跑完，落 failed 并撤预约，用户可再派一轮。
 */
export async function reconcileFreeReviews(ownerTaskId?: string): Promise<void> {
  const stuck = await db.select().from(freeReviewRuns).where(eq(freeReviewRuns.status, "reviewing"));
  for (const run of stuck) {
    if (ownerTaskId && run.taskId !== ownerTaskId) continue;
    const task = (await db.select().from(tasks).where(eq(tasks.id, run.taskId))).at(0);
    if (!task) {
      // 任务行已不存在（旧版删除没做级联）：审查链永远无人结算，原地收尸自愈。
      await db.delete(freeReviewRounds).where(eq(freeReviewRounds.runId, run.id));
      await db.delete(freeReviewRuns).where(eq(freeReviewRuns.id, run.id));
      continue;
    }
    // **回合活着就不碰**——这一条必须排在最前面：reviewer 可能已上报结论、但回合被
    // reattach 接回还在跑，此刻按 turnOk=true 补结算是提前放行——reviewer 随后非零
    // 退出/被停止时，正常结算已找不到 reviewing run，错误结论无法撤销（审查实测）。
    if (task.status === "running" || task.status === "queued" || isTurnClaimed(task.id)) continue;
    if (await retireHistoricalReview(task, { role: "reviewer", review: { run: run.id, round: run.currentRound } })) continue;
    // 已交卷（当前 round 有结论）且回合确实死了：直接补结算，不能因遗留的
    // question/等待态被永远跳过——那会让验收持续被 active review 409 挡住（审查实测）。
    const round = (await db.select().from(freeReviewRounds)
      .where(and(eq(freeReviewRounds.runId, run.id), eq(freeReviewRounds.round, run.currentRound)))).at(0);
    const waiting = await db.transaction(async (transaction) => {
      const evidence = await activeReviewEvidence(transaction, task);
      return reviewContinuationPending(transaction, task, evidence, !!round?.conclusion);
    }, { behavior: "immediate" });
    if (waiting) continue;
    if (round?.conclusion) {
      await handleFreeWorkflowSettlement(run.taskId, task.status as TaskStatus, false, null, "reviewer");
      continue;
    }
    if (await db.transaction(async (transaction) => reviewContinuationPending(transaction, task,
      await activeReviewEvidence(transaction, task)), { behavior: "immediate" })) continue;
    if (!round) await db.insert(freeReviewRounds).values({ id: id(), runId: run.id, round: run.currentRound,
      status: "reviewing", startedAt: run.createdAt }).onConflictDoNothing();
    await handleFreeWorkflowSettlement(run.taskId, task.status as TaskStatus, false, null, "reviewer")
      .catch((error) => console.error(`[ash] 孤儿审查收尾待重试 ${run.id}:`, error));
  }
}

export async function reportFreeReviewConclusion(
  taskId: string,
  stage: string,
  opts: { bySessionRecovery?: boolean; verificationBasis?: unknown; expectedTask?: ConclusionTask; expectedDirectionToken?: string | null } = {},
): Promise<{ runId: string; round: number } | null> {
  const run = await reviewingRun(taskId);
  if (!run) return null;
  const task = opts.expectedTask ?? (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0];
  if (!task || task.id !== taskId || (opts.expectedDirectionToken !== undefined && opts.expectedDirectionToken !== task.activeDirectionToken)) {
    throw new Error("当前方向身份已变化，结论未提交");
  }
  const round = (await db.select().from(freeReviewRounds)
    .where(and(eq(freeReviewRounds.runId, run.id), eq(freeReviewRounds.round, run.currentRound))))[0];
  if (!round || round.status !== "reviewing") throw new Error("当前审查轮次已结束，结论未提交");
  if (stage !== "verified" && stage !== "verify_failed") {
    throw new Error("自由工作流审查回合只能上报 verified 或 verify_failed");
  }
  // 结论必须出自**活跃的审查回合**：读 turn 的运行时身份（claimTurn 时由 opts 显式落下），
  // 不查 sessions 表——session 行的 endedAt 既不代表进程活着、也不代表回合归属（reattach
  // 收尾先写 endedAt 再结算，正是误判窗口）。迟到重放（审查回合已结束 → turn 已释放）和
  // 普通回合的误投（turnRole=single）都拒。MCP 补捞豁免这一检查——它发生在回合收尾、
  // turn 已释放之后，但补捞方已核对过调用出自 reviewer 会话自己的回合记录。
  if (!opts.bySessionRecovery && turnRole(taskId) !== "reviewer") {
    throw new Error("当前没有正在进行的审查回合，结论已拒收（迟到或误投的调用不落账）");
  }
  // report.md 是唯一必交证据——只写在 prompt 里挡不住，结论入口硬校验：读取走安全解析
  // （拒 symlink 祖先），且正文 trim 后非空（两个空白字节的「报告」不算报告）。
  if (!readFreeReviewReport(taskId, run.id, run.currentRound).trim()) {
    throw new Error(`审查结论必须先落报告：请把非空报告写到 ${freeReviewReportPath(taskId, run.id, run.currentRound)} 再上报结论`);
  }
  const checked = await checkRegressionConclusion(taskId, freeReviewEvidenceDir(taskId, run.id, run.currentRound), stage,
    opts.verificationBasis);
  await commitRegressionConclusion(checked, async (transaction) => {
    await assertConclusionTask(transaction, task);
    const currentRun = (await transaction.select().from(freeReviewRuns).where(eq(freeReviewRuns.id, run.id)))[0];
    const currentRound = (await transaction.select().from(freeReviewRounds).where(eq(freeReviewRounds.id, round.id)))[0];
    if (!currentRun || currentRun.status !== "reviewing" || currentRun.currentRound !== run.currentRound
      || currentRound?.status !== "reviewing" || currentRound.conclusion !== round.conclusion) {
      throw new Error("审查轮次或结论已变化，本次上报未提交");
    }
    const evidence = checked && (await transaction.select().from(regressionEvidence)
      .where(eq(regressionEvidence.directory, checked.directory)))[0];
    if (evidence?.settlement && currentRound.conclusion !== stage) throw new Error("本轮已进入结算，不能更改结论");
    await transaction.update(freeReviewRounds).set({ conclusion: stage }).where(eq(freeReviewRounds.id, round.id));
  });
  bus.publish({ type: "task.review", taskId });
  return { runId: run.id, round: run.currentRound };
}

// 自由工作流的回合结算只分两种回合，**按回合自己的 role 分流**，不按「库里有没有
// reviewing run」猜——派审请求可能在普通回合 claimTurn 之后才插入 reviewing run
// （TOCTOU），靠查库会把普通回合冒充成审查回合、把没有结论的审查链错杀成 failed：
// - role=reviewer（审查旁路回合）：按 conclusion 落 round/run，未通过且还有轮数时
//   发修复消息并挂**自动续轮预约**（runId）。
// - 其它 role（首次完成 / 修复 / 用户续聊）：正常收尾且不在等待态时消费预约槽；
//   若此刻存在并发插入的 reviewing run，不碰它——审查消息还在排队，回合结束后照常开跑。
export async function handleFreeWorkflowSettlement(
  taskId: string,
  status: TaskStatus,
  confirmedDone: boolean,
  turnOk: boolean | null,
  role: SessionRole = "single",
  exitObserved = true,
  executionFailed = false,
): Promise<boolean> {
  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!task || task.workflowMode !== "free") return false;
  // 辩论段（审查者答辩 / 执行者回应）排在角色分流**之前**收：它既可能是 reviewer 回合
  // 也可能是任务自己的旁路回合，按角色分流会把它误当成普通审查/执行回合结算掉。
  if (await settleDebateTurn(taskId, turnOk === true)) return true;
  const run = await reviewingRun(taskId);
  if (role !== "reviewer") {
    if (task.question || task.resumePrompt) {
      // 等待态照旧不消费预约,但**必须把「在等什么」留下来**:这一条 return 原先一句话都
      // 不写,于是界面上只剩一个亮着的「已预约审查」而审查迟迟不开始,用户只能得出「预约
      // 坏了」。挂着活哨兵时尤其要说清 —— 那是 agent 自己安排的等待(start_monitor +
      // pause_task),事件回来才会续跑,预约审查本来就该等它把结果带回来再看
      // (用户 2026-10-16 指出:执行者起了哨兵,预约的审查也该等着)。
      await noteReservationStillWaiting(taskId, await reservationWaitReason(task));
      return true;
    }
    // 存在 reviewing run 说明有一条审查在排队等这个回合结束（并发派审）：不结算它、
    // 也不消费预约（审查在跑时消费预约会双开）。
    if (run) return true;
    // 自动续轮预约只服务于「修复成功后复审」。修复执行器自己已经报错（包括 error 事件
    // 后仍 exit 0 的 API 故障）时继续审查，只会反复检查一份没有完成修复的代码。按预约
    // 快照 CAS 取消这一条自动预约；用户并发改成的手动预约不碰，仍走下面的等待语义。
    if (executionFailed) {
      const reservation = await readFreeReviewReservation(taskId);
      if (reservation?.armed && reservation.runId) {
        const canceled = await consumeFreeReviewReservation(taskId, reservation);
        if (canceled) {
          await appendTaskTimeline(taskId, "修复执行回合异常结束，自动复审已取消；修复成功后可重新派审。");
          return true;
        }
      }
    }
    // 缺退出事件只限制未交卷的备用触发路径，已落库的完成确认和审查结论仍各自有效。
    if (turnOk && (confirmedDone || exitObserved) && (status === "done" || status === "failed" || status === "canceled")) {
      const reservation = await readFreeReviewReservation(taskId);
      // ── 排队消息优先于预约审查 ──
      // 托盘里还有该发的消息，就这一轮不开审：用户排的那几句是**给实现会话的后续指令**，
      // 审查该看的是它们都说完之后的工作区，而不是半截的。
      //
      // 让路必须发生在这里（结算内），不能指望两条路在释放点上「公平竞争」——它们抢的是
      // 同一把单飞锁，而审查走的 `continueWhenIdle` 排到队头就**同步** claimTurn
      // （runs.ts），消息投递第一步却是 `await beginDelivery`，于是审查一定赢、消息被挡回
      // 托盘（`abortDelivery`）等下一轮。谁先注册 waiter 都改不了这个结果。
      //
      // 预约原样留在槽里：消息送进会话 → 那一轮执行回合正常结束 → 再次走到这里时托盘已空，
      // 审查自然开跑。托盘里剩的若是没到钟点的定时消息则不算数（hasDeliverablePendingMessages）。
      if (reservation?.armed) {
        const { hasDeliverablePendingMessages } = await import("./pending-messages.js");
        if (await hasDeliverablePendingMessages(taskId)) {
          await noteReservationStillWaiting(taskId, "还有排队消息没送进会话，先把它们发完");
          return true;
        }
      }
      const noteDispatch = async () => {
        if (!confirmedDone) await appendTaskTimeline(taskId, "执行回合已正常结束，按预约启动审查。本回合未确认任务完成，任务完成状态仍按原结算结果保留。");
      };
      // 槽由 startReservedFreeReview 按 CAS 消费（消费成功才启动），所以下面两条失败路径
      // 都不再补 disarm——那时槽已经空了，再清一次清掉的会是用户新保存的那条。
      await startReservedFreeReview(taskId, reservation, {
        continueRun: async (runId) => {
          const target = (await db.select().from(freeReviewRuns).where(eq(freeReviewRuns.id, runId))).at(0);
          if (!target || target.status !== "stopped") {
            throw new Error("预约续审的审查链已不在等待状态，预约已取消");
          }
          // 续轮起不来（典型：崩溃残留的半个 round 造成唯一键冲突，run 已被判 failed）是
          // 永久性失败：槽已消费，不会再有幽灵预约反复撞同一个错误。
          await nextRound(task, target);
          await noteDispatch();
        },
        startNew: async (input) => {
          // 预约时存下的「这次换个模型/智能水平跑」原样带上。执行器在这中间被删了就只摘
          // 掉那一段（模型/智能水平仍按用户改的跑），并把降级写进时间线——见 reservedOverride。
          const reserved = await reservedOverride(input.override);
          const state = await startFreeReview(taskId, {
            reviewerId: input.reviewerId,
            checkMode: checkMode(input.checkMode ?? "logic"),
            retryLimit: retryLimit(input.retryLimit ?? 1),
            note: reviewNote(input.note),
            override: reserved.override,
          }, { slotToken: input.slotToken });
          if (reserved.dropped === "executor") {
            await appendTaskTimeline(taskId, `预约里选的执行器已不可用，这次改用 ${reserved.override!.agentType} 的默认执行器（模型与智能水平仍按你预约时改的跑）。`);
          } else if (reserved.dropped === "all") {
            await appendTaskTimeline(taskId, "预约里的执行器覆盖已失效，这次按审查者自己的配置跑。");
          }
          await noteDispatch();
          return state;
        },
      });
      return true;
    }
    await noteReservationStillWaiting(taskId, !turnOk
      ? "本回合被停止或异常结束"
      : !exitObserved ? "本回合未确认完成，且没有收到正常退出事件" : "本回合仍处于等待执行或暂停状态");
    return true;
  }

  // ── 审查旁路回合结算 ──
  if (!run) return true; // 审查回合结算时 run 已被外力改掉：没有可结算的对象
  const round = (await db.select().from(freeReviewRounds)
    .where(and(eq(freeReviewRounds.runId, run.id), eq(freeReviewRounds.round, run.currentRound)))).at(0);
  if (!round) return true;
  // 提问守卫只保护「审查回合以提问/检查点收尾」的场景（等答复回来续跑再结算）。
  // reviewer 已交卷（round 有结论）就必须结算——question 可能是实现回合遗留的旧字段，
  // 拿它挡住已有结论的审查会让链永远停在 reviewing（审查实测复现）。
  const waitingEvidence = await db.transaction((transaction) => activeReviewEvidence(transaction, task), { behavior: "immediate" });
  if (turnOk !== false && await db.transaction((transaction) => reviewContinuationPending(transaction, task,
    waitingEvidence, !!round.conclusion, true), { behavior: "immediate" })) {
    await preserveReviewWait(task); return true;
  }
  const directory = freeReviewEvidenceDir(taskId, run.id, run.currentRound);
  const checked = await regressionSettlementConclusion(taskId, directory, {
    outcome: turnOk === null ? undefined : turnOk ? "done" : "failed", round: run.currentRound,
    freeRoundId: round.id, acceptedMerge: run.targetKind === "accepted_merge",
  });
  if (!checked) return true;
  const at = now();
  const outcome = freeReviewOutcome({
    turnOk: checked.outcome === "done",
    conclusion: checked.conclusion,
    currentRound: run.currentRound,
    retryLimit: run.retryLimit,
  });
  await completeRegressionSettlement(directory, checked, async (transaction) => {
    const currentRun = (await transaction.select().from(freeReviewRuns).where(eq(freeReviewRuns.id, run.id)))[0];
    const currentRound = (await transaction.select().from(freeReviewRounds).where(eq(freeReviewRounds.id, round.id)))[0];
    if (currentRun?.status !== "reviewing" || currentRun.currentRound !== run.currentRound || currentRound?.status !== "reviewing") return false;
    await transaction.update(freeReviewRounds).set({ conclusion: checked.conclusion,
      status: outcome === "failed" ? "error" : outcome === "passed" ? "passed" : "failed", endedAt: at,
    }).where(eq(freeReviewRounds.id, round.id));
    await transaction.update(freeReviewRuns).set({ status: outcome === "failed" ? "failed" : outcome === "passed" ? "passed" : "stopped",
      updatedAt: at, finishedAt: at }).where(eq(freeReviewRuns.id, run.id));
    if (turnOk === null && !round.conclusion) await transaction.update(freeWorkflowStates).set({
      reviewArmed: false, reviewNote: null, reviewRunId: null, updatedAt: at,
      reviewAgentType: null, reviewExecutorId: null, reviewModel: null, reviewReasoningEffort: null,
    }).where(eq(freeWorkflowStates.taskId, taskId));
    return true;
  }, finalization("free", { run, outcome, at }));
  await drainRegressionFinalization(directory);
  return true;
}


export type AcceptedMergeReviewTarget = {
  kind: "accepted_merge";
  branch: string;
  baseCommit: string;
  mergeCommit: string;
};

export async function startFreeReview(
  taskId: string,
  input: FreeReviewDispatchInput,
  opts: { holdTurn?: boolean; slotToken?: string; target?: AcceptedMergeReviewTarget; actor?: Actor } = {},
): Promise<FreeWorkflowApiState> {
  // 同 reserveFreeReview:HTTP 派审只能选自己的审查者;结算内部消费预约不传 actor
  // (那份 reviewerId 在预约那一刻已经认过归属了)。
  const actor = opts.actor;
  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!task) throw new Error("任务不存在");
  if (task.mode !== "single" || task.parentId || task.reviewOf) throw new Error("自由工作流只适用于普通单任务");
  if (task.workflowMode !== "free") throw new Error("当前任务不是自由工作流");
  if (task.archived) throw new Error("归档任务不能派审");
  if (task.status === "backlog") throw new Error("任务尚未运行，完成实现后再派审");
  if (task.status === "running" || task.status === "queued") throw new Error("任务正在运行或排队，结束后再派审");
  // 遗留的提问/续跑指令必须先处理：审查回合结算与启动对账都把这两个字段当「审查在等
  // 答复」的正常态，带着旧字段开审会让新审查链永远收不了尾（审查实测复现）。
  if (task.question || task.resumePrompt) throw new Error("任务正等待答复或续跑，处理后再派审");
  if (opts.target) {
    if (task.stage !== "accepted") throw new Error("任务尚未完成验收，不能审查合并结果");
  } else {
    assertBeforeAcceptance(task);
  }
  // HTTP 派审必须与普通回合**原子互斥**：从校验到写入 reviewing run 的整段占住 turn
  // （占位身份 dispatch，不冒充 reviewer——此刻还没有审查回合）。只查一次 isTurnClaimed
  // 是 TOCTOU：检查后普通回合仍能 claim 成功，两边同时启动（审查实测五连中）。审查
  // 投递（whenTurnIdle）在自己占着 turn 时排队，finally 释放后自然开跑。
  // 结算内部的派审（预约消费）不走这里：那时收尾回合正占着 turn，天然互斥。
  const holdingTurn = opts.holdTurn === true;
  if (holdingTurn && !claimTurn(taskId, "dispatch")) {
    throw new Error("任务回合正在进行，结束后再派审");
  }
  try {
  if (!tryAcquireFreeWorkflowAction(taskId)) throw new Error("当前已有自由工作流操作正在进行");
  try {
    if (await reviewingRun(taskId)) throw new Error("审查回合正在进行，结束后再派审");
    // 辩论也是占着这条任务的旁路回合（段与段之间回合是空的，只查 turn 挡不住）。
    if (await activeDebateOf(taskId)) throw new Error("审查意见辩论正在进行，结束后再派审");
    const profile = (await db.select().from(reviewerProfiles).where(eq(reviewerProfiles.id, input.reviewerId))).at(0);
    // 「不是我的」与「根本没有」报同一句话(owned.ts `notYours` 同一个理由)。
    if (!profile || (actor && !(await canUseOwned(profile, actor)))) throw new Error("所选审查者不存在");
    const mode = checkMode(input.checkMode);
    const retries = opts.target ? 0 : retryLimit(input.retryLimit);
    const note = reviewNote(input.note);
    const override = await reviewOverride(input.override, actor);
    const config = reviewRunConfig(profile, override);
    const at = now();
    const run: ReviewRunRow = {
      id: id(), taskId, reviewerId: profile.id, reviewerName: profile.name,
      agentType: config.agentType, executorId: config.executorId, model: config.model,
      reasoningEffort: config.reasoningEffort, checkMode: mode, note, retryLimit: retries,
      targetKind: opts.target?.kind ?? "workspace",
      targetBranch: opts.target?.branch ?? null,
      targetBaseCommit: opts.target?.baseCommit ?? null,
      targetCommit: opts.target?.mergeCommit ?? null,
      repairTaskId: null,
      currentRound: 1, status: "reviewing", createdAt: at, updatedAt: at, finishedAt: null,
    };
    await db.insert(freeReviewRuns).values(run);
    try {
      await db.insert(freeReviewRounds).values({
        id: id(), runId: run.id, round: 1, status: "reviewing", conclusion: null, startedAt: at, endedAt: null,
      });
      // 派审即刻消费掉预约槽的一切（含覆盖四列）；从预约消费进来时沿用它的版本令牌，
      // 好让下面启动失败的回滚还能认出这个空位是自己腾的，也好让用户抢在这之前保存的
      // 新预约留在槽里不被抹掉（两者都在 clearReservationForDispatch 里靠同一次 CAS）。
      if (!opts.target) {
        await clearReservationForDispatch(taskId, {
          reviewerId: profile.id, checkMode: mode, retryLimit: retries, token: opts.slotToken,
        });
      }
      // 派审面上临时改过执行器：写一行，否则时间线只有审查者名字，读不出这一轮跑的是谁。
      if (override) {
        await appendTaskTimeline(taskId, `本次审查改用 ${overrideLabel(override)}（${profile.name} 的配置未改动）。`);
      }
      await launchReviewRound(task, run);
    } catch (error) {
      await failReviewStart(run, error instanceof Error ? error.message : String(error));
      throw error;
    }
    return freeWorkflowState(taskId);
  } finally {
    releaseFreeWorkflowAction(taskId);
  }
  } finally {
    if (holdingTurn) releaseTurn(taskId);
  }
}
