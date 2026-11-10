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
//
// 启动期 / 周期对账（`reconcileFreeReviews`：一条挂在 reviewing 的链此刻还有没有人能把它跑完）
// 住在 free-review-reconcile.ts —— 它反过来用这里的结算入口，所以切出去才不成环。
// 入口仍从这里导出（见文件末尾那个转发），老调用方不必知道它搬了家。
import {
  failReviewStart,
  freshSessionFor,
  latestWorkspaceRun,
  launchReviewRound,
  nextRound,
  reviewingRun,
} from "./free-review-round.js";
// 派审入口在公开这一轮**之前**就得把责任登记下来(认领 + 持久的准备意图),整段理由见
// free-review-dispatch.ts 文件头 ⑭。
import {
  claimReviewDispatch, preparingReviewDispatch, releaseReviewDispatchClaim,
} from "./free-review-dispatch.js";
import { releaseFreeWorkflowAction, tryAcquireFreeWorkflowAction } from "./free-workflow-lock.js";
import { NO_REMINDER, type TurnReminder } from "./turn-prompt.js";
import { freeReviewEvidenceDir, freeReviewReportPath, readFreeReviewReport } from "./free-review-files.js";
import { checkRegressionConclusion, evidenceState, refreshRegressionEvidence } from "./regression-evidence-lifecycle.js";
import { assertConclusionTask, commitRegressionConclusion, type ConclusionTask } from "./regression-conclusion-commit.js";
import { completeRegressionSettlement, regressionSettlementConclusion, type SettlementFence } from "./regression-settlement.js";
import { activeReviewEvidence, preserveReviewWait, reviewContinuationPending } from "./review-continuation.js";
import { drainRegressionFinalization, finalization } from "./regression-finalization.js";
import { freeWorkflowState, type FreeWorkflowApiState } from "./free-workflow-state.js";
import { claimOwnTurn, releaseTurn, turnRole } from "./runs.js";
import { appendTaskTimeline } from "./task-timeline.js";
import { noteReviewInput, reviewInputHoldNow } from "./review-input-verdict.js";
import { REPORT_SUMMARY_REMINDER } from "./review-report-format.js";
import { extractReportFindings } from "./review-history.js";
import { parseCarries } from "./review-recurrence.js";
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

export async function freeReviewReminder(taskId: string): Promise<TurnReminder> {
  const run = await reviewingRun(taskId);
  if (!run) return NO_REMINDER;
  const { reference, manifestEntry } = await refreshRegressionEvidence(taskId,
    freeReviewEvidenceDir(taskId, run.id, run.currentRound), run.targetKind === "accepted_merge");
  // 中途提问后续跑那条路上，只有这条提醒还在重贴要求（崩掉重拉走 freeReviewResumeMessage，
  // 两条路各带一份），所以报告格式和扫描义务两份契约都得在 —— 就地验证那侧的
  // `verifyReminderFor` 一直带着摘要契约：两个对称端点不能只做一个。
  return {
    text: `自由工作流审查提醒：你正在执行第 ${run.currentRound} 轮${run.checkMode === "logic" ? "逻辑" : "语法"}审查。` +
      `报告必须写到 ${freeReviewReportPath(taskId, run.id, run.currentRound)}，` +
      REPORT_SUMMARY_REMINDER +
      REVIEW_SWEEP_REMINDER +
      reference +
      `结束前调用 report_stage(verified|verify_failed) 并传最新【当前方向身份】directionToken，` +
      `不要调用 complete_task 或 accept_task。`,
    manifestEntry,
  };
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
      reviewNote: note, reviewRunId: null, reviewSource: "user" as const,
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
          reviewArmed: false, reviewNote: null, reviewRunId: null, reviewSource: null, updatedAt: at,
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

export async function reportFreeReviewConclusion(
  taskId: string,
  stage: string,
  opts: {
    bySessionRecovery?: boolean; verificationBasis?: unknown; expectedTask?: ConclusionTask; expectedDirectionToken?: string | null;
    /** report_stage 的 `recurs`（同类问题承接，见 review-recurrence.ts）：读不懂的一条都不落，从不因它拒收结论。 */
    recurs?: unknown;
  } = {},
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
  // 结论必须出自**活跃的审查回合**：读 turn 的运行时身份（claimOwnTurn 时由 opts 显式落下），
  // 不查 sessions 表——session 行的 endedAt 既不代表进程活着、也不代表回合归属（reattach
  // 收尾先写 endedAt 再结算，正是误判窗口）。迟到重放（审查回合已结束 → turn 已释放）和
  // 普通回合的误投（turnRole=single）都拒。MCP 补捞豁免这一检查——它发生在回合收尾、
  // turn 已释放之后，但补捞方已核对过调用出自 reviewer 会话自己的回合记录。
  if (!opts.bySessionRecovery && turnRole(taskId) !== "reviewer") {
    throw new Error("当前没有正在进行的审查回合，结论已拒收（迟到或误投的调用不落账）");
  }
  // report.md 是唯一必交证据——只写在 prompt 里挡不住，结论入口硬校验：读取走安全解析
  // （拒 symlink 祖先），且正文 trim 后非空（两个空白字节的「报告」不算报告）。
  const report = readFreeReviewReport(taskId, run.id, run.currentRound);
  if (!report.trim()) {
    throw new Error(`审查结论必须先落报告：请把非空报告写到 ${freeReviewReportPath(taskId, run.id, run.currentRound)} 再上报结论`);
  }
  // 承接只对拦验收的结论有意义；「本轮第 N 条」按报告里真抽得到的条数核，编号按这一轮真发出去的清单核。
  const carries = stage === "verify_failed"
    ? parseCarries(opts.recurs, extractReportFindings(report).length, new Set(round.historyRefs ?? []))
    : [];
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
    await transaction.update(freeReviewRounds).set({ conclusion: stage, carries: carries.length ? carries : null })
      .where(eq(freeReviewRounds.id, round.id));
  });
  bus.publish({ type: "task.review", taskId });
  return { runId: run.id, round: run.currentRound };
}

/**
 * 按预约开审：续轮预约在原链上续下一轮，手存预约开一条新链。结算与「裁定放行」
 * （free-review-ruling-release.ts）两个触发点共用这一份，开审的细节只写一遍。
 *
 * 调用方负责「此刻没有别的回合会动这个任务」：结算时是正在收尾的那个回合占着，裁定放行
 * 时由调用方自己占一个 dispatch 身份。`afterDispatch` 只在真的开出审查后调用。
 */
export async function launchReservedFreeReview(
  task: typeof tasks.$inferSelect,
  reservation: Awaited<ReturnType<typeof readFreeReviewReservation>>,
  afterDispatch: () => Promise<unknown>,
): Promise<void> {
  const taskId = task.id;
  await startReservedFreeReview(taskId, reservation, {
    continueRun: async (runId) => {
      const target = (await db.select().from(freeReviewRuns).where(eq(freeReviewRuns.id, runId))).at(0);
      if (!target || target.status !== "stopped") {
        throw new Error("预约续审的审查链已不在等待状态，预约已取消");
      }
      // 续轮起不来（典型：崩溃残留的半个 round 造成唯一键冲突，run 已被判 failed）是
      // 永久性失败：槽已消费，不会再有幽灵预约反复撞同一个错误。
      await nextRound(task, target);
      await afterDispatch();
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
      await afterDispatch();
      return state;
    },
  });
}

// 自由工作流的回合结算只分两种回合，**按回合自己的 role 分流**，不按「库里有没有
// reviewing run」猜——派审请求可能在普通回合 claimOwnTurn 之后才插入 reviewing run
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
  /**
   * **孤儿收尾专用的落笔条件**(只有 `reconcileFreeReviews` 那一路传)。
   *
   * 正常结算跑在**回合锁里面**,它写的就是刚刚结束的那一轮,不存在「写的时候情况已经变了」。
   * 孤儿收尾不一样:它是从外面判断「已经没有任何东西能把这一轮跑完」,而这个判断从读到写之间
   * 隔着好几次 await —— 另一份恢复完全可以在这中间把任务书送进会话、把审查者拉起来
   * (第 3 轮审查 F1)。多读一遍只是把窗口变窄,所以把判断那一刻的 `tasks.direction_epoch`
   * 带进来当落笔条件。
   *
   * **条件交给结算层,不在这里手写**:结算是两段式的,上半场
   * (`regressionSettlementConclusion`)就已经把 settlement/continuation 写进证据行 —— 只守下半场
   * 那一笔,迟到者照样能在上半场把一条正在输出的审查的结算状态写成失败,而后续上报和正常退出
   * 都沿用它(第 4 轮审查 F1)。声明一次、每一次持久写之前各核一遍,判据见 `SettlementFence`。
   * 来源见 `reviewOrphanStillUnowned`。
   */
  orphanFence?: SettlementFence,
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
      if (reservation?.armed && reservation.source === "follow_up") {
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
      // 同一把单飞锁，而审查走的 `continueWhenIdle` 排到队头就**同步** claimOwnTurn
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
      // 槽由 startReservedFreeReview 按 CAS 消费（消费成功才启动），所以失败路径都不再补
      // disarm——那时槽已经空了，再清一次清掉的会是用户新保存的那条。
      await launchReservedFreeReview(task, reservation, async () => {
        if (!confirmedDone) await appendTaskTimeline(taskId, "执行回合已正常结束，按预约启动审查。本回合未确认任务完成，任务完成状态仍按原结算结果保留。");
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
  // **没交卷 ≠ 审查者没给结论** —— 也可能是任务书压根没进它手里(判据与收口见 review-input-verdict.ts)。
  // 说不清:这一轮**永不由这里结掉**(连意图一起留着),时间线说清为什么还挂着、接下来靠谁 ——
  // 迟到的定论,或者用户点「继续本轮审查」。确证拒收:照常结算,但先把真实原因写进时间线。
  const input = round.conclusion ? null : await reviewInputHoldNow(taskId, task, directory);
  if (input) {
    await noteReviewInput(task, run, directory, input);
    if (input !== "refused") return true;
  }
  const checked = await regressionSettlementConclusion(taskId, directory, {
    // 孤儿收尾那一路的落笔条件:上下两个事务由结算层各核一次(见那边的 `SettlementFence`)。
    ...(orphanFence ? { fence: orphanFence } : {}),
    outcome: turnOk === null ? undefined : turnOk ? "done" : "failed", round: run.currentRound,
    freeRoundId: round.id, acceptedMerge: run.targetKind === "accepted_merge",
    // 这一分支的审查是同一个任务上的旁路回合,「活回合」那一问上面刚判过(reviewer 自己那轮
    // 死没死),不要在恢复路径里再按 owner 的 status 拦一次 —— 见该参数的说明。
    ignoreActive: true,
  });
  if (!checked) return true;
  const at = now();
  // 「转修复还是用完」按**落笔事务里**重读的 run 行判，不按开头那份快照：审查进行中用户可以
  // 改这条链的轮数上限（free-review-rounds.ts）。拿快照判的话，最后一轮跑着时加的那一轮会被
  // 读漏，这一轮没通过照样判成用完，执行者不会被叫起来修。收尾载荷里的 run 也用这份新行，
  // 续轮预约记下的轮数才跟 run 行一致。
  let settled: { run: ReviewRunRow; outcome: ReturnType<typeof freeReviewOutcome> } | null = null;
  await completeRegressionSettlement(directory, checked, async (transaction) => {
    const currentRun = (await transaction.select().from(freeReviewRuns).where(eq(freeReviewRuns.id, run.id)))[0];
    const currentRound = (await transaction.select().from(freeReviewRounds).where(eq(freeReviewRounds.id, round.id)))[0];
    if (currentRun?.status !== "reviewing" || currentRun.currentRound !== run.currentRound || currentRound?.status !== "reviewing") return false;
    const outcome = freeReviewOutcome({
      turnOk: checked.outcome === "done",
      conclusion: checked.conclusion,
      currentRound: currentRun.currentRound,
      retryLimit: currentRun.retryLimit,
    });
    settled = { run: currentRun, outcome };
    await transaction.update(freeReviewRounds).set({ conclusion: checked.conclusion,
      status: outcome === "failed" ? "error" : outcome === "passed" ? "passed" : "failed", endedAt: at,
      // 终态轮次不再挂在途意图(同 `failReviewStart`):留着的话对账只扫 reviewing,它再也没人清。
      dispatch: null,
    }).where(eq(freeReviewRounds.id, round.id));
    await transaction.update(freeReviewRuns).set({ status: outcome === "failed" ? "failed" : outcome === "passed" ? "passed" : "stopped",
      updatedAt: at, finishedAt: at }).where(eq(freeReviewRuns.id, run.id));
    if (turnOk === null && !round.conclusion) await transaction.update(freeWorkflowStates).set({
      reviewArmed: false, reviewNote: null, reviewRunId: null, reviewSource: null, updatedAt: at,
      reviewAgentType: null, reviewExecutorId: null, reviewModel: null, reviewReasoningEffort: null,
    }).where(eq(freeWorkflowStates.taskId, taskId));
    return true;
  }, () => finalization("free", { ...settled!, at }));
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
  // 占到的那把锁的身份一路带到 finally:这中间全是 await,人工放开可以把锁拔走、另一轮
  // 合法占上,按任务 id 还锁撤掉的就是后来者那把(本轮审查 F1,见 turn-lock.ts `endOwnTurn`)。
  const holdingTurn = opts.holdTurn === true;
  const turn = holdingTurn ? claimOwnTurn(taskId, "dispatch") : null;
  if (holdingTurn && !turn) {
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
    // **代次先有、责任先登记,再公开这一轮** —— 顺序就是第 2 轮审查问题 2 的修法
    // (free-review-dispatch.ts 文件头 ⑭)。证据行也因此由这里建,而不是等 launch 的第一个 await
    // ——「公开了却谁都没在负责」那一瞬是孤儿收尸的全部依据(复现 A:run/round 都已 reviewing、
    // 内存里没有认领、库里没有意图,一次普通对账就把它判成 failed/error,随后 POST 照样回 201,
    // 任务书一个字都没送出去)。
    const generation = (await evidenceState(taskId, freeReviewEvidenceDir(taskId, run.id, 1), task)).generation;
    const claimToken = claimReviewDispatch(run.id, 1, generation);
    // run.id 是这一行刚生成的,所以领不到只能是同一毫秒里另一条入口撞上了同一个 id ——
    // 不往下公开任何状态,如实报错。
    if (!claimToken) throw new Error("这一轮审查已经有在途派发，稍后再试");
    let handed = false;
    try {
      // run 行与 round 行**同一笔事务**:两次 insert 之间若断开,留下的正是「run 已经 reviewing、
      // 轮次行还没有」—— 那一刻责任没有任何落处,孤儿路照样收得了它。
      await db.transaction(async (transaction) => {
        await transaction.insert(freeReviewRuns).values(run);
        await transaction.insert(freeReviewRounds).values({
          id: id(), runId: run.id, round: 1, status: "reviewing", conclusion: null, startedAt: at, endedAt: null,
          dispatch: preparingReviewDispatch(generation, at,
            { retry: false, freshSession: freshSessionFor(run, 1, false) }),
        });
      }, { behavior: "immediate" });
      // 用户自己派的工作区审查：挂着的未裁定驳回被这一轮取代，记一笔并写时间线（见
      // supersedeOpenDisputes）。按预约开审（带 slotToken）的那一路在裁定闸后面，碰不到驳回。
      if (!opts.target && !opts.slotToken) {
        const { supersedeOpenDisputes } = await import("./free-review-dispute.js");
        await supersedeOpenDisputes(taskId, "派了新一轮审查");
      }
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
      handed = (await launchReviewRound(task, run,
        { responsibility: { generation, claimToken, since: at } })).dispatched;
    } catch (error) {
      // **带着这一次的代次**:省掉身份的那一笔会绕过代次闸,把现任打成 error、还按整轮收掉它的
      // 资源(第 2 轮审查问题 1)。
      await failReviewStart(run, error instanceof Error ? error.message : String(error), { generation });
      throw error;
    } finally {
      // 领证的人负责还证(同 nextRound 的 finally)。
      if (!handed) releaseReviewDispatchClaim(run.id, 1, claimToken);
    }
    return freeWorkflowState(taskId);
  } finally {
    releaseFreeWorkflowAction(taskId);
  }
  } finally {
    if (turn) releaseTurn(taskId, turn);
  }
}

/**
 * 启动期 / 周期对账的**旧入口**:本体已搬到 free-review-reconcile.ts,但 server/scripts 下一批既有
 * 回归仍从这里取它。那些脚本不在 tsconfig 的 include 里,出口一删它们只会在运行时拿到 undefined、
 * 报「不是函数」,构建一声不响 —— 所以出口留着,只做转发。
 *
 * 用懒加载而不是 `export … from`:那边静态 import 了这里的结算入口,静态转出会把刚切开的环接回去。
 */
export async function reconcileFreeReviews(ownerTaskId?: string): Promise<void> {
  await (await import("./free-review-reconcile.js")).reconcileFreeReviews(ownerTaskId);
}
