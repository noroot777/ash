import { eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { tasks } from "./db/schema.js";
import { prepareWorktree, resolveWorkspace, type Workspace } from "./git.js";

type WorkspaceTask = Pick<
  typeof tasks.$inferSelect,
  "id" | "projectId" | "parentId" | "useWorktree" | "worktreeBase" | "reviewOf"
>;

async function directWorkspace(task: WorkspaceTask, repoPath: string): Promise<Workspace> {
  return task.useWorktree
    ? prepareWorktree(repoPath, task.id, task.worktreeBase)
    : resolveWorkspace(repoPath, task.id);
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
  return prepareWorktree(repoPath, task.id, explicitBase || shared.branch);
}
