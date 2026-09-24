// 删一条任务:连带收掉的那一堆关联状态,以及 `DELETE /tasks/:id` 本体。
//
// 从 task-routes.ts 拆出来,是因为那份文件已经顶到 700 行上限,而「删除」是其中自洽度
// 最高的一块:它跟建任务、改任务不共用任何局部状态,只靠 `mountTaskDeleteRoutes(api)`
// 挂回去。`deleteTaskAssociations` 跟着一起搬——项目删除那条路(project-routes.ts)也
// 调它,留在建任务那份文件里只会让人以为它跟建任务有关。
import type { TaskWorkspaceDiscardResult } from "@ash/shared";
import { eq, inArray } from "drizzle-orm";
import type { Hono } from "hono";
import { db } from "./db/index.js";
import { freeReviewDebateTurns, freeReviewDebates, freeReviewRounds, freeReviewRuns, freeWorkflowEvents, freeWorkflowStates, groups, noteTasks, projects, queueItems, schedules, scheduledMessages, sessions, tasks, teamInbound, taskBranchReceipts } from "./db/schema.js";
import { deleteTaskSideChats } from "./chat/lifecycle.js";
import { branchDeletionRejection, deleteTaskBranchRefs } from "./task-branch-plan.js";
import { taskBusyRejection } from "./task-busy.js";
import { withRepoLock } from "./repo-lock.js";
import { detectTaskWorkspace, discardTaskWorkspace } from "./workspace-cleanup.js";

// 任务行删除时连关联状态一起收：自由审查链(run/round)、预约槽、事件、排队/定时消息、
// 随手记回链。没有 FK cascade,只删任务行会留下孤儿——审查实测:等答复的审查在任务
// 删除后永远停在 reviewing,答复消息永远 pending(投递时任务已不存在)。
export async function deleteTaskAssociations(taskId: string): Promise<void> {
  await deleteTaskSideChats(taskId);
  await deleteTaskBranchRefs(taskId);
  await db.delete(taskBranchReceipts).where(eq(taskBranchReceipts.taskId, taskId));
  const runIds = (await db.select({ id: freeReviewRuns.id }).from(freeReviewRuns)
    .where(eq(freeReviewRuns.taskId, taskId))).map((run) => run.id);
  // 辩论挂在轮次上（debates → debate_turns），得先于 rounds 收掉，否则 round 行一删
  // 就再没有任何线索能找到那些发言行。
  const debateIds = (await db.select({ id: freeReviewDebates.id }).from(freeReviewDebates)
    .where(eq(freeReviewDebates.taskId, taskId))).map((debate) => debate.id);
  if (debateIds.length) {
    await db.delete(freeReviewDebateTurns).where(inArray(freeReviewDebateTurns.debateId, debateIds));
  }
  await db.delete(freeReviewDebates).where(eq(freeReviewDebates.taskId, taskId));
  if (runIds.length) await db.delete(freeReviewRounds).where(inArray(freeReviewRounds.runId, runIds));
  await db.delete(freeReviewRuns).where(eq(freeReviewRuns.taskId, taskId));
  await db.delete(freeWorkflowStates).where(eq(freeWorkflowStates.taskId, taskId));
  await db.delete(freeWorkflowEvents).where(eq(freeWorkflowEvents.taskId, taskId));
  await db.delete(scheduledMessages).where(eq(scheduledMessages.taskId, taskId));
  await db.delete(teamInbound).where(eq(teamInbound.taskId, taskId)); // 调度台还没送出的入站消息
  await db.delete(noteTasks).where(eq(noteTasks.taskId, taskId));
  // 会话行、定时计划、队列位也一起收：孤儿 cron 每个 tick 都会被扫到再查不到任务，
  // 队列残位会顶住后续推进（审查实测：删除后 sessionRows/scheduleRows 各剩 1）。
  await db.delete(sessions).where(eq(sessions.taskId, taskId));
  await db.delete(schedules).where(eq(schedules.taskId, taskId));
  await db.delete(queueItems).where(eq(queueItems.taskId, taskId));
  // 团队派活自建的内部组（groups.owner_task_id=本任务）：GET /groups 默认过滤掉它们，
  // 留下来就是永远不可见也没入口清理的孤儿（审查实测：删 lead 后两个内部组原样保留）。
  await db.delete(groups).where(eq(groups.ownerTaskId, taskId));
}

// 删除任务。`worktree=1` / `branch=1` 表示用户在确认框里勾了「连 worktree 和分支
// 一起删」,`force=1` 是看过第一次失败之后的再来一次(--force / -D)。
//
// 顺序刻意是「先删任务行,再清 git」:删任务是用户的主要意图,git 那边失败(worktree
// 脏、分支未合并)不该把它一起挡回去 —— 结果原样回给 UI,由用户决定强制删还是留着。
export function mountTaskDeleteRoutes(api: Hono): void {
api.delete("/tasks/:id", async (c) => {
  const tid = c.req.param("id");
  const existing = (await db.select().from(tasks).where(eq(tasks.id, tid))).at(0);
  const deletionProject = existing ? (await db.select().from(projects).where(eq(projects.id, existing.projectId))).at(0) : undefined;
  return withRepoLock(deletionProject?.repoPath, async () => {
  // 正在跑 / 占着 turn / 在验收 / 有 child 在飞的任务都不能整行删掉,判据与理由见
  // task-busy.ts —— 项目级的两个入口用的是同一份,别在这里再拼一遍。
  const busy = await taskBusyRejection(tid, "删除");
  if (busy) return c.json(busy, 409);
  // 都停了则连 children 行一并删,不留悬空 parentId。
  const children = existing ? await db.select().from(tasks).where(eq(tasks.parentId, tid)) : [];
  const project = existing
    ? (await db.select().from(projects).where(eq(projects.id, existing.projectId))).at(0)
    : undefined;
  for (const row of [existing, ...children]) {
    if (!row || !project) continue;
    const rejection = await branchDeletionRejection(project.repoPath, row.id);
    if (rejection) return c.json(rejection, 409);
  }
  const wantWorktree = c.req.query("worktree") === "1";
  const wantBranch = c.req.query("branch") === "1";
  // children 的 Git 工作区必须与它们的行一起处理：只删行的话，独立 worktree/分支会变成
  // 数据库里查无此任务的孤儿资源，leftover 检测（按父任务 id）也看不到（审查实测）。
  const childCleanups: (TaskWorkspaceDiscardResult & { taskId: string })[] = [];
  for (const child of children) {
    await deleteTaskAssociations(child.id);
    await db.delete(tasks).where(eq(tasks.id, child.id));
    if (project && child.useWorktree && (wantWorktree || wantBranch)) {
      childCleanups.push({
        taskId: child.id,
        ...await discardTaskWorkspace(project.repoPath, child.id, {
          worktree: wantWorktree,
          branch: wantBranch,
          force: c.req.query("force") === "1",
        }),
      });
    }
  }
  await deleteTaskAssociations(tid);
  await db.delete(tasks).where(eq(tasks.id, tid));
  let cleanup: TaskWorkspaceDiscardResult | null = null;
  if (project && (wantWorktree || wantBranch)) {
    cleanup = await discardTaskWorkspace(project.repoPath, tid, {
      worktree: wantWorktree,
      branch: wantBranch,
      force: c.req.query("force") === "1",
    });
  }
  // 清理之后仍然剩下的东西:没勾选、或勾了但 git 拒绝。UI 据此决定要不要继续追问。
  // children 的残留一并报（它们的行已删，之后没有别的入口能发现这些资源）。
  const leftover = project ? await detectTaskWorkspace(project.repoPath, tid) : null;
  const childLeftovers = project
    ? (await Promise.all(children.map(async (child) => ({
        taskId: child.id,
        leftover: await detectTaskWorkspace(project.repoPath, child.id),
      })))).filter((entry) => entry.leftover && (entry.leftover.path || entry.leftover.branch))
    : [];
  return c.json({
    deleted: true, leftover, cleanup,
    // 连删的全部行（父 + children）：前端按它同步本地任务集合——只摘父 id 会把
    // children 留成刷新前的幽灵任务（审查实测）。
    deletedTaskIds: [tid, ...children.map((child) => child.id)],
    ...(childCleanups.length ? { childCleanups } : {}),
    ...(childLeftovers.length ? { childLeftovers } : {}),
  });
  });
});
}
