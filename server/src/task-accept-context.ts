// 验收入口在拿仓库锁之前要知道的那几样（锁哪个仓库、是不是自由工作流）。从 task-accept.ts 拆出来。
import { eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { projects, tasks } from "./db/schema.js";

// 整段验收都在仓库锁里跑:并行点下的多个验收**排队依次合并**,而不是一起
// 冲进同一个 `.git`(见 repo-lock.ts 的三类事故)。整段而非只锁 merge 的原因是
// 守卫判断不能过期 —— acceptTaskUnlocked 拿到锁后才重新读任务与项目,所以排在
// 后面的验收看到的是前一个合并完成后的世界(目标分支已前进、stage 已更新)。
export async function acceptanceContext(taskId: string): Promise<{
  repoPath: string | null;
  freeWorkflow: boolean;
  status?: string;
}> {
  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  // 没有独立 worktree 的任务只改 stage,不碰 git,不必占用仓库锁。
  if (!task) return { repoPath: null, freeWorkflow: false };
  if (!task.useWorktree) {
    return { repoPath: null, freeWorkflow: task.workflowMode === "free", status: task.status };
  }
  const project = (await db.select().from(projects).where(eq(projects.id, task.projectId))).at(0);
  return {
    repoPath: project?.repoPath ?? null,
    freeWorkflow: task.workflowMode === "free",
    status: task.status,
  };
}
