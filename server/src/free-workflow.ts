import { readFileSync } from "node:fs";
import { extname } from "node:path";
import type {
  AgentType,
  FreeReviewCheckMode,
  FreeReviewDispatchInput,
  FreeReviewExecutorOverride,
  SessionRole,
  TaskStatus,
} from "@harness/shared";
import { AGENT_TYPES } from "@harness/shared";
import { FREE_REVIEW_CHECK_MODES } from "@harness/shared/free-workflow";
import { and, desc, eq } from "drizzle-orm";
import type { Hono } from "hono";
import { bus } from "./bus.js";
import { db } from "./db/index.js";
import {
  agents,
  freeReviewRounds,
  freeReviewRuns,
  freeWorkflowStates,
  projects,
  reviewerProfiles,
  scheduledMessages,
  tasks,
} from "./db/schema.js";
import { armFollowUpFreeReview, disarmFreeReviewReservation, readFreeReviewReservation, consumeFreeReviewReservation, startReservedFreeReview } from "./free-review-reservations.js";
import { freeManualRepairPrompt, freeRepairPrompt, freeReviewPrompt } from "./free-review-prompts.js";
export { freeManualRepairPrompt, freeRepairPrompt, freeReviewPrompt } from "./free-review-prompts.js";
import { mountFreePreviewRoutes } from "./free-workflow-preview.js";
import { releaseFreeWorkflowAction, tryAcquireFreeWorkflowAction } from "./free-workflow-lock.js";
import { freeReviewFile, freeReviewReportPath, readFreeReviewReport } from "./free-review-files.js";
import { freeWorkflowState, workspaceStateOf, type FreeWorkflowApiState } from "./free-workflow-state.js";
import { claimTurn, continueWhenIdle, isTurnClaimed, releaseTurn, turnRole, whenTurnIdle } from "./runs.js";
import { appendTaskTimeline } from "./task-timeline.js";
import { taskWorkspace } from "./task-workspace.js";
import { headCommit } from "./git.js";
import { REVIEW_MIME } from "./review-evidence.js";
import { BROWSER_VERIFICATION_REMINDER } from "./browser-verification-policy.js";
import { id, now } from "./util.js";

type TaskRow = typeof tasks.$inferSelect;
type ReviewRunRow = typeof freeReviewRuns.$inferSelect;

const MAX_RETRIES = 5;
const MAX_REVIEW_NOTE_LENGTH = 2_000;
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
async function reviewingRun(taskId: string): Promise<ReviewRunRow | null> {
  return (await db.select().from(freeReviewRuns)
    .where(and(eq(freeReviewRuns.taskId, taskId), eq(freeReviewRuns.status, "reviewing")))
    .orderBy(desc(freeReviewRuns.createdAt))
    .limit(1)).at(0) ?? null;
}

async function latestRun(taskId: string): Promise<ReviewRunRow | null> {
  return (await db.select().from(freeReviewRuns).where(eq(freeReviewRuns.taskId, taskId))
    .orderBy(desc(freeReviewRuns.createdAt)).limit(1)).at(0) ?? null;
}

/** 审查旁路回合是否正在进行（验收等不可逆操作要等它结束）。 */
export async function hasActiveFreeReview(taskId: string): Promise<boolean> {
  return !!(await reviewingRun(taskId));
}

export function assertBeforeAcceptance(task: { stage: string | null }): void {
  if (task.stage === "accepted" || task.stage === "merged") {
    throw new Error("任务已进入验收结果；如需继续修改，请先重新运行任务");
  }
}

export async function freeReviewResumeOptions(taskId: string) {
  const run = await reviewingRun(taskId);
  if (!run) return null;
  return {
    agent: run.agentType as AgentType,
    executorId: run.executorId,
    model: run.model,
    reasoningEffort: run.reasoningEffort,
    sessionRole: "reviewer" as const,
  };
}

export async function freeReviewReminder(taskId: string): Promise<string> {
  const run = await reviewingRun(taskId);
  if (!run) return "";
  return `自由工作流审查提醒：你正在执行第 ${run.currentRound} 轮${run.checkMode === "logic" ? "逻辑" : "语法"}审查。` +
    BROWSER_VERIFICATION_REMINDER +
    `报告必须写到 ${freeReviewReportPath(taskId, run.id, run.currentRound)}；结束前调用 report_stage(verified|verify_failed)，` +
    `不要调用 complete_task 或 accept_task。`;
}

function checkMode(value: unknown): FreeReviewCheckMode {
  if (typeof value !== "string" || !(FREE_REVIEW_CHECK_MODES as readonly string[]).includes(value)) {
    throw new Error("审查类型只能是 syntax 或 logic");
  }
  return value as FreeReviewCheckMode;
}

function retryLimit(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < 0 || Number(value) > MAX_RETRIES) {
    throw new Error(`自动复审轮数必须是 0-${MAX_RETRIES} 的整数`);
  }
  return Number(value);
}
function reviewNote(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== "string") throw new Error("审查附言必须是文本");
  const note = value.trim();
  if (note.length > MAX_REVIEW_NOTE_LENGTH) throw new Error(`审查附言不能超过 ${MAX_REVIEW_NOTE_LENGTH} 字`);
  return note || null;
}

function overrideText(value: unknown, max: number, field: string): string | null {
  if (value == null) return null;
  if (typeof value !== "string") throw new Error(`${field}必须是文本或 null`);
  const normalized = value.trim();
  if (normalized.length > max) throw new Error(`${field}不能超过 ${max} 个字符`);
  return normalized || null;
}

/**
 * 「这一次换个人/换个模型跑」的覆盖。**审查者配置一个字都不动**——用户在派审面上改了
 * 三段胶囊却选了「不保存」，改动就只能活在这一条审查里（预约则活在预约槽的四列里）。
 *
 * 校验与审查者配置同源（`reviewer-profiles.ts`）：执行器必须存在、且类型对得上，否则
 * 覆盖会把审查派给一个根本解析不出来的执行器，失败要等到真正开跑才暴露。
 */
async function reviewOverride(value: unknown): Promise<FreeReviewExecutorOverride | null> {
  if (value == null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("审查执行器覆盖必须是对象");
  const raw = value as Record<string, unknown>;
  const type = raw.agentType;
  if (typeof type !== "string" || !(AGENT_TYPES as readonly string[]).includes(type)) {
    throw new Error("覆盖的智能体类型无效");
  }
  const agentType = type as AgentType;
  const executorId = overrideText(raw.executorId, 100, "执行器");
  if (executorId) {
    const profile = (await db.select({ type: agents.type }).from(agents).where(eq(agents.id, executorId))).at(0);
    if (!profile) throw new Error("覆盖所选的执行器不存在");
    if (profile.type !== agentType) throw new Error(`覆盖所选的执行器属于 ${profile.type}，与 ${agentType} 不匹配`);
  }
  return {
    agentType,
    executorId,
    model: overrideText(raw.model, 160, "模型"),
    reasoningEffort: overrideText(raw.reasoningEffort, 60, "智能水平"),
  };
}

type ReviewerRunConfig = Pick<FreeReviewExecutorOverride, "agentType" | "executorId" | "model" | "reasoningEffort">;

/** 这次审查实际要跑的执行器：有覆盖就整套用覆盖的，没有就整套用审查者自己的。 */
function reviewRunConfig(
  profile: { agentType: string; executorId: string | null; model: string | null; reasoningEffort: string | null },
  override: FreeReviewExecutorOverride | null,
): ReviewerRunConfig {
  return override ?? {
    agentType: profile.agentType as AgentType,
    executorId: profile.executorId,
    model: profile.model,
    reasoningEffort: profile.reasoningEffort,
  };
}

/** 覆盖的人话形态：「codex · gpt-5.6-sol · high」，跟着有值的段走。 */
function overrideLabel(override: FreeReviewExecutorOverride): string {
  return `${override.agentType}${override.model ? ` · ${override.model}` : ""}` +
    `${override.reasoningEffort ? ` · ${override.reasoningEffort}` : ""}`;
}

/** 时间线里点明「这次跟审查者存的配置不一样」，否则用户只看到审查者名字，读不出跑的是谁。 */
function overrideSuffix(override: FreeReviewExecutorOverride | null): string {
  return override ? `（本次用 ${overrideLabel(override)}）` : "";
}
// 预约的产品语义：**下一次确认完成（confirmedDone → done）时消费**，不论那个回合是在
// 预约之前还是之后开跑的——任务正在跑（含已 claim、status 尚未落 running 的窗口）时挂
// 预约，本回合完成即触发审查，这正是「修复中先把复审预约上」的常规用法。所以这里刻意
// **不与 turn 互斥**；预约不动工作区、不投消息，写入本身没有并发危害。
async function reserveFreeReview(taskId: string, input: FreeReviewDispatchInput): Promise<FreeWorkflowApiState> {
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
    const last = await latestRun(taskId);
    if (task.status === "done" && last?.status !== "stopped") throw new Error("任务已完成，请直接派审查");
    const profile = (await db.select().from(reviewerProfiles).where(eq(reviewerProfiles.id, input.reviewerId))).at(0);
    if (!profile) throw new Error("所选审查者不存在");
    const mode = checkMode(input.checkMode);
    const retries = retryLimit(input.retryLimit);
    const note = reviewNote(input.note);
    const override = await reviewOverride(input.override);
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
    await appendTaskTimeline(taskId, `${existing?.reviewArmed ? "已更新" : "已预约"}完成后审查：${profile.name}${overrideSuffix(override)} · ` +
      `${mode === "logic" ? "逻辑检查" : "语法检查"} · 自动复审 ${retries} 轮${note ? " · 含附言" : ""}。`);
    bus.publish({ type: "task.review", taskId });
    return freeWorkflowState(taskId);
  } finally {
    releaseFreeWorkflowAction(taskId);
  }
}
async function cancelFreeReviewReservation(taskId: string): Promise<FreeWorkflowApiState> {
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
      await appendTaskTimeline(taskId, "已取消完成后审查预约。");
      bus.publish({ type: "task.review", taskId });
    }
    return freeWorkflowState(taskId);
  } finally {
    releaseFreeWorkflowAction(taskId);
  }
}

async function failReviewStart(run: ReviewRunRow, message: string): Promise<void> {
  const at = now();
  await db.update(freeReviewRounds).set({ status: "error", endedAt: at })
    .where(and(eq(freeReviewRounds.runId, run.id), eq(freeReviewRounds.round, run.currentRound)));
  await db.update(freeReviewRuns).set({ status: "failed", updatedAt: at, finishedAt: at })
    .where(eq(freeReviewRuns.id, run.id));
  await appendTaskTimeline(run.taskId, `自由工作流第 ${run.currentRound} 轮审查启动失败：${message}`);
  bus.publish({ type: "task.review", taskId: run.taskId });
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
export async function reconcileFreeReviews(): Promise<void> {
  const stuck = await db.select().from(freeReviewRuns).where(eq(freeReviewRuns.status, "reviewing"));
  for (const run of stuck) {
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
    // 已交卷（当前 round 有结论）且回合确实死了：直接补结算，不能因遗留的
    // question/等待态被永远跳过——那会让验收持续被 active review 409 挡住（审查实测）。
    const round = (await db.select().from(freeReviewRounds)
      .where(and(eq(freeReviewRounds.runId, run.id), eq(freeReviewRounds.round, run.currentRound)))).at(0);
    if (round?.conclusion) {
      await handleFreeWorkflowSettlement(run.taskId, task.status as TaskStatus, false, true, "reviewer");
      continue;
    }
    if (task.question || task.resumePrompt) continue;
    // /answer 可能已清掉 question、答复正躺在排队消息里等投递（reviewer 提问回合还没
    // release turn 时的正常路径）：那条链在等答案，不是孤儿——对账先于 scheduler 恢复
    // 投递，杀了它答复就无处可去了（审查实测）。
    const pendingReviewerAnswer = (await db.select({ id: scheduledMessages.id }).from(scheduledMessages)
      .where(and(
        eq(scheduledMessages.taskId, run.taskId),
        eq(scheduledMessages.status, "pending"),
        eq(scheduledMessages.sessionRole, "reviewer"),
      )).limit(1)).at(0);
    if (pendingReviewerAnswer) continue;
    await failReviewStart(run, "服务重启时审查回合尚未启动或已丢失；可再派一轮审查");
    await disarmFreeReviewReservation(run.taskId);
  }
}

async function launchReviewRound(task: TaskRow, run: ReviewRunRow): Promise<void> {
  const project = (await db.select().from(projects).where(eq(projects.id, task.projectId))).at(0);
  // 锚定本轮结论的基准：审查启动时工作区的 HEAD。之后代码变没变、结论新不新鲜，
  // 全靠它跟当前 HEAD 比，不靠任何状态字段。取不到（工作区缺失）就留 null。
  if (project) {
    const workspace = await taskWorkspace(task, project.repoPath).catch(() => null);
    const head = workspace ? await headCommit(workspace.path) : null;
    if (head) {
      await db.update(freeReviewRounds).set({ reviewedCommit: head })
        .where(and(eq(freeReviewRounds.runId, run.id), eq(freeReviewRounds.round, run.currentRound)));
    }
  }
  const prompt = await freeReviewPrompt(task, run, run.currentRound, project?.repoPath ?? "(项目已不存在)");
  await appendTaskTimeline(task.id, `自由工作流第 ${run.currentRound} 轮审查开始：${run.reviewerName} · ${run.checkMode === "logic" ? "逻辑检查" : "语法检查"}。`);
  bus.publish({ type: "task.review", taskId: task.id });
  continueWhenIdle(task.id, prompt, {
    system: "run",
    sideTurn: true,
    agent: run.agentType as AgentType,
    executorId: run.executorId,
    model: run.model,
    reasoningEffort: run.reasoningEffort,
    sessionRole: "reviewer",
    freshSession: run.currentRound === 1,
  }, (error) => failReviewStart(run, error));
}

async function nextRound(task: TaskRow, run: ReviewRunRow): Promise<void> {
  const round = run.currentRound + 1;
  const at = now();
  const nextRun = { ...run, status: "reviewing", currentRound: round, updatedAt: at };
  try {
    await db.insert(freeReviewRounds).values({
      id: id(), runId: run.id, round, status: "reviewing", conclusion: null, startedAt: at, endedAt: null,
    });
    await db.update(freeReviewRuns).set({ status: "reviewing", currentRound: round, updatedAt: at })
      .where(eq(freeReviewRuns.id, run.id));
    // 预约槽已由 startReservedFreeReview 在调用本函数**之前**按 CAS 消费掉（消费成功才
    // 会走到这里）。这里再无条件清一次，清掉的可能是用户中途保存的新预约（审查实测）。
    await launchReviewRound(task, nextRun);
  } catch (error) {
    await failReviewStart(nextRun, error instanceof Error ? error.message : String(error));
    throw error;
  }
}

export async function reportFreeReviewConclusion(
  taskId: string,
  stage: string,
  opts: { bySessionRecovery?: boolean } = {},
): Promise<{ runId: string; round: number } | null> {
  const run = await reviewingRun(taskId);
  if (!run) return null;
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
  await db.update(freeReviewRounds).set({ conclusion: stage })
    .where(and(eq(freeReviewRounds.runId, run.id), eq(freeReviewRounds.round, run.currentRound)));
  bus.publish({ type: "task.review", taskId });
  return { runId: run.id, round: run.currentRound };
}

// 自由工作流的回合结算只分两种回合，**按回合自己的 role 分流**，不按「库里有没有
// reviewing run」猜——派审请求可能在普通回合 claimTurn 之后才插入 reviewing run
// （TOCTOU），靠查库会把普通回合冒充成审查回合、把没有结论的审查链错杀成 failed：
// - role=reviewer（审查旁路回合）：按 conclusion 落 round/run，未通过且还有轮数时
//   发修复消息并挂**自动续轮预约**（runId）。
// - 其它 role（首次完成 / 修复 / 用户续聊）：confirmedDone 且落 done 时消费预约槽；
//   若此刻存在并发插入的 reviewing run，不碰它——审查消息还在排队，回合结束后照常开跑。
export async function handleFreeWorkflowSettlement(
  taskId: string,
  status: TaskStatus,
  confirmedDone: boolean,
  turnOk: boolean,
  role: SessionRole = "single",
): Promise<boolean> {
  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!task || task.workflowMode !== "free") return false;
  const run = await reviewingRun(taskId);
  if (role !== "reviewer") {
    if (task.question || task.resumePrompt) return true;
    // 存在 reviewing run 说明有一条审查在排队等这个回合结束（并发派审）：不结算它、
    // 也不消费预约（审查在跑时消费预约会双开）。
    if (run) return true;
    if (confirmedDone && status === "done") {
      // 槽由 startReservedFreeReview 按 CAS 消费（消费成功才启动），所以下面两条失败路径
      // 都不再补 disarm——那时槽已经空了，再清一次清掉的会是用户新保存的那条。
      await startReservedFreeReview(taskId, await readFreeReviewReservation(taskId), {
        continueRun: async (runId) => {
          const target = (await db.select().from(freeReviewRuns).where(eq(freeReviewRuns.id, runId))).at(0);
          if (!target || target.status !== "stopped") {
            throw new Error("预约续审的审查链已不在等待状态，预约已取消");
          }
          // 续轮起不来（典型：崩溃残留的半个 round 造成唯一键冲突，run 已被判 failed）是
          // 永久性失败：槽已消费，不会再有幽灵预约反复撞同一个错误。
          await nextRound(task, target);
        },
        startNew: async (input) => startFreeReview(taskId, {
          reviewerId: input.reviewerId,
          checkMode: checkMode(input.checkMode ?? "logic"),
          retryLimit: retryLimit(input.retryLimit ?? 1),
          note: reviewNote(input.note),
          // 预约时存下的「这次换个模型/智能水平跑」原样带上；执行器在这中间被删掉了
          // 就整套丢弃、退回审查者自己的配置，而不是让整条预约启动失败。
          override: await reviewOverride(input.override).catch(() => null),
        }),
      });
    }
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
  if ((task.question || task.resumePrompt) && !round.conclusion) return true;
  const at = now();
  const outcome = freeReviewOutcome({
    turnOk,
    conclusion: round.conclusion,
    currentRound: run.currentRound,
    retryLimit: run.retryLimit,
  });
  if (outcome === "failed") {
    await db.update(freeReviewRounds).set({ status: "error", endedAt: at }).where(eq(freeReviewRounds.id, round.id));
    await db.update(freeReviewRuns).set({ status: "failed", updatedAt: at, finishedAt: at }).where(eq(freeReviewRuns.id, run.id));
    await appendTaskTimeline(taskId, `自由工作流第 ${run.currentRound} 轮审查未能正常给出结论，已停止自动链。`);
    bus.publish({ type: "task.review", taskId });
    return true;
  }

  const passed = outcome === "passed";
  await db.update(freeReviewRounds).set({ status: passed ? "passed" : "failed", endedAt: at })
    .where(eq(freeReviewRounds.id, round.id));
  if (passed) {
    await db.update(freeReviewRuns).set({ status: "passed", updatedAt: at, finishedAt: at })
      .where(eq(freeReviewRuns.id, run.id));
    await appendTaskTimeline(taskId, `自由工作流第 ${run.currentRound} 轮审查通过（${run.reviewerName}）。`);
    bus.publish({ type: "task.review", taskId });
    return true;
  }

  // 未通过：run 一律落 stopped。链要不要自动续，看轮数——还有就发修复消息 + 挂续轮预约。
  await db.update(freeReviewRuns).set({ status: "stopped", updatedAt: at, finishedAt: at })
    .where(eq(freeReviewRuns.id, run.id));
  if (outcome === "repair") {
    // 只在槽空着时挂续轮预约（判据与理由见 armFollowUpFreeReview）：用户在这一轮审查
    // 期间自己存的那条预约是更新的意思，不能被自动续轮顶掉。
    const hooked = await armFollowUpFreeReview(taskId, run, at);
    await appendTaskTimeline(taskId, hooked
      ? `自由工作流第 ${run.currentRound} 轮审查未通过，意见已发回会话；修复确认完成后自动复审。`
      : `自由工作流第 ${run.currentRound} 轮审查未通过，意见已发回会话；你已另外预约了一条审查，下次确认完成时按你的预约执行（本链不再自动续轮）。`);
    bus.publish({ type: "task.review", taskId });
    // 刚挂上的这条续轮预约的版本令牌：投递失败要撤销的是**它**。迟到的无条件清槽会把
    // 用户在这期间保存的新预约一起删掉（审查实测同型交错）。没挂上时槽里那条是用户的，
    // 一个字都不能动。
    const armed = hooked ? await readFreeReviewReservation(taskId) : null;
    continueWhenIdle(taskId, freeRepairPrompt(taskId, run), { byBackend: true }, async (error) => {
      const canceled = armed ? await consumeFreeReviewReservation(taskId, armed) : null;
      await appendTaskTimeline(taskId, canceled
        ? `自由工作流审查意见投递失败：${error}；自动复审已取消，可手动按意见修复或再派审查。`
        : `自由工作流审查意见投递失败：${error}；请手动按意见修复或再派审查（预约已被更新，保留你最新的设置）。`);
      bus.publish({ type: "task.review", taskId });
    });
    return true;
  }

  await appendTaskTimeline(taskId, `自由工作流审查仍未通过，自动复审次数已用完；现在由你决定验收通过、按意见修复或再开一轮审查。`);
  bus.publish({ type: "task.review", taskId });
  return true;
}

async function startFreeReview(
  taskId: string,
  input: FreeReviewDispatchInput,
  opts: { holdTurn?: boolean } = {},
): Promise<FreeWorkflowApiState> {
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
  assertBeforeAcceptance(task);
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
    const profile = (await db.select().from(reviewerProfiles).where(eq(reviewerProfiles.id, input.reviewerId))).at(0);
    if (!profile) throw new Error("所选审查者不存在");
    const mode = checkMode(input.checkMode);
    const retries = retryLimit(input.retryLimit);
    const note = reviewNote(input.note);
    const override = await reviewOverride(input.override);
    const config = reviewRunConfig(profile, override);
    const at = now();
    const run: ReviewRunRow = {
      id: id(), taskId, reviewerId: profile.id, reviewerName: profile.name,
      agentType: config.agentType, executorId: config.executorId, model: config.model,
      reasoningEffort: config.reasoningEffort, checkMode: mode, note, retryLimit: retries,
      currentRound: 1, status: "reviewing", createdAt: at, updatedAt: at, finishedAt: null,
    };
    await db.insert(freeReviewRuns).values(run);
    try {
      await db.insert(freeReviewRounds).values({
        id: id(), runId: run.id, round: 1, status: "reviewing", conclusion: null, startedAt: at, endedAt: null,
      });
      // 派审即刻消费掉预约槽的一切（含覆盖四列）：这条 run 已经把配置冻结在自己行里，
      // 槽里留着旧覆盖只会在下次预约表单里冒出来。
      const cleared = {
        selectedReviewerId: profile.id, reviewArmed: false,
        reviewCheckMode: mode, reviewRetryLimit: retries, reviewNote: null, reviewRunId: null,
        reviewAgentType: null, reviewExecutorId: null, reviewModel: null, reviewReasoningEffort: null,
        updatedAt: at,
      };
      await db.insert(freeWorkflowStates).values({ taskId, ...cleared }).onConflictDoUpdate({
        target: freeWorkflowStates.taskId,
        set: cleared,
      });
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

// 「按意见修复」按钮 = 代发一条带报告链接的修复消息，**不翻转任何状态**。
// 「修复进行中」的显示靠任务本身 running 推导；修完要不要复审看预约槽。
// 在途标记只防「双击发两条」：消息真正投出（continueTask 开跑）就清掉，之后的重复
// 点击由 running 校验拦。内存即可——重启后排队回调本来就一起丢。
const pendingRepairs = new Set<string>();

/**
 * 「这份未通过报告仍对应当前代码」的完整证明，返回错误文案或 null（可修复）。
 * 入口校验与**投递回调**各跑一遍：入口占着 turn 校验（下面），但修复消息可能排在别的
 * 回合之后才真正投递——那个回合可以改代码，排队前的证明到投递时已经过期，不重验就会
 * 让实现 agent 按旧版报告改新版代码（审查实测：占住 turn 的普通回合结束后旧意见照发）。
 */
async function manualRepairBlocker(taskId: string): Promise<string | null> {
  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!task) return "任务不存在";
  if (task.stage === "accepted" || task.stage === "merged") return "任务已进入验收结果";
  if (await reviewingRun(taskId)) return "审查回合正在进行";
  const run = await latestRun(taskId);
  if (!run || run.status !== "stopped") return "最近一轮审查没有停在未通过状态";
  // 报告读取走安全解析（拒 symlink 祖先），且必须有非空正文——raw existsSync 会被
  // 换成 symlink 的 round 目录骗过，把外部路径写进发给实现 agent 的提示。
  if (!readFreeReviewReport(taskId, run.id, run.currentRound).trim()) {
    return "最近一轮审查报告不存在或为空";
  }
  // 只有能**证明**意见仍对应当前代码才放行修复（失败向「不确定」开，不向「没问题」开）：
  // 锚点缺失（老数据）、工作区读不到（已清理/非 git）都无从证明——正确动作是再派一轮
  // 「审查新改动」，而不是按一份无法核对的报告唤醒实现 agent 改代码。
  const concluded = (await db.select().from(freeReviewRounds)
    .where(and(eq(freeReviewRounds.runId, run.id), eq(freeReviewRounds.round, run.currentRound)))).at(0);
  if (!concluded?.reviewedCommit) return "这轮审查缺少基准 commit，无法确认意见仍对应当前代码";
  const workspace = await workspaceStateOf(task);
  if (!workspace.head || workspace.dirty == null) return "工作区不可读，无法确认审查意见仍对应当前代码";
  if (workspace.head !== concluded.reviewedCommit || workspace.dirty) {
    return "审查意见针对的代码已变化（新提交或未提交改动）";
  }
  return null;
}

async function deliverManualRepair(taskId: string, run: ReviewRunRow): Promise<void> {
  const abort = async (message: string) => {
    pendingRepairs.delete(taskId);
    await appendTaskTimeline(taskId, `自由工作流审查意见修复已取消：${message}；请再派一轮审查。`);
    bus.publish({ type: "task.review", taskId });
  };
  try {
    const blocker = await manualRepairBlocker(taskId);
    if (blocker) return void await abort(blocker);
    const { continueTask } = await import("./orchestrator.js");
    const delivered = await continueTask(taskId, freeManualRepairPrompt(taskId, run), { byBackend: true });
    if (delivered === false) await abort("回合被其它执行抢占，消息未能投递");
  } catch (error) {
    await abort(error instanceof Error ? error.message : String(error));
  }
}

export async function startManualFreeReviewRepair(
  taskId: string,
  opts: { holdTurn?: boolean } = {},
): Promise<FreeWorkflowApiState> {
  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!task) throw new Error("任务不存在");
  if (task.mode !== "single" || task.parentId || task.reviewOf || task.workflowMode !== "free") {
    throw new Error("当前任务不支持自由审查修复");
  }
  if (task.archived) throw new Error("归档任务不能发起修复");
  if (task.status === "backlog") throw new Error("任务尚未运行，没有可修复的审查意见");
  if (task.status === "running" || task.status === "queued") throw new Error("任务正在运行或排队，结束后再发起修复");
  if (task.question || task.resumePrompt) throw new Error("任务正等待答复或续跑，处理后再发起修复");
  // 与即时派审同级的原子互斥：只查 DB status 挡不住「普通回合已 claim、尚未落 running」
  // 的窗口（审查实测：窗口里修复照样 200 并排到那个回合之后）。占位身份 dispatch，
  // 校验与排队注册整段占住；释放后修复消息才可能真正投递，投递回调里再重验一遍锚点。
  const holdingTurn = opts.holdTurn === true;
  if (holdingTurn && !claimTurn(taskId, "dispatch")) {
    throw new Error("任务回合正在进行，结束后再发起修复");
  }
  try {
    if (!tryAcquireFreeWorkflowAction(taskId)) throw new Error("当前已有自由工作流操作正在进行");
    try {
      if (pendingRepairs.has(taskId)) throw new Error("修复消息已在途，等它开始执行后再操作");
      const blocker = await manualRepairBlocker(taskId);
      if (blocker) {
        throw new Error(blocker === "审查意见针对的代码已变化（新提交或未提交改动）"
          ? `${blocker}；请再派一轮审查，而不是按旧意见修复`
          : blocker === "最近一轮审查报告不存在或为空" ? `${blocker}，无法按意见发起修复`
          : blocker.includes("无法确认") ? `${blocker}；请再派一轮审查` : blocker);
      }
      const run = (await latestRun(taskId))!;
      await appendTaskTimeline(taskId, `已按自由工作流第 ${run.currentRound} 轮审查意见发起修复。`);
      bus.publish({ type: "task.review", taskId });
      pendingRepairs.add(taskId);
      whenTurnIdle(taskId, () => { void deliverManualRepair(taskId, run); });
      // 投递回调真正执行（continueTask 被调）时任务即进入 running；在那之前的窗口全靠
      // pendingRepairs 挡。这里挂一个同队回调来清标记。
      whenTurnIdle(taskId, () => pendingRepairs.delete(taskId));
      return await freeWorkflowState(taskId);
    } finally {
      releaseFreeWorkflowAction(taskId);
    }
  } finally {
    if (holdingTurn) releaseTurn(taskId);
  }
}

export function mountFreeWorkflowRoutes(api: Hono): void {
  mountFreePreviewRoutes(api);
  api.get("/tasks/:id/free-workflow", async (c) => {
    const task = (await db.select({ workflowMode: tasks.workflowMode }).from(tasks).where(eq(tasks.id, c.req.param("id")))).at(0);
    if (!task) return c.json({ error: "not found" }, 404);
    if (task.workflowMode !== "free") return c.json({ error: "当前任务不是自由工作流" }, 409);
    return c.json(await freeWorkflowState(c.req.param("id")));
  });

  api.post("/tasks/:id/free-workflow/review", async (c) => {
    try {
      const input = await c.req.json<FreeReviewDispatchInput>();
      // 原子互斥在 startFreeReview 内做（holdTurn 占住整段），不靠这里的一次性检查。
      return c.json(await startFreeReview(c.req.param("id"), input, { holdTurn: true }), 201);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 409);
    }
  });
  api.post("/tasks/:id/free-workflow/review/repair", async (c) => {
    // 原子互斥在 startManualFreeReviewRepair 内做（holdTurn 占住整段），同派审。
    try { return c.json(await startManualFreeReviewRepair(c.req.param("id"), { holdTurn: true })); }
    catch (error) { return c.json({ error: error instanceof Error ? error.message : String(error) }, 409); }
  });
  api.put("/tasks/:id/free-workflow/review-reservation", async (c) => {
    try { return c.json(await reserveFreeReview(c.req.param("id"), await c.req.json<FreeReviewDispatchInput>())); }
    catch (error) { return c.json({ error: error instanceof Error ? error.message : String(error) }, 409); }
  });
  api.delete("/tasks/:id/free-workflow/review-reservation", async (c) => {
    try { return c.json(await cancelFreeReviewReservation(c.req.param("id"))); }
    catch (error) { return c.json({ error: error instanceof Error ? error.message : String(error) }, 409); }
  });
  api.get("/tasks/:id/free-workflow/review-file", async (c) => {
    const taskId = c.req.param("id");
    const runId = c.req.query("run") ?? "";
    const round = Number(c.req.query("round"));
    const name = c.req.query("name") ?? "";
    const owned = Number.isInteger(round) && round > 0
      ? (await db.select({ id: freeReviewRounds.id }).from(freeReviewRounds)
        .innerJoin(freeReviewRuns, eq(freeReviewRounds.runId, freeReviewRuns.id))
        .where(and(eq(freeReviewRuns.id, runId), eq(freeReviewRuns.taskId, taskId), eq(freeReviewRounds.round, round)))
        .limit(1)).at(0)
      : null;
    const file = owned ? freeReviewFile(taskId, runId, round, name) : null;
    if (!file) return c.json({ error: "not found" }, 404);
    const mime = REVIEW_MIME[extname(file).toLowerCase()] ?? "application/octet-stream";
    return c.body(Uint8Array.from(readFileSync(file)), 200, { "content-type": mime });
  });
}
