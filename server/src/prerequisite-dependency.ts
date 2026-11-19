// 按前置开工的任务在验收时等什么：每条前置交给它的那一版（`task_prerequisites.inherited_commit`）都进了
// 目标分支，它才能合。判据逐条复用单父那一份（task-branch-plan.ts `inheritedDependency`），这里只负责
// 「好几条时取最要紧的那条、把没好的都说出来」，以及删分支时谁还在等它。
import { and, eq, isNotNull } from "drizzle-orm";
import type { BranchDependency } from "@navi/shared/branch-plan";
import { db } from "./db/index.js";
import { taskPrerequisites, tasks } from "./db/schema.js";
import type { BranchPlanReads } from "./branch-plan-reads.js";
import { inheritedDependency, type BranchTask } from "./task-branch-plan.js";

// 等前置合入 > 说不清 > 需要更新基线：先等的没等到，更新基线也没用。
const SEVERITY: Record<BranchDependency["state"], number> = { waiting: 3, unknown: 2, needs_update: 1, ready: 0 };

async function inheritedEdges(where: ReturnType<typeof eq>) {
  return db.select().from(taskPrerequisites).where(and(where, isNotNull(taskPrerequisites.inheritedCommit)));
}

/**
 * undefined = 这条任务不是按前置开工的（交回单父 / 老关系那一套）；null = 不用等（不用 worktree，没有分支可合）。
 */
export async function prerequisiteDependency(task: BranchTask, repo: string, reads?: BranchPlanReads): Promise<BranchDependency | null | undefined> {
  const edges = await inheritedEdges(eq(taskPrerequisites.taskId, task.id));
  if (!edges.length) return undefined;
  if (!task.useWorktree) return null;
  const results: BranchDependency[] = [];
  for (const edge of edges) {
    const parent = (await db.select().from(tasks).where(eq(tasks.id, edge.prerequisiteId))).at(0);
    results.push(await inheritedDependency(task, repo, edge.prerequisiteId, parent, edge.inheritedCommit!, reads));
  }
  const open = results.filter((result) => result.state !== "ready").sort((a, b) => SEVERITY[b.state] - SEVERITY[a.state]);
  if (!open.length) {
    return { taskId: results[0]!.taskId, title: results.map((result) => result.title).join("、"), state: "ready",
      message: `前置的成果都已进入 ${task.mergeTargetBranch}` };
  }
  const worst = open[0]!;
  return open.length === 1 ? worst : { ...worst, message: open.map((result) => result.message).join("；") };
}

/** 手里有 `taskId` 的代码、而这份代码还没进各自目标分支的下游（已验收的不算）。 */
export async function prerequisiteDependentsBlocking(repo: string, taskId: string): Promise<BranchTask[]> {
  const blocked: BranchTask[] = [];
  const parent = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  for (const edge of await inheritedEdges(eq(taskPrerequisites.prerequisiteId, taskId))) {
    const row = (await db.select().from(tasks).where(eq(tasks.id, edge.taskId))).at(0);
    if (!row || row.stage === "accepted" || !row.useWorktree) continue;
    if ((await inheritedDependency(row, repo, taskId, parent, edge.inheritedCommit!)).state !== "ready") blocked.push(row);
  }
  return blocked;
}

/** 这条任务的开工起点是不是按前置定的。 */
export async function startsFromPrerequisites(taskId: string): Promise<boolean> {
  return (await inheritedEdges(eq(taskPrerequisites.taskId, taskId))).length > 0;
}

/** 下游的基线换过了（更新基线、恢复开工记录）：每条前置交给它的那一版一并换成新起点 —— 新起点就在目标分支上。 */
export async function rebaseInheritedCommits(taskId: string, start: string, transaction: Pick<typeof db, "update"> = db): Promise<void> {
  await transaction.update(taskPrerequisites).set({ inheritedCommit: start })
    .where(and(eq(taskPrerequisites.taskId, taskId), isNotNull(taskPrerequisites.inheritedCommit)));
}
