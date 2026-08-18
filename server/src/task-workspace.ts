import { eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { tasks } from "./db/schema.js";
import { prepareWorktree, resolveWorkspace, type Workspace } from "./git.js";
import { now } from "./util.js";

type WorkspaceTask = Pick<
  typeof tasks.$inferSelect,
  "id" | "projectId" | "parentId" | "useWorktree" | "worktreeBase" | "reviewOf"
>;

// base 降级(登记的基线分支已经没了，这次按仓库当前 HEAD 起的)必须**落回任务行**，
// 不能只在返回值里说一句：diff 和验收各自拿 `task.worktreeBase` 再解析一次目标分支
// (`git-diff.ts` 的 resolveTaskMergeTarget、`task-accept.ts` 冻结验收目标)，库里还留着
// 那个已删的名字的话，这一轮是起来了，用户下一步看 diff 会得到 target_branch_missing、
// 点验收被「目标本地分支不存在」挡回 —— 等于把「起不来」换成了「起得来但交不掉」。
//
// 两处不写：
//   · 降级的不是这个任务自己登记的那个 base(团队执行者那条路传的是共享分支)——那不是
//     它的登记值，写进去等于凭空给它按了个显式基线。
//   · 仓库处于 detached HEAD，`used` 是 "HEAD" 而不是分支名 —— 写进去只会把一个解析
//     不出分支的值固化下来。
async function persistBaseFallback(task: WorkspaceTask, ws: Workspace): Promise<void> {
  const fallback = ws.baseFallback;
  if (!fallback || fallback.used === "HEAD") return;
  if ((task.worktreeBase ?? "").trim() !== fallback.requested) return;
  await db
    .update(tasks)
    .set({ worktreeBase: fallback.used, updatedAt: now() })
    .where(eq(tasks.id, task.id));
  fallback.persisted = true;
}

async function directWorkspace(task: WorkspaceTask, repoPath: string): Promise<Workspace> {
  if (!task.useWorktree) return resolveWorkspace(repoPath, task.id);
  const ws = await prepareWorktree(repoPath, task.id, task.worktreeBase);
  await persistBaseFallback(task, ws);
  return ws;
}

// Resolve the cwd for every executable task through one path.
//
// A team task may opt into its own worktree. Its workers default to the exact
// same workspace, so lead and workers see one filesystem. A worker that opts
// into worktree isolation still gets the conventional project-level
// `.worktrees/<workerId>` path (so detection/cleanup keeps working), but branches
// from the team's shared branch by default.
export async function taskWorkspace(task: WorkspaceTask, repoPath: string): Promise<Workspace> {
  // Reviewers operate on the exact files under review. Re-resolving the target
  // through this same function covers isolated worker worktrees and team-shared
  // workspaces without copying or creating a reviewer-owned worktree.
  if (task.reviewOf) {
    const target = (await db.select().from(tasks).where(eq(tasks.id, task.reviewOf))).at(0);
    if (target && target.projectId === task.projectId && !target.reviewOf) {
      return taskWorkspace(target, repoPath);
    }
  }
  if (!task.parentId) return directWorkspace(task, repoPath);

  const parent = (await db.select().from(tasks).where(eq(tasks.id, task.parentId))).at(0);
  if (!parent || parent.mode !== "team" || parent.projectId !== task.projectId) {
    return directWorkspace(task, repoPath);
  }

  const shared = await directWorkspace(parent, repoPath);
  if (!task.useWorktree) return shared;

  const explicitBase = task.worktreeBase?.trim();
  const ws = await prepareWorktree(repoPath, task.id, explicitBase || shared.branch);
  await persistBaseFallback(task, ws);
  return ws;
}
