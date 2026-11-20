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
  const root = mkdtempSync(join(tmpdir(), "navi-accept-"));
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

/**
 * 目标分支哪儿都没检出时，挪它之前先**占住**它：开一个不写任何文件的临时 worktree（`--no-checkout`）把它检出过去。
 * 这借的是 git 自己的不变量 —— 一个分支同时只能在一处检出，占着期间别处 `git switch <它>` 会被 git 当场拒绝
 * （"is already used by worktree"）—— 所以 `fn` 里带旧值挪 ref 的那一下，不会和别人检出它撞在一起。
 *
 * 为什么不是「挪完再看一眼，看见被检出就退回去」（原先的写法）：那一眼看见的检出拿的是挪之前还是之后的版本，
 * 从外面说不清；它拿了新版而我们把 ref 退回旧版，HEAD 就指着旧版、索引和文件却是新版 —— 凭空一份暂存改动
 * （审查第 2 轮 F1 实测）。占不住（期间被检出了 / 开不出来）就什么都不动，交给调用方按「检出着」那条路走或如实说。
 *
 * 剩下的窗口是 git 自己的：另一个 `git switch` 在我们占住之前已经读完了分支、在拆掉之后才写 HEAD —— 那跟两个
 * 终端同时 `git branch -f` 和 `git switch` 是同一种竞争，git 本身也不防。
 */
export async function whileBranchClaimed<T>(repo: string, branch: string, fn: () => Promise<T>): Promise<
  | { claimed: true; value: T; path: string; cleanupError: string | null }
  | { claimed: false; checkedOutAt: string | null; message: string }> {
  const root = mkdtempSync(join(tmpdir(), "navi-claim-"));
  const temp = { root, path: join(root, "claim") };
  try {
    await exec("git", ["-C", repo, "worktree", "add", "--no-checkout", "--quiet", temp.path, branch]);
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    const message = gitError(error);
    const used = /already (?:used by worktree|checked out) at '([^']+)'/.exec(message);
    return { claimed: false, checkedOutAt: used?.[1] ?? null, message };
  }
  let value: T;
  try { value = await fn(); } catch (error) {
    await removeTemporaryWorktree(repo, temp);
    throw error;
  }
  return { claimed: true, value, path: temp.path, cleanupError: await removeTemporaryWorktree(repo, temp) };
}
