import { eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { projects, taskBranchReceipts, tasks } from "./db/schema.js";
import { acceptedHeadRef } from "./task-branch-plan.js";
import { execFileText as exec } from "./exec.js";
import { expandHome } from "./git.js";

// 父任务续聊会清当前验收牌子；已合入版本的对应关系继续供旧子任务核对。
export async function recordBranchReceipt(taskId: string, verifiedMerge = false): Promise<void> {
  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!task?.acceptedSourceCommit || !task.acceptedMergeCommit || (!verifiedMerge && (!task.acceptedBaseCommit
    || task.acceptedMergeCommit === task.acceptedBaseCommit)) || !task.acceptedTargetBranch) return;
  await db.insert(taskBranchReceipts).values({
    id: `${taskId}:${task.acceptedSourceCommit}:${task.acceptedMergeCommit}`,
    taskId, sourceCommit: task.acceptedSourceCommit,
    mergeCommit: task.acceptedMergeCommit, targetBranch: task.acceptedTargetBranch,
  }).onConflictDoNothing();
  if (verifiedMerge && task.worktreeStartCommit) {
    const project = (await db.select().from(projects).where(eq(projects.id, task.projectId))).at(0);
    if (project) await exec("git", ["-C", expandHome(project.repoPath), "update-ref", acceptedHeadRef(taskId), task.acceptedMergeCommit]);
  }
}
