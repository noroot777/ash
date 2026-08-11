import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import type {
  AgentType,
  FreeReviewCheckMode,
  FreeReviewDispatchInput,
  TaskStatus,
} from "@harness/shared";
import { FREE_REVIEW_CHECK_MODES } from "@harness/shared/free-workflow";
import { and, desc, eq } from "drizzle-orm";
import type { Hono } from "hono";
import { bus } from "./bus.js";
import { db } from "./db/index.js";
import {
  freeReviewRounds,
  freeReviewRuns,
  freeWorkflowStates,
  projects,
  reviewerProfiles,
  tasks,
} from "./db/schema.js";
import { startReservedFreeReview } from "./free-review-reservations.js";
import { recordFreePreviewEvent } from "./free-workflow-events.js";
import { releaseFreeWorkflowAction, tryAcquireFreeWorkflowAction } from "./free-workflow-lock.js";
import {
  freeReviewEvidenceDir,
  freeReviewFile,
  freeReviewReportPath,
} from "./free-review-files.js";
import { freeWorkflowState, type FreeWorkflowApiState } from "./free-workflow-state.js";
import { continueWhenIdle, whenTurnIdle } from "./runs.js";
import { appendTaskTimeline } from "./task-timeline.js";
import { taskWorkspace } from "./task-workspace.js";
import { headCommit } from "./git.js";
import { startPreview, stopPreview, type PreviewStep } from "./preview.js";
import { REVIEW_MIME } from "./review-evidence.js";
import { reviewRequestReference } from "./review-request-context.js";
import { BROWSER_VERIFICATION_POLICY, BROWSER_VERIFICATION_REMINDER } from "./browser-verification-policy.js";
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

function assertBeforeAcceptance(task: TaskRow): void {
  if (task.stage === "accepted" || task.stage === "merged") {
    throw new Error("任务已进入验收结果；如需继续修改，请先重新运行任务");
  }
}

export async function isFreeReviewTurn(taskId: string): Promise<boolean> {
  return !!(await reviewingRun(taskId));
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
    const at = now();
    const existing = (await db.select({ reviewArmed: freeWorkflowStates.reviewArmed }).from(freeWorkflowStates)
      .where(eq(freeWorkflowStates.taskId, taskId))).at(0);
    // 用户手动保存的预约是一条**新链**：清掉可能挂着的自动续轮 runId，改按新配置开新 run。
    await db.insert(freeWorkflowStates).values({
      taskId, selectedReviewerId: profile.id, reviewArmed: true, reviewCheckMode: mode, reviewRetryLimit: retries,
      reviewNote: note, reviewRunId: null,
      updatedAt: at,
    }).onConflictDoUpdate({
      target: freeWorkflowStates.taskId,
      set: {
        selectedReviewerId: profile.id, reviewArmed: true, reviewCheckMode: mode,
        reviewRetryLimit: retries, reviewNote: note, reviewRunId: null, updatedAt: at,
      },
    });
    await appendTaskTimeline(taskId, `${existing?.reviewArmed ? "已更新" : "已预约"}完成后审查：${profile.name} · ` +
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
        .set({ reviewArmed: false, reviewNote: null, reviewRunId: null, updatedAt: at })
        .where(eq(freeWorkflowStates.taskId, taskId));
      await appendTaskTimeline(taskId, "已取消完成后审查预约。");
      bus.publish({ type: "task.review", taskId });
    }
    return freeWorkflowState(taskId);
  } finally {
    releaseFreeWorkflowAction(taskId);
  }
}

export async function freeReviewPrompt(task: TaskRow, run: ReviewRunRow, round: number, repoPath: string): Promise<string> {
  const dir = freeReviewEvidenceDir(task.id, run.id, round);
  const requirements = await reviewRequestReference(task, dir);
  const focus = run.checkMode === "syntax"
    ? "本轮只做语法与机械质量检查：编译、类型、lint、格式、明显的 API/导入错误和相关测试。不要扩张成产品方案评审。"
    : "本轮做逻辑审查：除编译与测试外，重点找行为错误、状态竞争、失败路径、边界条件和回归风险。涉及可见前端改动时必须启动页面真实操作并截图；是否还需要其它截图由你按证据价值判断。";
  const note = run.note ? `\n\n用户附言（作为审查重点补充，不覆盖上述职责）：\n${run.note}` : "";
  return `【自由工作流 · 第 ${round} 轮审查】\n` +
    `你是独立审查者，不是继续实现需求。默认产物可能有问题，主动寻找能复现的缺陷。\n\n` +
    `任务：${task.id}\n${requirements}\n\n` +
    `${focus}${note}\n\n先检查 ${repoPath} 中的真实 git status、diff 和提交，再选择验证命令。` +
    `必须真实运行与风险相称的检查。\n\n${BROWSER_VERIFICATION_POLICY}` +
    `一旦用了 playwright，结束前清掉工作区产物；所有验证临时服务和浏览器进程都必须停掉。\n\n` +
    `证据必须落盘：报告写到 ${freeReviewReportPath(task.id, run.id, round)}；截图如有必要放在同一目录。证据不要 git add/commit。\n\n` +
    `结束前调用 report_stage(taskId="${task.id}", stage="verified"|"verify_failed") 给出结论。` +
    `这是旁路审查回合，不要调用 complete_task，也不要调用 accept_task。`;
}

export function freeRepairPrompt(taskId: string, run: ReviewRunRow): string {
  const dir = freeReviewEvidenceDir(taskId, run.id, run.currentRound);
  return `【自由工作流审查未通过 · 第 ${run.currentRound} 轮】\n` +
    `请先完整读取 [report.md](${freeReviewReportPath(taskId, run.id, run.currentRound)})，再按报告修复，不要扩大原任务边界。` +
    `修复完成并验证后调用 complete_task(taskId="${taskId}")；harness 随后会自动派同一位审查者复审。\n\n` +
    `证据目录：${dir}`;
}

export function freeManualRepairPrompt(taskId: string, run: ReviewRunRow): string {
  const dir = freeReviewEvidenceDir(taskId, run.id, run.currentRound);
  return `【自由工作流审查未通过 · 自动复审已停止】\n` +
    `请先完整读取 [report.md](${freeReviewReportPath(taskId, run.id, run.currentRound)})，再按第 ${run.currentRound} 轮意见修复，不要扩大原任务边界。` +
    `修复完成并验证后调用 complete_task(taskId="${taskId}")。本次不会擅自增加审查轮数；` +
    `如果用户在修复期间预约了复审，完成后按预约开始，否则等待用户决定再次审查或验收。\n\n` +
    `证据目录：${dir}`;
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
    // 续轮开跑即消费预约槽（自动续轮预约就是为这一步挂上的）。
    await db.update(freeWorkflowStates)
      .set({ reviewArmed: false, reviewRunId: null, updatedAt: at })
      .where(eq(freeWorkflowStates.taskId, task.id));
    await launchReviewRound(task, nextRun);
  } catch (error) {
    await failReviewStart(nextRun, error instanceof Error ? error.message : String(error));
    throw error;
  }
}

export async function reportFreeReviewConclusion(
  taskId: string,
  stage: string,
): Promise<{ runId: string; round: number } | null> {
  const run = await reviewingRun(taskId);
  if (!run) return null;
  if (stage !== "verified" && stage !== "verify_failed") {
    throw new Error("自由工作流审查回合只能上报 verified 或 verify_failed");
  }
  await db.update(freeReviewRounds).set({ conclusion: stage })
    .where(and(eq(freeReviewRounds.runId, run.id), eq(freeReviewRounds.round, run.currentRound)));
  bus.publish({ type: "task.review", taskId });
  return { runId: run.id, round: run.currentRound };
}

// 自由工作流的回合结算只分两种回合：
// - 审查旁路回合（run 处于 reviewing）：按 conclusion 落 round/run，未通过且还有轮数时
//   发修复消息并挂**自动续轮预约**（runId）。
// - 普通任务回合（首次完成 / 修复 / 用户续聊，不作区分）：confirmedDone 且落 done 时
//   消费预约槽——runId 在就续那条链的下一轮，否则按用户预约开新链。
// 没有任何「修复中/结论过期」状态要翻转：那些全是推导出来的展示。
export async function handleFreeWorkflowSettlement(
  taskId: string,
  status: TaskStatus,
  confirmedDone: boolean,
  turnOk: boolean,
): Promise<boolean> {
  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!task || task.workflowMode !== "free") return false;
  const run = await reviewingRun(taskId);
  if (!run) {
    if (task.question || task.resumePrompt) return true;
    if (confirmedDone && status === "done") {
      const reservation = (await db.select({
        armed: freeWorkflowStates.reviewArmed, reviewerId: freeWorkflowStates.selectedReviewerId,
        checkMode: freeWorkflowStates.reviewCheckMode, retryLimit: freeWorkflowStates.reviewRetryLimit,
        note: freeWorkflowStates.reviewNote, runId: freeWorkflowStates.reviewRunId,
      }).from(freeWorkflowStates).where(eq(freeWorkflowStates.taskId, taskId))).at(0);
      await startReservedFreeReview(taskId, reservation, {
        continueRun: async (runId) => {
          const target = (await db.select().from(freeReviewRuns).where(eq(freeReviewRuns.id, runId))).at(0);
          if (!target || target.status !== "stopped") {
            throw new Error("预约续审的审查链已不在等待状态");
          }
          await nextRound(task, target);
        },
        startNew: (input) => startFreeReview(taskId, {
          reviewerId: input.reviewerId,
          checkMode: checkMode(input.checkMode ?? "logic"),
          retryLimit: retryLimit(input.retryLimit ?? 1),
          note: reviewNote(input.note),
        }),
      });
    }
    return true;
  }

  // ── 审查旁路回合结算 ──
  if (task.question || task.resumePrompt) return true;
  const round = (await db.select().from(freeReviewRounds)
    .where(and(eq(freeReviewRounds.runId, run.id), eq(freeReviewRounds.round, run.currentRound)))).at(0);
  if (!round) return true;
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
    await db.insert(freeWorkflowStates).values({
      taskId, selectedReviewerId: run.reviewerId, reviewArmed: true,
      reviewCheckMode: run.checkMode, reviewRetryLimit: run.retryLimit,
      reviewNote: null, reviewRunId: run.id, updatedAt: at,
    }).onConflictDoUpdate({
      target: freeWorkflowStates.taskId,
      set: { reviewArmed: true, reviewRunId: run.id, updatedAt: at },
    });
    await appendTaskTimeline(taskId, `自由工作流第 ${run.currentRound} 轮审查未通过，意见已发回会话；修复确认完成后自动复审。`);
    bus.publish({ type: "task.review", taskId });
    continueWhenIdle(taskId, freeRepairPrompt(taskId, run), { byBackend: true }, async (error) => {
      const failedAt = now();
      await db.update(freeWorkflowStates)
        .set({ reviewArmed: false, reviewRunId: null, updatedAt: failedAt })
        .where(eq(freeWorkflowStates.taskId, taskId));
      await appendTaskTimeline(taskId, `自由工作流审查意见投递失败：${error}；自动复审已取消，可手动按意见修复或再派审查。`);
      bus.publish({ type: "task.review", taskId });
    });
    return true;
  }

  await appendTaskTimeline(taskId, `自由工作流审查仍未通过，自动复审次数已用完；现在由你决定验收通过、按意见修复或再开一轮审查。`);
  bus.publish({ type: "task.review", taskId });
  return true;
}

async function startFreeReview(taskId: string, input: FreeReviewDispatchInput): Promise<FreeWorkflowApiState> {
  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!task) throw new Error("任务不存在");
  if (task.mode !== "single" || task.parentId || task.reviewOf) throw new Error("自由工作流只适用于普通单任务");
  if (task.workflowMode !== "free") throw new Error("当前任务不是自由工作流");
  if (task.archived) throw new Error("归档任务不能派审");
  if (task.status === "backlog") throw new Error("任务尚未运行，完成实现后再派审");
  if (task.status === "running" || task.status === "queued") throw new Error("任务正在运行或排队，结束后再派审");
  assertBeforeAcceptance(task);
  if (!tryAcquireFreeWorkflowAction(taskId)) throw new Error("当前已有自由工作流操作正在进行");
  try {
    if (await reviewingRun(taskId)) throw new Error("审查回合正在进行，结束后再派审");
    const profile = (await db.select().from(reviewerProfiles).where(eq(reviewerProfiles.id, input.reviewerId))).at(0);
    if (!profile) throw new Error("所选审查者不存在");
    const mode = checkMode(input.checkMode);
    const retries = retryLimit(input.retryLimit);
    const note = reviewNote(input.note);
    const at = now();
    const run: ReviewRunRow = {
      id: id(), taskId, reviewerId: profile.id, reviewerName: profile.name,
      agentType: profile.agentType, executorId: profile.executorId, model: profile.model,
      reasoningEffort: profile.reasoningEffort, checkMode: mode, note, retryLimit: retries,
      currentRound: 1, status: "reviewing", createdAt: at, updatedAt: at, finishedAt: null,
    };
    await db.insert(freeReviewRuns).values(run);
    try {
      await db.insert(freeReviewRounds).values({
        id: id(), runId: run.id, round: 1, status: "reviewing", conclusion: null, startedAt: at, endedAt: null,
      });
      await db.insert(freeWorkflowStates).values({
        taskId, selectedReviewerId: profile.id, reviewArmed: false,
        reviewCheckMode: mode, reviewRetryLimit: retries, reviewNote: null, reviewRunId: null,
        updatedAt: at,
      }).onConflictDoUpdate({
        target: freeWorkflowStates.taskId,
        set: {
          selectedReviewerId: profile.id, reviewArmed: false,
          reviewCheckMode: mode, reviewRetryLimit: retries, reviewNote: null, reviewRunId: null, updatedAt: at,
        },
      });
      await launchReviewRound(task, run);
    } catch (error) {
      await failReviewStart(run, error instanceof Error ? error.message : String(error));
      throw error;
    }
    return freeWorkflowState(taskId);
  } finally {
    releaseFreeWorkflowAction(taskId);
  }
}

// 「按意见修复」按钮 = 代发一条带报告链接的修复消息，**不翻转任何状态**。
// 「修复进行中」的显示靠任务本身 running 推导；修完要不要复审看预约槽。
// 在途标记只防「双击发两条」：消息真正投出（continueTask 开跑）就清掉，之后的重复
// 点击由 running 校验拦。内存即可——重启后排队回调本来就一起丢。
const pendingRepairs = new Set<string>();
async function startManualFreeReviewRepair(taskId: string): Promise<FreeWorkflowApiState> {
  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!task) throw new Error("任务不存在");
  if (task.mode !== "single" || task.parentId || task.reviewOf || task.workflowMode !== "free") {
    throw new Error("当前任务不支持自由审查修复");
  }
  if (task.archived) throw new Error("归档任务不能发起修复");
  if (task.status === "backlog") throw new Error("任务尚未运行，没有可修复的审查意见");
  if (task.status === "running" || task.status === "queued") throw new Error("任务正在运行或排队，结束后再发起修复");
  if (task.question || task.resumePrompt) throw new Error("任务正等待答复或续跑，处理后再发起修复");
  if (!tryAcquireFreeWorkflowAction(taskId)) throw new Error("当前已有自由工作流操作正在进行");
  try {
    assertBeforeAcceptance(task);
    if (pendingRepairs.has(taskId)) throw new Error("修复消息已在途，等它开始执行后再操作");
    if (await reviewingRun(taskId)) throw new Error("审查回合正在进行，结束后再发起修复");
    const run = await latestRun(taskId);
    if (!run || run.status !== "stopped") throw new Error("最近一轮审查没有停在未通过状态");
    if (!existsSync(freeReviewReportPath(taskId, run.id, run.currentRound))) {
      throw new Error("最近一轮审查报告不存在，无法按意见发起修复");
    }
    await appendTaskTimeline(taskId, `已按自由工作流第 ${run.currentRound} 轮审查意见发起修复。`);
    bus.publish({ type: "task.review", taskId });
    pendingRepairs.add(taskId);
    continueWhenIdle(taskId, freeManualRepairPrompt(taskId, run), { byBackend: true }, async (error) => {
      pendingRepairs.delete(taskId);
      await appendTaskTimeline(taskId, `自由工作流审查意见修复启动失败：${error}`);
      bus.publish({ type: "task.review", taskId });
    });
    // continueWhenIdle 的回调真正执行（continueTask 被调）时任务即进入 running；
    // 在那之前的窗口全靠 pendingRepairs 挡。这里挂一个同队回调来清标记。
    whenTurnIdle(taskId, () => pendingRepairs.delete(taskId));
    return freeWorkflowState(taskId);
  } finally {
    releaseFreeWorkflowAction(taskId);
  }
}

function previewCommand(cwd: string): string {
  const packageJson = join(cwd, "package.json");
  if (!existsSync(packageJson)) throw new Error("工作区没有 package.json，无法自动判断预览命令");
  let scripts: Record<string, unknown> = {};
  try { scripts = JSON.parse(readFileSync(packageJson, "utf8")).scripts ?? {}; }
  catch { throw new Error("package.json 无法读取，无法自动判断预览命令"); }
  const script = typeof scripts.dev === "string" ? "dev" : typeof scripts.start === "string" ? "start" : null;
  if (!script) throw new Error("package.json 没有 dev 或 start 脚本，请先在项目中补充预览命令");
  if (existsSync(join(cwd, "pnpm-lock.yaml"))) return `pnpm run ${script}`;
  if (existsSync(join(cwd, "yarn.lock"))) return `yarn ${script}`;
  return `npm run ${script}`;
}

async function startFreePreview(taskId: string) {
  if (!tryAcquireFreeWorkflowAction(taskId)) throw new Error("当前已有自由工作流操作正在进行");
  try {
    const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
    if (!task || task.workflowMode !== "free" || task.mode !== "single" || task.parentId || task.reviewOf) {
      throw new Error("当前任务不支持自由预览");
    }
    if (task.status === "backlog") throw new Error("任务尚未运行，完成实现后再打开预览");
    if (task.status === "running" || task.status === "queued") throw new Error("任务正在修改代码，结束后再打开预览");
    assertBeforeAcceptance(task);
    const project = (await db.select().from(projects).where(eq(projects.id, task.projectId))).at(0);
    if (!project) throw new Error("项目不存在");
    const workspace = await taskWorkspace(task, project.repoPath);
    const command = previewCommand(workspace.path);
    const step: PreviewStep = {
      id: "free-preview", kind: "preview",
      p: { cmd: command, mode: "frontend", ready: "port+log", life: "task" },
      fail: null,
    };
    const result = await startPreview(taskId, step, workspace.path);
    if (!result.ok) throw new Error(result.reason);
    await recordFreePreviewEvent(taskId, {
      kind: "preview_opened",
      source: "user",
      detail: result.record.url ?? result.record.cmd,
      occurredAt: result.record.startedAt,
    });
    await appendTaskTimeline(taskId, `自由工作流预览已打开：${result.record.url ?? command}`);
    bus.publish({ type: "task.review", taskId });
    return result.record;
  } finally {
    releaseFreeWorkflowAction(taskId);
  }
}

export function mountFreeWorkflowRoutes(api: Hono): void {
  api.get("/tasks/:id/free-workflow", async (c) => {
    const task = (await db.select({ workflowMode: tasks.workflowMode }).from(tasks).where(eq(tasks.id, c.req.param("id")))).at(0);
    if (!task) return c.json({ error: "not found" }, 404);
    if (task.workflowMode !== "free") return c.json({ error: "当前任务不是自由工作流" }, 409);
    return c.json(await freeWorkflowState(c.req.param("id")));
  });

  api.post("/tasks/:id/free-workflow/review", async (c) => {
    try {
      return c.json(await startFreeReview(c.req.param("id"), await c.req.json<FreeReviewDispatchInput>()), 201);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 409);
    }
  });
  api.post("/tasks/:id/free-workflow/review/repair", async (c) => {
    try { return c.json(await startManualFreeReviewRepair(c.req.param("id"))); }
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
  api.post("/tasks/:id/free-workflow/preview", async (c) => {
    try {
      const record = await startFreePreview(c.req.param("id"));
      return c.json({ running: true, url: record.url, port: record.port, command: record.cmd, startedAt: record.startedAt });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 409);
    }
  });

  api.delete("/tasks/:id/free-workflow/preview", async (c) => {
    const taskId = c.req.param("id");
    const task = (await db.select({
      workflowMode: tasks.workflowMode, mode: tasks.mode, parentId: tasks.parentId, reviewOf: tasks.reviewOf,
    }).from(tasks).where(eq(tasks.id, taskId))).at(0);
    if (!task || task.workflowMode !== "free" || task.mode !== "single" || task.parentId || task.reviewOf) {
      return c.json({ error: "当前任务不支持自由预览" }, 409);
    }
    if (!tryAcquireFreeWorkflowAction(taskId)) return c.json({ error: "当前已有自由工作流操作正在进行" }, 409);
    try {
      const stopped = await stopPreview(taskId, "用户关闭了自由工作流预览", "user");
      bus.publish({ type: "task.review", taskId });
      return c.json({ stopped });
    } finally {
      releaseFreeWorkflowAction(taskId);
    }
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
