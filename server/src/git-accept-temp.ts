// 临时 worktree：验收那一刻「不能碰用户工作区」时的落脚点。
//
// 合并（git-accept.ts）和清理（git-accept-cleanup.ts）都要用它，所以单独住一间：
// 合并侧把目标分支检出到临时目录里合，清理侧把目标分支 detached 检出一份，好让
// `git branch -d` 的 merged-into-HEAD 安全检查照常生效，同时不动项目目录。
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { gitError } from "./git.js";
import { execFileText as exec } from "./exec.js";
import { removeMissingWorktreeRegistrations } from "./git-worktree-state.js";

export type TemporaryWorktree = { root: string; path: string };

export async function addTemporaryWorktree(repo: string, ref: string, detached: boolean): Promise<TemporaryWorktree> {
  const root = mkdtempSync(join(tmpdir(), "ash-accept-"));
  const path = join(root, "worktree");
  const args = ["-C", repo, "worktree", "add"];
  if (detached) args.push("--detach");
  args.push(path, ref);
  try {
    await exec("git", args);
    return { root, path };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

export async function removeTemporaryWorktree(repo: string, temp: TemporaryWorktree): Promise<string | null> {
  const failures: string[] = [];
  try {
    await exec("git", ["-C", repo, "worktree", "remove", "--force", temp.path]);
  } catch (error) {
    failures.push(gitError(error));
  }
  try { rmSync(temp.root, { recursive: true, force: true }); }
  catch (error) { failures.push(`删除临时目录失败：${gitError(error)}`); }
  try { await removeMissingWorktreeRegistrations(repo, { path: temp.path }); }
  catch (error) { failures.push(`清理临时 worktree 登记失败：${gitError(error)}`); }
  return failures.length > 0 ? failures.join("；") : null;
}
