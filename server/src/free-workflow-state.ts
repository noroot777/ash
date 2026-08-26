import type {
  AgentType,
  FreeReviewCheckMode,
  FreeReviewRun,
  FreeReviewRound,
  FreeWorkflowExecution,
  FreeWorkflowExecutionStatus,
  FreeWorkflowState,
  TaskStatus,
} from "@ash/shared";
import { FREE_REVIEW_CHECK_MODES } from "@ash/shared/free-workflow";
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
// task.status 也要 bump：executions 一列是从任务 status 推导的，只订阅 task.review 的话
// 「completed → failed」这类变化拿到同一版本，前端拒收相等版本的新快照——2.5s 轮询到的
// 正确状态被永久丢弃（审查实测）。下面的指纹核对是同一件事的自愈兜底。
bus.subscribe((event) => {
  if (event.type !== "task.review" && event.type !== "task.status") return;
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

// 快照必须与版本**一致**：读取分好几批（task/state/runs/rounds/Git），读取期间修订号变了
// 说明快照可能新旧混杂。判据是**读取开始前与结束后的修订号相同**——不能拿「结束后的
// revision === 快照自带版本」当判据：快照的版本取在读取末尾，事件落在「DB 已读旧、Git
// 未读完」的窗口时末尾自然拿到新号，旧 DB 内容反而配上新版本被放行（审查实测：旧
// reviews=[] 与随后正确响应版本完全相同）。指纹 bump（读取中发现工作区变了）同样打破
// 「前后相同」，自动进重读。版本一律用**读取前**的号：内容至少包含该时刻已发布的全部
// 状态，配读取前的号只会低报——旧响应盖它时用的是更大的版本，方向安全。
export async function freeWorkflowState(taskId: string): Promise<FreeWorkflowApiState> {
  let last: FreeWorkflowApiState | null = null;
  let lastBefore = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = revisionOf(taskId);
    const snapshot = await readFreeWorkflowState(taskId);
    if (revisionOf(taskId) === before) return { ...snapshot, stateVersion: before };
    last = snapshot;
    lastBefore = before;
  }
  // 持续高频变更下的兜底：内容可能混杂，配读取前的小版本——宁可被更新的响应覆盖，
  // 不能拿可能混杂的内容反压新状态。
  return { ...last!, stateVersion: lastBefore };
}

async function readFreeWorkflowState(taskId: string): Promise<FreeWorkflowApiState> {
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
    target: run.targetKind === "accepted_merge" && run.targetBranch && run.targetBaseCommit && run.targetCommit
      ? {
          kind: "accepted_merge" as const,
          branch: run.targetBranch,
          baseCommit: run.targetBaseCommit,
          mergeCommit: run.targetCommit,
          repairTaskId: run.repairTaskId ?? null,
        }
      : { kind: "workspace" as const },
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
  // 预约可用的两种形态：续轮（runId 在，审查者配置取 run 行快照，profile 删了也能续）、
  // 新链（必须有 reviewerId）。两者都不在 → 脏 armed，对外一律当未预约。
  const reservationRunId = state?.reviewArmed ? state.reviewRunId ?? null : null;
  const reservationReviewerId = state?.reviewArmed ? state.selectedReviewerId ?? null : null;
  const reservationArmed = !!reservationRunId || !!reservationReviewerId;
  // 执行器覆盖只对「新链」预约有意义：续轮的执行器早已冻结在 run 行里，槽里也不该有。
  // 四列一套读，agentType 为空即没有覆盖。
  const reservationOverride = reservationArmed && !reservationRunId && state?.reviewAgentType
    ? {
      agentType: state.reviewAgentType as AgentType,
      executorId: state.reviewExecutorId ?? null,
      model: state.reviewModel ?? null,
      reasoningEffort: state.reviewReasoningEffort ?? null,
    }
    : null;
  const workspace = await workspaceStateOf(task);
  // workspace（HEAD/dirty）不经 task.review 事件也会变（agent/用户直接改工作区）：指纹
  // 变化时也 bump，否则两份不同内容的快照拿同一版本、迟到的旧响应能抹掉「结论过期」
  // 警示（审查实测）。版本在指纹核对后取——DB 读取期间的变更会由随后的事件 bump +
  // SSE 重取覆盖，方向自愈。
  const fp = `${workspace.head}|${workspace.dirty}|${task.status}`;
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
      override: reservationOverride,
      runId: reservationRunId,
    },
    preview: {
      running: !!preview,
      url: preview?.url ?? null,
      port: preview?.port ?? null,
      command: preview?.cmd ?? null,
      startedAt: preview?.startedAt ?? null,
    },
    executions,
    reviews,
  };
}
