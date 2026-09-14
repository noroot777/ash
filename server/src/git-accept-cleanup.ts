// 验收之后的清理：删任务 worktree、删任务分支。
//
// 从 git-accept.ts 拆出来的（那边只剩「怎么合」）：合并写的是目标分支的 ref 和项目
// 工作区，清理写的是任务自己的 worktree 和分支——两件事失败模式完全不同（清理失败时
// 合并已经发生且不可撤销），分开读才看得清各自的退路。
//
// 清到什么程度由线上那一站说了算（AcceptClean → CleanupPlan）；不传就是老规矩全清。
import { basename } from "node:path";
import { statSync } from "node:fs";
import type { AcceptClean } from "@ash/shared/workflow";
import {
  dirtyFilesAt,
  expandHome,
  gitError,
  listFiles,
  localBranchExists,
  resolveWorktreeBranchName,
  symbolicBranch,
  worktreePathFor,
} from "./git.js";
import { withRepoLock } from "./repo-lock.js";
import { execFileText as exec } from "./exec.js";
import { findProcessesReferencingPath, type ProcessRow } from "./platform.js";
import { assertReadableWorktree, removeMissingWorktreeRegistrations, UnreadableWorktreeError } from "./git-worktree-state.js";
import { preserveRemovedWorktree } from "./git-worktree-recovery.js";
import { removeAcceptedWorktree } from "./git-accept-worktree.js";
import { isAncestor } from "./git-accept.js";
import { addTemporaryWorktree, removeTemporaryWorktree, type TemporaryWorktree } from "./git-accept-temp.js";

const isDir = (p: string) => {
  try { return statSync(p).isDirectory(); } catch { return false; }
};

function processName(command: string): string {
  const token = command.startsWith('"')
    ? /^"([^"]+)"/.exec(command)?.[1]
    : /^(\S+)/.exec(command)?.[1];
  return basename(token || "process");
}

/** 删除 worktree 失败时给用户的下一步。导出只为回归测试,业务调用仍只有下方一处。 */
export function worktreeRemovalBlocker(
  worktreePath: string,
  error: unknown,
  dirtyFiles: readonly string[],
  blockers: readonly ProcessRow[] = [],
): string {
  if (error instanceof UnreadableWorktreeError) return error.message;
  if ((error as NodeJS.ErrnoException)?.code === "EBUSY") {
    const visible = blockers.slice(0, 6);
    const holders = visible.length
      ? `，已认出 ${visible.map((row) => `${processName(row.command)}（PID ${row.pid}）`).join("、")}`
      : "";
    return `这个目录正被运行中的进程或打开句柄占用${holders}；结束在此 worktree 里运行的终端、dev server 或 agent 后再点一次验收`;
  }
  if (dirtyFiles.length > 0) {
    return `挡路的是 ${worktreePath} 里这 ${dirtyFiles.length} 个文件：${listFiles([...dirtyFiles])}；提交或丢弃它们之后再点一次验收`;
  }
  return `删除失败，但没有发现未提交改动；请检查 ${worktreePath} 的权限、占用进程或文件系统状态后再点一次验收`;
}

export type TaskCleanupResult = { worktreeBackupPath?: string; notices?: string[] } & (
  | {
      ok: true;
      sourceBranch: string;
      targetBranch: string;
      worktreePath: string;
      worktreeRemoved: boolean;
      branchDeleted: boolean;
    }
  | {
      ok: false;
      reason: "worktree_remove_failed" | "branch_not_merged" | "branch_delete_failed" | "temporary_cleanup_failed";
      message: string;
      sourceBranch: string;
      targetBranch: string;
      worktreePath: string;
      /** 挡住清理的文件（worktree 里未提交/未跟踪的那些）。跟合并失败的同名字段一个意思。 */
      dirtyFiles?: string[];
    });

export interface CleanupPlan {
  /** 删任务 worktree 目录 */
  worktree: boolean;
  /** 删任务分支（只用 git branch -d，删不掉就如实报告） */
  branch: boolean;
}

export const FULL_CLEANUP: CleanupPlan = { worktree: true, branch: true };

/** 线上「清到什么程度」那一格 → 清理计划。 */
export function cleanupPlanFor(clean: AcceptClean): CleanupPlan {
  return {
    worktree: clean === "all" || clean === "worktree",
    branch: clean === "all",
  };
}

export async function cleanupAcceptedTask(
  repoPath: string,
  taskId: string,
  targetBranch: string,
  plan: CleanupPlan = FULL_CLEANUP,
): Promise<TaskCleanupResult> {
  return withRepoLock(repoPath, () => cleanupAcceptedTaskLocked(repoPath, taskId, targetBranch, plan));
}

async function cleanupAcceptedTaskLocked(
  repoPath: string,
  taskId: string,
  targetBranch: string,
  plan: CleanupPlan,
): Promise<TaskCleanupResult> {
  const repo = expandHome(repoPath);
  const sourceBranch = await resolveWorktreeBranchName(repo, taskId);
  const worktreePath = worktreePathFor(repo, taskId);
  await removeMissingWorktreeRegistrations(repo, { branch: sourceBranch }).catch(() => {});
  const hadWorktree = plan.worktree && isDir(worktreePath);
  let worktreeBackupPath: string | undefined;
  const notices: string[] = [];
  if (hadWorktree) {
    try {
      try {
        await assertReadableWorktree(worktreePath, repo, sourceBranch);
        await removeAcceptedWorktree(repo, worktreePath, notices);
      } catch (error) {
        worktreeBackupPath = await preserveRemovedWorktree(repo, worktreePath, sourceBranch) ?? undefined;
        if (!worktreeBackupPath) throw error;
      }
    } catch (error) {
      // 真脏时列文件；Windows 的 EBUSY 则列能从命令行认出的占用进程。两者不能混:
      // 把「dev server 还在跑」说成「多半有未提交改动」只会让用户翻遍 git status 仍无解。
      const dirtyFiles = error instanceof UnreadableWorktreeError ? [] : await dirtyFilesAt(worktreePath);
      const blockers = (error as NodeJS.ErrnoException)?.code === "EBUSY"
        ? await findProcessesReferencingPath(worktreePath).catch(() => [])
        : [];
      const blocking = worktreeRemovalBlocker(worktreePath, error, dirtyFiles, blockers);
      return {
        ok: false,
        reason: "worktree_remove_failed",
        message: error instanceof UnreadableWorktreeError ? error.message : `任务 worktree 删除失败：${gitError(error)}（${blocking}）`,
        sourceBranch,
        targetBranch,
        worktreePath,
        dirtyFiles,
        notices,
      };
    }
  }
  await removeMissingWorktreeRegistrations(repo, { branch: sourceBranch }).catch(() => {});
  // 线上写的是「分支留着」（或 squash/打标签之后根本删不掉）：到这儿就收工，下面那套
  // ancestor 校验和 `git branch -d` 一句都不跑——分支还在是**说好的结果**，不是失败。
  if (!plan.branch) {
    return { ok: true, sourceBranch, targetBranch, worktreePath, worktreeRemoved: hadWorktree, branchDeleted: false, worktreeBackupPath, notices };
  }
  if (!(await localBranchExists(repo, sourceBranch))) {
    return { ok: true, sourceBranch, targetBranch, worktreePath, worktreeRemoved: hadWorktree, branchDeleted: false, worktreeBackupPath, notices };
  }
  if (!(await isAncestor(repo, sourceBranch, targetBranch))) {
    return {
      ok: false,
      reason: "branch_not_merged",
      worktreeBackupPath,
      notices,
      message: `任务分支 ${sourceBranch} 尚未合并进 ${targetBranch}，拒绝删除`,
      sourceBranch,
      targetBranch,
      worktreePath,
    };
  }

  let deleteCwd = repo;
  let temp: TemporaryWorktree | null = null;
  if ((await symbolicBranch(repo)) !== targetBranch) {
    try {
      // Detached at the target commit: `git branch -d` still performs its normal
      // merged-into-HEAD safety check, without checking out or moving the target.
      temp = await addTemporaryWorktree(repo, targetBranch, true);
      deleteCwd = temp.path;
    } catch (error) {
      return {
        ok: false,
        reason: "branch_delete_failed",
        worktreeBackupPath,
        notices,
        message: `为安全执行 git branch -d 创建校验 worktree 失败：${gitError(error)}`,
        sourceBranch,
        targetBranch,
        worktreePath,
      };
    }
  }
  let deleteError: string | null = null;
  try {
    await exec("git", ["-C", deleteCwd, "branch", "-d", sourceBranch]);
  } catch (error) {
    deleteError = gitError(error);
  }
  const cleanupError = temp ? await removeTemporaryWorktree(repo, temp) : null;
  if (deleteError) {
    return {
      ok: false,
      reason: "branch_delete_failed",
      worktreeBackupPath,
      notices,
      message: `git branch -d ${sourceBranch} 失败：${deleteError}`,
      sourceBranch,
      targetBranch,
      worktreePath,
    };
  }
  if (cleanupError) {
    return {
      ok: false,
      reason: "temporary_cleanup_failed",
      worktreeBackupPath,
      notices,
      message: `分支已删除，但临时校验 worktree 清理失败：${cleanupError}`,
      sourceBranch,
      targetBranch,
      worktreePath,
    };
  }
  return { ok: true, sourceBranch, targetBranch, worktreePath, worktreeRemoved: hadWorktree, branchDeleted: true, worktreeBackupPath, notices };
}
