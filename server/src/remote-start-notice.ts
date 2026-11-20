import type { Workspace } from "./git.js";
import { remoteBranchOf } from "./git-remote-branch.js";

/**
 * 从远端分支开工的任务，头一回建出工作目录时记一句：起点取自哪条远端分支、哪个提交，成果验收时合进哪条
 * 本地分支（多半是建任务时照远端建的那条跟踪分支，task-branch-plan.ts）。建任务那一刻还没有会话可写，
 * 所以落在头一回合里；工作目录复用、恢复时不再重复。
 */
export async function remoteStartNote(
  task: { worktreeBaseBranch?: string | null; worktreeStartCommit?: string | null; mergeTargetBranch?: string | null },
  ws: Pick<Workspace, "fresh" | "isWorktree">,
  repoPath: string,
): Promise<string | null> {
  if (!ws.isWorktree || !ws.fresh || !task.worktreeBaseBranch || !task.worktreeStartCommit) return null;
  const remote = await remoteBranchOf(repoPath, task.worktreeBaseBranch);
  if (!remote) return null;
  const target = task.mergeTargetBranch ? `，验收合入本地分支 ${task.mergeTargetBranch}` : "";
  return `从远端分支 ${remote.ref}（提交 ${task.worktreeStartCommit.slice(0, 7)}）开工${target}。`;
}
