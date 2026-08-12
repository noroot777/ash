import type {
  AgentType,
  FreeReviewCheckMode,
  FreeReviewRun,
  FreeReviewRound,
  FreeWorkflowExecution,
  FreeWorkflowExecutionStatus,
  FreeWorkflowPreviewEvent,
  FreeWorkflowState,
  TaskStatus,
} from "@harness/shared";
import { FREE_REVIEW_CHECK_MODES } from "@harness/shared/free-workflow";
import { asc, desc, eq, inArray } from "drizzle-orm";
import { db } from "./db/index.js";
import { bus } from "./bus.js";
import {
  agents,
  freeReviewRounds,
  freeReviewRuns,
  freeWorkflowEvents,
  freeWorkflowStates,
  projects,
  tasks,
} from "./db/schema.js";
import { freeReviewScreenshots, readFreeReviewReport } from "./free-review-files.js";
import { headCommit, workspaceDirty, worktreePathFor } from "./git.js";
import { existsSync } from "node:fs";
import { readPreview } from "./preview.js";

export type FreeWorkflowApiState = Omit<FreeWorkflowState, "merge">;

// 每任务的状态修订号：**快照的版本必须是修订号，不能是 wall-clock**——同一毫秒内先后
// 两份快照会拿到相同的 Date.now()，前端没法分辨谁新（审查实测：同 ms 插入一条 passed
// review，旧快照照样覆盖新状态）。所有自由工作流状态变更都发 task.review 事件，订阅它
// 做单点递增；与 Date.now() 取 max 是为了跨 server 重启仍近似单调（重启后计数从当前
// 时刻起跳，必大于旧进程发出的任何版本）。
const revisions = new Map<string, number>();
const workspaceFingerprints = new Map<string, string>();
function revisionOf(taskId: string): number {
  const current = revisions.get(taskId);
  if (current != null) return current;
  const initial = Date.now();
  revisions.set(taskId, initial);
  return initial;
}
bus.subscribe((event) => {
  if (event.type !== "task.review") return;
  revisions.set(event.taskId, Math.max(revisionOf(event.taskId) + 1, Date.now()));
});

const EXECUTION_STATUSES = new Set<FreeWorkflowExecutionStatus>([
  "running", "completed", "failed", "canceled", "paused",
]);

function storedCheckMode(value: string | null | undefined): FreeReviewCheckMode {
  return (FREE_REVIEW_CHECK_MODES as readonly string[]).includes(value ?? "")
    ? value as FreeReviewCheckMode
    : "logic";
}

function storedRetryLimit(value: number | null | undefined): number {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 5 ? Number(value) : 1;
}

function taskExecutionStatus(status: TaskStatus): Exclude<FreeWorkflowExecutionStatus, "running"> {
  if (status === "failed") return "failed";
  if (status === "canceled") return "canceled";
  if (status === "paused") return "paused";
  return "completed";
}

function parseExecutionDetail(detail: string | null): { status: FreeWorkflowExecutionStatus; endedAt: string | null } {
  try {
    const value = JSON.parse(detail ?? "null") as { status?: string; endedAt?: unknown } | null;
    return {
      status: value?.status && EXECUTION_STATUSES.has(value.status as FreeWorkflowExecutionStatus)
        ? value.status as FreeWorkflowExecutionStatus
        : "running",
      endedAt: typeof value?.endedAt === "string" ? value.endedAt : null,
    };
  } catch {
    return { status: "running", endedAt: null };
  }
}

// 当前任务工作区的 HEAD 与是否有未提交改动，**纯只读**（绝不重建 worktree——这是状态
// 轮询，不是执行路径）。worktree 已被验收清理 → 双 null；非 worktree 任务读项目目录本身。
// dirty 必须一起报：只比 HEAD 会把「审查后只改了工作区没提交」误判成新鲜（失败开放）。
export async function workspaceStateOf(
  task: { id: string; projectId: string; useWorktree: boolean },
): Promise<{ head: string | null; dirty: boolean | null }> {
  const project = (await db.select({ repoPath: projects.repoPath }).from(projects)
    .where(eq(projects.id, task.projectId))).at(0);
  if (!project?.repoPath) return { head: null, dirty: null };
  const path = task.useWorktree ? worktreePathFor(project.repoPath, task.id) : project.repoPath;
  if (task.useWorktree && !existsSync(path)) return { head: null, dirty: null };
  const [head, dirty] = await Promise.all([headCommit(path), workspaceDirty(path)]);
  return { head, dirty };
}

export async function freeWorkflowState(taskId: string): Promise<FreeWorkflowApiState> {

  const [task, state, runs, profileRows, eventRows] = await Promise.all([
    db.select().from(tasks).where(eq(tasks.id, taskId)).then((rows) => rows.at(0)),
    db.select().from(freeWorkflowStates).where(eq(freeWorkflowStates.taskId, taskId)).then((rows) => rows.at(0)),
    db.select().from(freeReviewRuns).where(eq(freeReviewRuns.taskId, taskId)).orderBy(desc(freeReviewRuns.createdAt)),
    db.select({ id: agents.id, name: agents.name }).from(agents),
    db.select().from(freeWorkflowEvents).where(eq(freeWorkflowEvents.taskId, taskId))
      .orderBy(asc(freeWorkflowEvents.occurredAt)),
  ]);
  if (!task) throw new Error("任务不存在");
  const roundRows = runs.length
    ? await db.select().from(freeReviewRounds).where(inArray(freeReviewRounds.runId, runs.map((run) => run.id)))
      .orderBy(asc(freeReviewRounds.round))
    : [];
  const roundsByRun = new Map<string, typeof roundRows>();
  for (const round of roundRows) roundsByRun.set(round.runId, [...(roundsByRun.get(round.runId) ?? []), round]);
  const reviews: FreeReviewRun[] = runs.map((run) => ({
    id: run.id,
    reviewerId: run.reviewerId,
    reviewerName: run.reviewerName,
    agentType: run.agentType as AgentType,
    executorId: run.executorId,
    executorLabel: profileRows.find((profile) => profile.id === run.executorId)?.name ?? null,
    model: run.model,
    reasoningEffort: run.reasoningEffort,
    checkMode: run.checkMode as FreeReviewCheckMode,
    note: run.note,
    retryLimit: run.retryLimit,
    currentRound: run.currentRound,
    status: run.status as FreeReviewRun["status"],
    rounds: (roundsByRun.get(run.id) ?? []).map((round): FreeReviewRound => ({
      round: round.round,
      status: round.status as FreeReviewRound["status"],
      conclusion: round.conclusion as FreeReviewRound["conclusion"],
      reviewedCommit: round.reviewedCommit,
      reportMarkdown: readFreeReviewReport(taskId, run.id, round.round),
      screenshots: freeReviewScreenshots(taskId, run.id, round.round),
      startedAt: round.startedAt,
      endedAt: round.endedAt,
    })),
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    finishedAt: run.finishedAt,
  }));
  const reviewingSideTurn = reviews.some((run) => run.status === "reviewing");
  let executions: FreeWorkflowExecution[] = eventRows
    .filter((event) => event.kind === "task_execution")
    .map((event) => {
      const stored = parseExecutionDetail(event.detail);
      const staleRunning = stored.status === "running" && (task.status !== "running" || reviewingSideTurn);
      return {
        id: event.id,
        status: staleRunning ? taskExecutionStatus(task.status as TaskStatus) : stored.status,
        startedAt: event.occurredAt,
        endedAt: staleRunning ? task.endedAt ?? task.updatedAt : stored.endedAt,
      };
    });
  if (!executions.length) {
    const running = task.status === "running" && !reviewingSideTurn;
    const firstReviewAt = reviews.flatMap((run) => run.rounds).map((round) => round.startedAt).sort().at(0) ?? null;
    executions = [{
      id: `legacy-${taskId}`,
      status: running ? "running" : taskExecutionStatus(task.status as TaskStatus),
      startedAt: task.startedAt ?? task.createdAt,
      endedAt: running ? null : firstReviewAt ?? task.endedAt ?? task.updatedAt,
    }];
  }
  const preview = readPreview(taskId);
  const previewEvents: FreeWorkflowPreviewEvent[] = eventRows
    .filter((event) => event.kind === "preview_opened" || event.kind === "preview_closed")
    .map((event) => ({
      id: event.id,
      kind: event.kind as FreeWorkflowPreviewEvent["kind"],
      source: event.source as FreeWorkflowPreviewEvent["source"],
      detail: event.detail,
      occurredAt: event.occurredAt,
    }));
  // 预约可用的两种形态：续轮（runId 在，审查者配置取 run 行快照，profile 删了也能续）、
  // 新链（必须有 reviewerId）。两者都不在 → 脏 armed，对外一律当未预约。
  const reservationRunId = state?.reviewArmed ? state.reviewRunId ?? null : null;
  const reservationReviewerId = state?.reviewArmed ? state.selectedReviewerId ?? null : null;
  const reservationArmed = !!reservationRunId || !!reservationReviewerId;
  const workspace = await workspaceStateOf(task);
  // workspace（HEAD/dirty）不经 task.review 事件也会变（agent/用户直接改工作区）：指纹
  // 变化时也 bump，否则两份不同内容的快照拿同一版本、迟到的旧响应能抹掉「结论过期」
  // 警示（审查实测）。版本在指纹核对后取——DB 读取期间的变更会由随后的事件 bump +
  // SSE 重取覆盖，方向自愈。
  const fp = `${workspace.head}|${workspace.dirty}`;
  if (workspaceFingerprints.get(taskId) !== fp) {
    workspaceFingerprints.set(taskId, fp);
    revisions.set(taskId, Math.max(revisionOf(taskId) + 1, Date.now()));
  }
  const stateVersion = revisionOf(taskId);
  return {
    taskId,
    selectedReviewerId: state?.selectedReviewerId ?? null,
    stateVersion,
    workspaceHead: workspace.head,
    workspaceDirty: workspace.dirty,
    reviewReservation: {
      armed: reservationArmed,
      reviewerId: reservationReviewerId,
      checkMode: reservationArmed ? storedCheckMode(state?.reviewCheckMode) : null,
      retryLimit: reservationArmed ? storedRetryLimit(state?.reviewRetryLimit) : null,
      note: reservationArmed ? state?.reviewNote ?? null : null,
      runId: reservationRunId,
    },
    preview: {
      running: !!preview,
      url: preview?.url ?? null,
      port: preview?.port ?? null,
      command: preview?.cmd ?? null,
      startedAt: preview?.startedAt ?? null,
    },
    previewEvents,
    executions,
    reviews,
  };
}
