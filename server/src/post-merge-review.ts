import type { FreeReviewDispatchInput, Task } from "@ash/shared";
import { and, eq } from "drizzle-orm";
import { bus } from "./bus.js";
import { db } from "./db/index.js";
import { freeReviewRounds, freeReviewRuns, projects, tasks } from "./db/schema.js";
import { freeReviewReportPath, readFreeReviewReport } from "./free-review-files.js";
import { releaseFreeWorkflowAction, tryAcquireFreeWorkflowAction } from "./free-workflow-lock.js";
import { startFreeReview } from "./free-workflow.js";
import { isAncestor } from "./git-accept.js";
import { expandHome, localBranchExists } from "./git.js";
import { appendTaskTimeline } from "./task-timeline.js";
import { createTasks, enrichTasks } from "./task-store.js";
import { id, now } from "./util.js";

export async function startPostMergeReview(taskId: string, input: FreeReviewDispatchInput) {
  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!task) throw new Error("任务不存在");
  if (task.workflowMode !== "free" || task.mode !== "single" || task.parentId || task.reviewOf) {
    throw new Error("当前任务不支持合并结果审查");
  }
  if (task.stage !== "accepted") throw new Error("任务尚未完成验收，不能审查合并结果");
  const branch = task.acceptedTargetBranch;
  const baseCommit = task.acceptedBaseCommit;
  const mergeCommit = task.acceptedMergeCommit;
  if (!branch || !baseCommit || !mergeCommit) throw new Error("本次验收没有完整的合并快照，无法发起合并结果审查");
  if (baseCommit === mergeCommit) throw new Error("本次验收没有产生可审查的合并变更");
  const project = (await db.select({ repoPath: projects.repoPath }).from(projects).where(eq(projects.id, task.projectId))).at(0);
  if (!project) throw new Error("项目不存在");
  const repo = expandHome(project.repoPath);
  if (!(await localBranchExists(repo, branch))) throw new Error(`验收目标分支 ${branch} 已不存在`);
  if (!(await isAncestor(repo, baseCommit, mergeCommit))) throw new Error("验收快照的 commit 区间无效或已不可读");
  if (!(await isAncestor(repo, mergeCommit, branch))) {
    throw new Error(`验收合并 commit 已不在 ${branch} 上，先确认目标分支是否被重置`);
  }
  return startFreeReview(taskId, { ...input, retryLimit: 0 }, {
    holdTurn: true,
    target: { kind: "accepted_merge", branch, baseCommit, mergeCommit },
  });
}

async function existingRepairTask(taskId: string, runId: string, repairTaskId: string | null): Promise<Task | null> {
  const rows = repairTaskId
    ? await db.select().from(tasks).where(eq(tasks.id, repairTaskId))
    : await db.select().from(tasks).where(eq(tasks.originTaskId, taskId));
  const row = repairTaskId ? rows.at(0) : rows.find((candidate) => candidate.body.includes(`审查链：${runId}`));
  return row ? (await enrichTasks([row]))[0] ?? null : null;
}

export async function createPostMergeRepairTask(taskId: string, runId: string): Promise<Task> {
  if (!runId) throw new Error("缺少合并结果审查 runId");
  if (!tryAcquireFreeWorkflowAction(taskId)) throw new Error("当前已有自由工作流操作正在进行");
  try {
    const [source, run] = await Promise.all([
      db.select().from(tasks).where(eq(tasks.id, taskId)).then((rows) => rows.at(0)),
      db.select().from(freeReviewRuns).where(and(eq(freeReviewRuns.id, runId), eq(freeReviewRuns.taskId, taskId)))
        .then((rows) => rows.at(0)),
    ]);
    if (!source) throw new Error("任务不存在");
    if (!run || run.targetKind !== "accepted_merge" || !run.targetBranch || !run.targetBaseCommit || !run.targetCommit) {
      throw new Error("指定记录不是该任务的合并结果审查");
    }
    const existing = await existingRepairTask(taskId, runId, run.repairTaskId);
    if (existing) {
      if (!run.repairTaskId) {
        await db.update(freeReviewRuns).set({ repairTaskId: existing.id, updatedAt: now() }).where(eq(freeReviewRuns.id, run.id));
        bus.publish({ type: "task.review", taskId });
      }
      return existing;
    }
    const round = (await db.select().from(freeReviewRounds)
      .where(and(eq(freeReviewRounds.runId, run.id), eq(freeReviewRounds.round, run.currentRound)))).at(0);
    if (run.status !== "stopped" || round?.conclusion !== "verify_failed") {
      throw new Error("只有未通过的合并结果审查才能创建修复任务");
    }
    if (!readFreeReviewReport(taskId, run.id, run.currentRound).trim()) throw new Error("合并结果审查报告不存在或为空");
    const at = now();
    const repairId = id();
    const report = freeReviewReportPath(taskId, run.id, run.currentRound);
    const [created] = await createTasks([{
      id: repairId,
      projectId: source.projectId,
      groupId: source.groupId,
      parentId: null,
      title: `修复合并结果：${source.title}`,
      body: `修复已验收任务「${source.title}」的合并结果问题。\n\n` +
        `审查链：${run.id}\n目标分支：${run.targetBranch}\n合并区间：${run.targetBaseCommit}..${run.targetCommit}\n` +
        `审查报告：[report.md](${report})\n\n` +
        "请完整读取报告，从固定的合并 commit 创建的独立 worktree 中修复并验证。不要修改或重新打开原已验收任务。",
      mode: "single",
      status: "backlog",
      labels: source.labels,
      dependsOn: "[]",
      resumeDependsOn: "[]",
      agentType: source.agentType,
      executorId: source.executorId,
      model: source.model,
      reasoningEffort: source.reasoningEffort,
      autoTitle: false,
      createdAt: at,
      updatedAt: at,
      useWorktree: true,
      worktreeBase: run.targetCommit,
      originTaskId: source.id,
      workflowMode: "free",
    }]);
    if (!created) throw new Error("修复任务创建失败");
    await db.update(freeReviewRuns).set({ repairTaskId: created.id, updatedAt: now() }).where(eq(freeReviewRuns.id, run.id));
    await appendTaskTimeline(taskId, `已从合并结果审查创建独立修复任务：${created.title}（${created.id}）。`);
    bus.publish({ type: "task.review", taskId });
    return created;
  } finally {
    releaseFreeWorkflowAction(taskId);
  }
}
