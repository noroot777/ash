// 验收前的「在飞检查」（从 task-accept.ts 拆出，纯行数拆分）：任务或共享执行者正在
// running/queued、或回合已被 claim（DB status 尚未落 running 的窗口），都算在飞——
// 后者只看 status 会在 agent 已开跑时合并并删掉它正在用的 worktree（审查实测复现）。
import { eq, or } from "drizzle-orm";
import { db } from "./db/index.js";
import { tasks } from "./db/schema.js";
import type { ConflictHandoff } from "./accept-conflict.js";
import { isTurnClaimed } from "./runs.js";

export type AcceptWarning = {
  reason: "temporary_cleanup_failed";
  message: string;
  worktreePath: string;
};

export type InFlightTask = {
  id: string;
  title: string;
  status: string;
  role: "task" | "shared_worker";
};

export type AcceptFailure = {
  accepted: false;
  httpStatus: 404 | 409;
  taskId: string;
  reason: string;
  error: string;
  status?: string;
  sourceBranch?: string;
  targetBranch?: string | null;
  conflictFiles?: string[];
  dirtyFiles?: string[];
  targetPath?: string;
  worktreePath?: string;
  /** 冲突已交给来源任务的 agent 去解(只在 merge_conflict 时出现) */
  conflictHandoff?: ConflictHandoff;
  phase?: "initial" | "before_accept" | "before_merge" | "before_cleanup";
  inFlightTasks?: InFlightTask[];
  warnings?: AcceptWarning[];
};

export async function acceptanceState(taskId: string): Promise<{
  task: typeof tasks.$inferSelect | null;
  inFlightTasks: InFlightTask[];
}> {
  const related = await db
    .select()
    .from(tasks)
    .where(or(eq(tasks.id, taskId), eq(tasks.parentId, taskId)));
  const task = related.find((row) => row.id === taskId) ?? null;
  if (!task) return { task: null, inFlightTasks: [] };

  // DB status 之外还要看 turn 锁：续聊从 claimTurn 到写 running 之间有真实窗口，
  // 只看 status 会在 agent 已开跑时合并并删掉它正在用的 worktree（审查实测复现）。
  const inFlight = (row: typeof tasks.$inferSelect) =>
    row.status === "running" || row.status === "queued" || isTurnClaimed(row.id);
  const inFlightTasks: InFlightTask[] = [];
  if (inFlight(task)) {
    inFlightTasks.push({ id: task.id, title: task.title, status: task.status, role: "task" });
  }
  if (task.mode === "team") {
    const workers = related.filter((row) => row.parentId === task.id);
    for (const worker of workers) {
      if (!worker.useWorktree && inFlight(worker)) {
        inFlightTasks.push({ id: worker.id, title: worker.title, status: worker.status, role: "shared_worker" });
      }
    }
  }
  return { task, inFlightTasks };
}

export async function acceptanceGuard(
  taskId: string,
  phase: AcceptFailure["phase"],
): Promise<{ task: typeof tasks.$inferSelect | null; failure: AcceptFailure | null }> {
  const state = await acceptanceState(taskId);
  if (!state.task) {
    return {
      task: null,
      failure: { accepted: false, httpStatus: 404, taskId, reason: "not_found", error: "not found", phase },
    };
  }
  if (state.inFlightTasks.length === 0) return { task: state.task, failure: null };

  const sharedWorkers = state.inFlightTasks.filter((item) => item.role === "shared_worker");
  const listed = state.inFlightTasks.map((item) => `${item.title}（${item.id}，${item.status}）`).join("、");
  return {
    task: state.task,
    failure: {
      accepted: false,
      httpStatus: 409,
      taskId,
      reason: sharedWorkers.length > 0 ? "shared_team_workers_in_flight" : "task_in_flight",
      error: sharedWorkers.length > 0
        ? `共享团队 worktree 仍被 running/queued 执行者使用，必须等它们结束后再验收：${listed}`
        : `任务正在 running/queued，必须等当前执行结束后再验收：${listed}`,
      status: state.task.status,
      phase,
      inFlightTasks: state.inFlightTasks,
    },
  };
}
