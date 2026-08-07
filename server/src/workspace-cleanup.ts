import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { statSync } from "node:fs";
import type { TaskWorkspaceLeftover, TaskWorkspaceDiscardResult } from "@harness/shared";
import { dirtyFilesAt, expandHome, gitError, listFiles, localBranchExists, removeWorktree, worktreeBranchName, worktreePathFor } from "./git.js";
import { withRepoLock } from "./repo-lock.js";

const exec = promisify(execFile);

const isDir = (p: string) => {
  try { return statSync(p).isDirectory(); } catch { return false; }
};

// ── 删除任务时 worktree/分支的去留 ──────────────────────────────────────────
// harness 建 worktree 但**从不自行删除**;唯二的例外都由用户显式点出:①验收通过
// (accept,合并后清理,见 server/CLAUDE.md);②删除任务时勾选「连 worktree 和分支一起
// 删」—— 就是这里。任务行一没,`.worktrees/<taskId>` 目录和 `harness/<id8>` 分支
// 就成了没人认领的垃圾:用户在界面上再也看不见它们,只能靠自己记得去 git 里收拾。
//
// 两件东西各自独立存在:目录被手动 rm 过、分支还留着,或者反过来(分支被删、目录
// 还在),都很常见,所以检测和清理都按两项分别报。

/** 这个任务在仓库里还留着什么。目录检查是同步的,分支要问一次 git。 */
export async function detectTaskWorkspace(
  repoPath: string | null | undefined,
  taskId: string,
): Promise<TaskWorkspaceLeftover> {
  const repo = expandHome(repoPath);
  if (!repo) return { path: null, branch: null };
  const path = worktreePathFor(repo, taskId);
  const branch = worktreeBranchName(taskId);
  return {
    path: isDir(path) ? path : null,
    branch: (await localBranchExists(repo, branch)) ? branch : null,
  };
}

/**
 * 删掉这个任务的 worktree 目录和/或分支。写型 git 操作,走仓库锁排队。
 *
 * 顺序必须是「prune → 删目录 → prune → 删分支」:分支被某个 worktree 检出时
 * `git branch -d` 必然失败,所以目录得先走;目录被手删过会留下陈旧登记(git 仍
 * 占着那个分支),prune 把它拉回可删。
 *
 * `force` 只在**用户看到第一次失败、又点了一次**时才为真:worktree 加 `--force`
 * (有未提交改动时),分支用 `-D`(未合并时)。默认路径一律不带 force,让 git 自己
 * 的安全检查兜住「这里面还有没提交/没合并的东西」。这跟验收清理那条「绝不用 -D」
 * 不冲突 —— 那条管的是自动流程,这里是用户看着报错仍然要求删掉。
 */
export async function discardTaskWorkspace(
  repoPath: string | null | undefined,
  taskId: string,
  opts: { worktree: boolean; branch: boolean; force?: boolean },
): Promise<TaskWorkspaceDiscardResult> {
  const out: TaskWorkspaceDiscardResult = {
    path: null,
    branch: null,
    worktreeRemoved: false,
    branchDeleted: false,
    worktreeError: null,
    branchError: null,
  };
  const repo = expandHome(repoPath);
  if (!repo || (!opts.worktree && !opts.branch)) return out;
  return withRepoLock(repo, async () => {
    const path = worktreePathFor(repo, taskId);
    const branch = worktreeBranchName(taskId);
    await exec("git", ["-C", repo, "worktree", "prune"]).catch(() => {});
    if (opts.worktree && isDir(path)) {
      out.path = path;
      try {
        await removeWorktree(repo, path, !!opts.force);
        out.worktreeRemoved = true;
      } catch (error) {
        // 这条报错是用户决定「要不要再点一次、这回带 force」的**唯一**依据,所以不能只
        // 转述 git 那句 "contains modified or untracked files" —— 强删掉的是哪几个文件,
        // 得当场摆在他面前。跟验收清理失败报的是同一份清单。
        const dirty = await dirtyFilesAt(path);
        out.worktreeError = dirty.length > 0
          ? `${gitError(error)}（挡路的是这 ${dirty.length} 个文件：${listFiles(dirty)}）`
          : gitError(error);
      }
      await exec("git", ["-C", repo, "worktree", "prune"]).catch(() => {});
    }
    if (opts.branch && (await localBranchExists(repo, branch))) {
      out.branch = branch;
      try {
        await exec("git", ["-C", repo, "branch", opts.force ? "-D" : "-d", branch]);
        out.branchDeleted = true;
      } catch (error) {
        out.branchError = gitError(error);
      }
    }
    return out;
  });
}
