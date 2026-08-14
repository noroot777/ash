// 合并结果审查只读地检查验收时冻结的 commit。原任务 worktree 已被清理，所以为每条
// review run 建一个 detached 临时 worktree；它没有分支，不会复活原任务，也不会跟着
// 目标分支后续移动。所有 worktree 注册表写操作仍走仓库锁。
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { expandHome, headCommit, isGitRepo } from "./git.js";
import { assertNotPreviewInstance } from "./preview-instance.js";
import { withRepoLock } from "./repo-lock.js";

const exec = promisify(execFile);

function isDir(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

export function postMergeReviewWorktreePath(repoPath: string, taskId: string, runId: string): string {
  return join(expandHome(repoPath), ".worktrees", ".post-merge-review", taskId, runId);
}

export async function preparePostMergeReviewWorktree(
  repoPath: string,
  taskId: string,
  runId: string,
  commit: string,
): Promise<string> {
  assertNotPreviewInstance("创建合并结果审查 worktree");
  return withRepoLock(repoPath, async () => {
    const repo = expandHome(repoPath);
    if (!(await isGitRepo(repo))) throw new Error("项目不是 git 仓库，无法审查合并结果");
    const path = postMergeReviewWorktreePath(repo, taskId, runId);
    if (isDir(path) && existsSync(join(path, ".git"))) {
      if (await headCommit(path) === commit) return path;
      await exec("git", ["-C", repo, "worktree", "remove", "--force", path]);
    }
    if (existsSync(path)) rmSync(path, { recursive: true, force: true });
    await exec("git", ["-C", repo, "worktree", "prune"]).catch(() => undefined);
    mkdirSync(dirname(path), { recursive: true });
    try {
      await exec("git", ["-C", repo, "worktree", "add", "--detach", path, commit]);
    } catch (error) {
      const message = (error as { stderr?: string }).stderr?.trim() || (error as Error).message;
      throw new Error(`创建合并结果审查 worktree 失败：${message}`);
    }
    return path;
  });
}

export async function cleanupPostMergeReviewWorktree(
  repoPath: string,
  taskId: string,
  runId: string,
): Promise<void> {
  assertNotPreviewInstance("清理合并结果审查 worktree");
  await withRepoLock(repoPath, async () => {
    const repo = expandHome(repoPath);
    const path = postMergeReviewWorktreePath(repo, taskId, runId);
    if (!existsSync(path)) {
      await exec("git", ["-C", repo, "worktree", "prune"]).catch(() => undefined);
      return;
    }
    if (existsSync(join(path, ".git"))) {
      await exec("git", ["-C", repo, "worktree", "remove", "--force", path]);
    }
    if (existsSync(path)) rmSync(path, { recursive: true, force: true });
    await exec("git", ["-C", repo, "worktree", "prune"]).catch(() => undefined);
  });
}
