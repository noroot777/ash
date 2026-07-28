import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import { db } from "./db/index.js";
import { projects, tasks } from "./db/schema.js";
import { cleanupAcceptedTask, mergeTaskBranch, resolveTaskMergeTarget } from "./git.js";
import { taskBranchDiff } from "./git-diff.js";
import { publishTaskUpdated } from "./task-store.js";
import { setTaskStage } from "./task-stage.js";
import { appendTaskTimeline } from "./task-timeline.js";

type AcceptSuccess = {
  accepted: true;
  taskId: string;
  status: string;
  stage: "accepted";
  kind: "already_accepted" | "shared_team_worktree" | "in_place" | "isolated_worktree";
  targetBranch?: string;
  merge?: string;
  worktreePath?: string;
  worktreeRemoved?: boolean;
  branch?: string;
  branchDeleted?: boolean;
};

type AcceptFailure = {
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
};

export type AcceptTaskResult = AcceptSuccess | AcceptFailure;

const mergeLabel: Record<string, string> = {
  already_merged: "任务分支此前已合并",
  fast_forward: "纯 fast-forward",
  merge_commit: "--no-ff 合并提交",
};

async function acceptWithoutCleanup(
  task: typeof tasks.$inferSelect,
  kind: AcceptSuccess["kind"],
  message: string,
): Promise<AcceptSuccess> {
  await appendTaskTimeline(task.id, message);
  await setTaskStage(task.id, "accepted");
  await publishTaskUpdated(task.id);
  return { accepted: true, taskId: task.id, status: task.status, stage: "accepted", kind };
}

export async function acceptTask(taskId: string): Promise<AcceptTaskResult> {
  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!task) {
    return { accepted: false, httpStatus: 404, taskId, reason: "not_found", error: "not found" };
  }
  if (task.status === "running" || task.status === "queued") {
    return {
      accepted: false,
      httpStatus: 409,
      taskId,
      reason: "task_in_flight",
      error: "任务正在 running/queued，必须等当前执行结束后再验收",
      status: task.status,
    };
  }
  if (task.stage === "accepted") {
    await appendTaskTimeline(taskId, "验收动作重复调用：该任务此前已验收完成，本次未重复执行 git 操作。");
    return { accepted: true, taskId, status: task.status, stage: "accepted", kind: "already_accepted" };
  }

  const parent = task.parentId
    ? (await db.select().from(tasks).where(eq(tasks.id, task.parentId))).at(0)
    : null;
  if (task.parentId && parent?.mode === "team" && !task.useWorktree) {
    return acceptWithoutCleanup(
      task,
      "shared_team_worktree",
      "验收通过：该执行者使用共享团队 worktree，本次只标记 accepted；共享 worktree 与分支由团队调度台验收时统一合并、清理。",
    );
  }

  // A task that deliberately ran in the project's existing checkout has no
  // harness/<id> branch or harness-owned worktree to merge/delete.
  if (!task.useWorktree) {
    const subject = task.mode === "team" ? "团队调度台未启用共享独立 worktree" : "任务未使用独立 worktree";
    return acceptWithoutCleanup(
      task,
      "in_place",
      `验收通过：${subject}，代码已在原工作区中；无需执行分支合并或 worktree 清理，status 保持 ${task.status}。`,
    );
  }

  const project = (await db.select().from(projects).where(eq(projects.id, task.projectId))).at(0);
  if (!project) {
    return {
      accepted: false,
      httpStatus: 409,
      taskId,
      reason: "project_not_found",
      error: `任务所属项目 ${task.projectId} 不存在`,
      status: task.status,
    };
  }

  await appendTaskTimeline(
    taskId,
    `开始验收：准备将任务分支合并到 ${task.worktreeBase?.trim() || "项目当前分支"}；冲突时只报告并回滚，不会强制合并。`,
  );
  const merge = await mergeTaskBranch(project.repoPath, taskId, task.worktreeBase);

  // Retry after a previous partial success: stage=merged plus an already-removed
  // source branch means `git branch -d` did its job; finish the stage transition.
  if (!merge.ok && merge.reason === "source_branch_missing" && task.stage === "merged") {
    const targetBranch = merge.targetBranch ?? await resolveTaskMergeTarget(project.repoPath, task.worktreeBase);
    if (targetBranch) {
      await appendTaskTimeline(taskId, `任务分支已在先前清理中删除；沿用已记录的 merged 阶段，继续完成验收标记（目标 ${targetBranch}）。`);
      await setTaskStage(taskId, "accepted");
      await publishTaskUpdated(taskId);
      return {
        accepted: true,
        taskId,
        status: task.status,
        stage: "accepted",
        kind: "isolated_worktree",
        targetBranch,
        merge: "already_merged",
        branch: merge.sourceBranch,
        branchDeleted: true,
      };
    }
  }

  if (!merge.ok) {
    const detail = merge.conflictFiles?.length
      ? `；冲突文件：${merge.conflictFiles.join("、")}`
      : merge.dirtyFiles?.length
        ? `；脏文件：${merge.dirtyFiles.join("、")}`
        : "";
    await appendTaskTimeline(taskId, `验收未完成：${merge.message}${detail}。未强制合并，任务 status 保持 ${task.status}。`);
    return {
      accepted: false,
      httpStatus: 409,
      taskId,
      reason: merge.reason,
      error: merge.message,
      status: task.status,
      sourceBranch: merge.sourceBranch,
      targetBranch: merge.targetBranch,
      conflictFiles: merge.conflictFiles,
      dirtyFiles: merge.dirtyFiles,
      targetPath: merge.targetPath,
    };
  }

  await setTaskStage(taskId, "merged");
  await appendTaskTimeline(
    taskId,
    `合并完成：${merge.sourceBranch} → ${merge.targetBranch}（${mergeLabel[merge.method] ?? merge.method}）。`,
  );
  const cleanup = await cleanupAcceptedTask(project.repoPath, taskId, merge.targetBranch);
  if (!cleanup.ok) {
    await appendTaskTimeline(
      taskId,
      `验收清理未完成：${cleanup.message}。合并结果已保留，阶段停在 merged，status 保持 ${task.status}。`,
    );
    return {
      accepted: false,
      httpStatus: 409,
      taskId,
      reason: cleanup.reason,
      error: cleanup.message,
      status: task.status,
      sourceBranch: cleanup.sourceBranch,
      targetBranch: cleanup.targetBranch,
      worktreePath: cleanup.worktreePath,
    };
  }

  await appendTaskTimeline(
    taskId,
    `清理完成：${cleanup.worktreeRemoved ? `已删除 worktree ${cleanup.worktreePath}` : "任务 worktree 已不存在"}；` +
      `${cleanup.branchDeleted ? `已用 git branch -d 删除 ${cleanup.sourceBranch}` : `分支 ${cleanup.sourceBranch} 已不存在`}。`,
  );
  await setTaskStage(taskId, "accepted");
  await appendTaskTimeline(taskId, `验收完成：目标分支 ${merge.targetBranch}；任务 status 保持 ${task.status}。`);
  await publishTaskUpdated(taskId);
  return {
    accepted: true,
    taskId,
    status: task.status,
    stage: "accepted",
    kind: "isolated_worktree",
    targetBranch: merge.targetBranch,
    merge: merge.method,
    worktreePath: cleanup.worktreePath,
    worktreeRemoved: cleanup.worktreeRemoved,
    branch: cleanup.sourceBranch,
    branchDeleted: cleanup.branchDeleted,
  };
}

export function mountTaskAcceptanceRoutes(api: Hono): void {
  api.post("/tasks/:id/accept", async (c) => {
    const result = await acceptTask(c.req.param("id"));
    if (result.accepted) return c.json(result);
    const { httpStatus, ...body } = result;
    return httpStatus === 404 ? c.json(body, 404) : c.json(body, 409);
  });

  api.get("/tasks/:id/diff", async (c) => {
    const taskId = c.req.param("id");
    const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
    if (!task) return c.json({ error: "not found" }, 404);
    const project = (await db.select().from(projects).where(eq(projects.id, task.projectId))).at(0);
    if (!project) return c.json({ error: "project not found", projectId: task.projectId }, 404);
    return c.json(await taskBranchDiff(project.repoPath, taskId, task.worktreeBase));
  });
}
