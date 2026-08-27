import { statSync } from "node:fs";
import type { TaskWorkspaceLeftover, TaskWorkspaceDiscardResult } from "@ash/shared";
import { dirtyFilesAt, expandHome, gitError, listFiles, localBranchExists, removeWorktree, resolveWorktreeBranchName, worktreePathFor } from "./git.js";
import { withRepoLock } from "./repo-lock.js";
import { execFileText as exec } from "./exec.js";

const isDir = (p: string) => {
  try { return statSync(p).isDirectory(); } catch { return false; }
};

// ── 删除任务时 worktree/分支的去留 ──────────────────────────────────────────
// ash 建 worktree 但**从不自行删除**;例外有三:前两个由用户显式点出——①验收通过
// (accept,合并后清理,见 server/CLAUDE.md);②删除任务时勾选「连 worktree 和分支一起
// 删」—— 就是这里；③任务接力确认送达后自动清理(见文件末尾 discardMigratedWorkspace)。
// 任务行一没,`.worktrees/<taskId>` 目录和 `ash/<id8>` 分支
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
  const branch = await resolveWorktreeBranchName(repo, taskId);
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
    const branch = await resolveWorktreeBranchName(repo, taskId);
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

// ── 例外之三:任务接力(用户 2026-08-27 拍板)────────────────────────────────
// 「任务在哪儿,分支之类的才在哪儿」。任务接力到另一台机器并**确认送达**之后,本机
// 这份 worktree 和分支就是死物:代码全在对端了,留着只会让人误以为还能在本机接着改
// (真改了也是分叉)。所以确认送达后主动删,移回时对称地删掉持有机那一份。
//
// 「彻底传完才删」这条闸分两段,缺一不可:
//   ① 调用方先拿对端应答里的 `git: "bundle"` 证明代码确实落了地(旧版对端不报这个
//      字段 → 什么都不删);
//   ② 这里再让 git 自己把关——`git worktree remove` **不带 --force**,目录里还有
//      未提交/未跟踪的东西它就拒绝,我们照单保留并如实报出。
// 分支只能 -D:它的提交本来就没合回主线,-d 必然拒绝。走到那一步时代码已经在对端、
// 目录也已确认干净,提交不会丢。
export async function discardMigratedWorkspace(
  repoPath: string | null | undefined,
  taskId: string,
): Promise<{ removed: boolean; note: string }> {
  const repo = expandHome(repoPath);
  if (!repo) return { removed: false, note: "" };
  const path = worktreePathFor(repo, taskId);
  const hadDir = isDir(path);
  const wt = await discardTaskWorkspace(repo, taskId, { worktree: true, branch: false });
  if (hadDir && !wt.worktreeRemoved) {
    return {
      removed: false,
      note: `本机 worktree 里还有没随任务带走的东西,已原样保留:${path}（${wt.worktreeError ?? "删除失败"}）。确认不需要后手动删除。`,
    };
  }
  const br = await discardTaskWorkspace(repo, taskId, { worktree: false, branch: true, force: true });
  const parts: string[] = [];
  if (wt.worktreeRemoved) parts.push(`worktree ${path}`);
  if (br.branchDeleted) parts.push(`分支 ${br.branch}`);
  if (br.branch && !br.branchDeleted) {
    return {
      removed: wt.worktreeRemoved,
      note: `${parts.length ? `已清理本机 ${parts.join(" 和 ")};` : ""}分支 ${br.branch} 没能删掉（${br.branchError ?? "未知原因"}）,请手动确认。`,
    };
  }
  return {
    removed: true,
    note: parts.length ? `已清理本机 ${parts.join(" 和 ")}——代码现在只在对端。` : "",
  };
}
