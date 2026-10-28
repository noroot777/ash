import { eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { projects } from "./db/schema.js";
import { repoKey, resolveWorktreeBranchName, symbolicBranch } from "./git.js";
import { ScmOperationError } from "./git-workspace-ops.js";
import { resolveWorkspaceContext, workspaceReadOnlyReason, type WorkspaceWriteContext } from "./workspace-write-gate.js";

export const SHARED_WORKSPACE_COMMIT_BLOCK = "此任务共用项目目录，无法区分任务改动与用户文件；不能自动或一键全量提交。请到源代码管理中按文件选择提交。";

export async function acceptanceWorkspaceCommitBlock(context: WorkspaceWriteContext): Promise<string | null> {
  const { task, root } = context;
  if (!task.useWorktree) return SHARED_WORKSPACE_COMMIT_BLOCK;
  const readOnly = await workspaceReadOnlyReason(task, root);
  if (readOnly) return readOnly;
  const project = (await db.select().from(projects).where(eq(projects.id, task.projectId))).at(0);
  if (!project) return "任务所属项目不存在，无法确认工作目录归属";
  if (repoKey(root.repo) !== repoKey(project.repoPath)) {
    return "任务当前工作目录不属于项目仓库，请先核对目录，不能提交任务改动";
  }
  const [branch, expected] = await Promise.all([
    symbolicBranch(root.path), resolveWorktreeBranchName(project.repoPath, task.id),
  ]);
  if (!branch || branch !== expected) return "任务工作目录不在待验收的任务分支上，请先核对分支，不能提交任务改动";
  return null;
}

export async function assertAcceptanceWorkspaceCommit(context: WorkspaceWriteContext): Promise<void> {
  const fresh = await resolveWorkspaceContext(context.task.id);
  if ("error" in fresh) throw new ScmOperationError(fresh.error, fresh.status);
  if (fresh.root.path !== context.root.path) throw new ScmOperationError("任务工作目录已变化，请刷新后重试", 409);
  const block = await acceptanceWorkspaceCommitBlock(fresh);
  if (block) throw new ScmOperationError(block, 409);
}
