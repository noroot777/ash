// 验收那一刻要动的 git —— 合并任务分支、清理 worktree 和分支。
//
// 从 git.ts 拆出来的（那边只剩仓库探测与 worktree 生命周期）：合并这一块自成一体，
// 而且它是唯一会写「共享状态」的地方（目标分支的 ref、项目工作区），单独一个文件读
// 起来才看得清「哪几条路会碰用户的工作区」。
//
// 怎么合、清到什么程度由**线上那一站**说了算（AcceptStrategy / AcceptClean），调用方
// 在 task-accept.ts 里从任务的工作流快照读出来传进来；不传就是老规矩（安全合并 + 全清）。
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import type { AcceptClean, AcceptStrategy } from "@ash/shared/workflow";
import {
  dirtyFilesAt,
  expandHome,
  gitError,
  isGitRepo,
  listFiles,
  localBranchExists,
  porcelainFiles,
  removeWorktree,
  resolveTaskMergeTarget,
  resolveWorktreeBranchName,
  symbolicBranch,
  worktreePathFor,
} from "./git.js";
import { withRepoLock } from "./repo-lock.js";
import { assertNotPreviewInstance } from "./preview-instance.js";
import { execFileText as exec } from "./exec.js";

const isDir = (p: string) => {
  try { return statSync(p).isDirectory(); } catch { return false; }
};

function sameFilesystemPath(a: string, b: string): boolean {
  try { return realpathSync(resolve(a)) === realpathSync(resolve(b)); }
  catch { return resolve(a) === resolve(b); }
}

// ── Deterministic acceptance merge / cleanup ───────────────────────────────
// These helpers never checkout another branch in the user's project working
// directory. The only time that directory is touched is when it is ALREADY on
// the target branch and completely clean; git forbids checking that branch out
// in a temporary worktree, so merging in place is the safe, explicit fallback.

export type TaskMergeMethod = "already_merged" | "fast_forward" | "merge_commit" | "squash" | "tagged";
export type TaskMergeWarning = {
  reason: "temporary_cleanup_failed";
  message: string;
  worktreePath: string;
};
export type TaskMergeFailureReason =
  | "not_git_repo"
  | "source_branch_missing"
  | "target_branch_missing"
  | "target_unresolved"
  | "source_equals_target"
  | "target_dirty"
  | "target_checked_out"
  | "merge_conflict"
  | "fast_forward_failed"
  | "merge_failed"
  | "temporary_cleanup_failed";

export type TaskMergeResult =
  | {
      ok: true;
      sourceBranch: string;
      targetBranch: string;
      method: TaskMergeMethod;
      /** 只在「只打标签不合并」那一档有值 */
      tag?: string;
      /** 合并前后目标分支的 commit（结构化落账，供合并后基线审查用）。already_merged/tagged 时两者相等。 */
      beforeCommit?: string | null;
      afterCommit?: string | null;
      warnings?: TaskMergeWarning[];
    }
  | {
      ok: false;
      reason: TaskMergeFailureReason;
      message: string;
      sourceBranch: string;
      targetBranch: string | null;
      conflictFiles?: string[];
      dirtyFiles?: string[];
      targetPath?: string;
    };

export type TaskCleanupResult =
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
    };

export async function isAncestor(repo: string, ancestor: string, descendant: string): Promise<boolean> {
  try {
    await exec("git", ["-C", repo, "merge-base", "--is-ancestor", ancestor, descendant]);
    return true;
  } catch {
    return false;
  }
}

/** 某个 ref 指向的 commit；ref 不存在返回 null。 */
async function commitOf(repo: string, ref: string): Promise<string | null> {
  try {
    const { stdout } = await exec("git", ["-C", repo, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function checkedOutPath(repo: string, branch: string): Promise<string | null> {
  const { stdout } = await exec("git", ["-C", repo, "worktree", "list", "--porcelain"]);
  let path: string | null = null;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
    else if (line === `branch refs/heads/${branch}`) return path;
    else if (!line) path = null;
  }
  return null;
}

async function conflictFiles(cwd: string): Promise<string[]> {
  try {
    const { stdout } = await exec("git", ["-C", cwd, "diff", "--name-only", "--diff-filter=U"]);
    return stdout.split("\n").map((line) => line.trim()).filter(Boolean).sort();
  } catch {
    return [];
  }
}

type TemporaryWorktree = { root: string; path: string };

async function addTemporaryWorktree(repo: string, ref: string, detached: boolean): Promise<TemporaryWorktree> {
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

async function removeTemporaryWorktree(repo: string, temp: TemporaryWorktree): Promise<string | null> {
  const failures: string[] = [];
  try {
    await exec("git", ["-C", repo, "worktree", "remove", "--force", temp.path]);
  } catch (error) {
    failures.push(gitError(error));
  }
  try { rmSync(temp.root, { recursive: true, force: true }); }
  catch (error) { failures.push(`删除临时目录失败：${gitError(error)}`); }
  try { await exec("git", ["-C", repo, "worktree", "prune"]); }
  catch (error) { failures.push(`git worktree prune 失败：${gitError(error)}`); }
  return failures.length > 0 ? failures.join("；") : null;
}

export function withTemporaryCleanupOutcome(
  result: TaskMergeResult,
  cleanupError: string | null,
  worktreePath: string,
): TaskMergeResult {
  if (!cleanupError) return result;
  const message = `临时合并 worktree ${worktreePath} 清理失败：${cleanupError}；合并结果已保留，可手动清理该路径并执行 git worktree prune，后续验收清理步骤也会再次 prune`;
  if (!result.ok) return { ...result, message: `${result.message}；${message}` };
  const warning: TaskMergeWarning = { reason: "temporary_cleanup_failed", message, worktreePath };
  return { ...result, warnings: [...(result.warnings ?? []), warning] };
}

async function mergeInCheckedOutTarget(
  cwd: string,
  sourceBranch: string,
  targetBranch: string,
  fastForward: boolean,
): Promise<TaskMergeResult> {
  try {
    await exec("git", ["-C", cwd, "merge", ...(fastForward ? ["--ff-only"] : ["--no-ff", "--no-edit"]), sourceBranch]);
    return { ok: true, sourceBranch, targetBranch, method: fastForward ? "fast_forward" : "merge_commit" };
  } catch (error) {
    const files = await conflictFiles(cwd);
    await exec("git", ["-C", cwd, "merge", "--abort"]).catch(() => {});
    if (files.length > 0) {
      return {
        ok: false,
        reason: "merge_conflict",
        message: `合并 ${sourceBranch} 到 ${targetBranch} 发生冲突`,
        sourceBranch,
        targetBranch,
        conflictFiles: files,
      };
    }
    return {
      ok: false,
      reason: "merge_failed",
      message: `git merge 失败：${gitError(error)}`,
      sourceBranch,
      targetBranch,
    };
  }
}

export async function mergeTaskBranch(
  repoPath: string,
  taskId: string,
  requestedTarget: string | null | undefined,
  strategy: AcceptStrategy = "safe",
): Promise<TaskMergeResult> {
  // 预览实例上一律拒绝：合的是**真**分支（见 preview-instance.ts）。acceptTask 那头已经
  // 结构化挡了一道，这里是给其它调用路径兜的底。
  assertNotPreviewInstance("合并任务分支");
  return withRepoLock(repoPath, async () => {
    // 合并前后目标分支的 commit 在锁内取，保证「before → 合并 → after」之间没有别人插队。
    const repo = expandHome(repoPath);
    const target = await resolveTaskMergeTarget(repo, requestedTarget);
    const beforeCommit = target ? await commitOf(repo, target) : null;
    const result = await mergeTaskBranchLocked(repoPath, taskId, requestedTarget, strategy);
    if (!result.ok) return result;
    return { ...result, beforeCommit, afterCommit: await commitOf(repo, result.targetBranch) };
  });
}

// 目标分支得有个检出的地方才跑得了 merge。三种情况按危险程度排：目标就在项目目录上
// 且干净 → 就地跑；目标在别的 worktree 上 → 一律不碰（那是别人正在用的工作区）；
// 哪儿都没检出 → 开个临时 worktree，跑完就拆。
async function inTargetCheckout(
  repo: string,
  sourceBranch: string,
  targetBranch: string,
  fn: (cwd: string) => Promise<TaskMergeResult>,
  beforeTemp?: () => TaskMergeResult | null,
): Promise<TaskMergeResult> {
  await exec("git", ["-C", repo, "worktree", "prune"]).catch(() => {});
  const targetPath = await checkedOutPath(repo, targetBranch).catch(() => null);
  const mainBranch = await symbolicBranch(repo);
  const targetAtRepo = targetPath !== null && sameFilesystemPath(targetPath, repo) && mainBranch === targetBranch;

  if (targetAtRepo) {
    const { stdout } = await exec("git", ["-C", repo, "status", "--porcelain"]);
    const dirtyFiles = porcelainFiles(stdout);
    if (dirtyFiles.length > 0) {
      return {
        ok: false,
        reason: "target_dirty",
        message: `目标分支 ${targetBranch} 已在项目目录检出，但工作区不干净；未执行合并`,
        sourceBranch,
        targetBranch,
        targetPath: repo,
        dirtyFiles,
      };
    }
    return fn(repo);
  }
  if (targetPath) {
    return {
      ok: false,
      reason: "target_checked_out",
      message: `目标分支 ${targetBranch} 已在另一个 worktree 检出；未操作该工作区`,
      sourceBranch,
      targetBranch,
      targetPath,
    };
  }
  const early = beforeTemp?.();
  if (early) return early;

  let temp: TemporaryWorktree;
  try {
    temp = await addTemporaryWorktree(repo, targetBranch, false);
  } catch (error) {
    return {
      ok: false,
      reason: "merge_failed",
      message: `创建临时合并 worktree 失败：${gitError(error)}`,
      sourceBranch,
      targetBranch,
    };
  }
  const result = await fn(temp.path);
  const cleanupError = await removeTemporaryWorktree(repo, temp);
  return withTemporaryCleanupOutcome(result, cleanupError, temp.path);
}

// squash 合并：任务分支上那串提交在目标分支上压成一个提交。**不能走 ref-only 的
// fast-forward 那条快路**——那条路是把 ref 直接前移，压根不产生新提交，跟 squash 的
// 语义正相反，所以这里一律找个检出的地方老老实实 merge --squash + commit。
async function squashInCheckedOutTarget(
  cwd: string,
  sourceBranch: string,
  targetBranch: string,
): Promise<TaskMergeResult> {
  try {
    await exec("git", ["-C", cwd, "merge", "--squash", sourceBranch]);
  } catch (error) {
    const files = await conflictFiles(cwd);
    await exec("git", ["-C", cwd, "merge", "--abort"]).catch(() => {});
    await exec("git", ["-C", cwd, "reset", "--hard"]).catch(() => {});
    if (files.length > 0) {
      return {
        ok: false,
        reason: "merge_conflict",
        message: `squash 合并 ${sourceBranch} 到 ${targetBranch} 发生冲突`,
        sourceBranch,
        targetBranch,
        conflictFiles: files,
      };
    }
    return {
      ok: false,
      reason: "merge_failed",
      message: `git merge --squash 失败：${gitError(error)}`,
      sourceBranch,
      targetBranch,
    };
  }
  // 「内容已在目标里」的判定必须在 merge --squash 之后、commit 之前做：此刻 staged 为空
  // = merge 结果与目标无差异，这是**内容证据**。commit 失败后再查 staged 不可信——恶意/
  // 异常的 pre-commit hook 可以在失败前 reset 掉暂存区，把「什么都没合进去」伪装成
  // already_merged（审查实测：目标 ref 没动、产物丢失，接口却返回 accepted）。
  const stagedEmptyAfterMerge = await exec("git", ["-C", cwd, "diff", "--cached", "--quiet"])
    .then(() => true)
    .catch(() => false);
  if (stagedEmptyAfterMerge) {
    await exec("git", ["-C", cwd, "reset", "--hard"]).catch(() => {});
    return { ok: true, sourceBranch, targetBranch, method: "already_merged" };
  }
  try {
    await exec("git", ["-C", cwd, "commit", "-m", `squash 合并 ${sourceBranch}`]);
    return { ok: true, sourceBranch, targetBranch, method: "squash" };
  } catch (error) {
    // 到这里 staged 一定非空过：commit 失败就是真失败（hook 拒绝/环境问题），如实报错。
    const message = gitError(error);
    await exec("git", ["-C", cwd, "reset", "--hard"]).catch(() => {});
    return {
      ok: false,
      reason: "merge_failed",
      message: `squash 提交失败：${message}`,
      sourceBranch,
      targetBranch,
    };
  }
}

/** 「只打标签不合并」那一档的标签名。 */
export function acceptTagName(taskId: string): string {
  return `ash-accepted/${taskId.slice(0, 8)}`;
}

async function mergeTaskBranchLocked(
  repoPath: string,
  taskId: string,
  requestedTarget: string | null | undefined,
  strategy: AcceptStrategy,
): Promise<TaskMergeResult> {
  const repo = expandHome(repoPath);
  const sourceBranch = await resolveWorktreeBranchName(repo, taskId);
  if (!(await isGitRepo(repo))) {
    return { ok: false, reason: "not_git_repo", message: `${repoPath} 不是 git 仓库`, sourceBranch, targetBranch: null };
  }
  const targetBranch = await resolveTaskMergeTarget(repo, requestedTarget);
  if (!targetBranch) {
    return { ok: false, reason: "target_unresolved", message: "目标分支为空且项目当前处于 detached HEAD", sourceBranch, targetBranch: null };
  }
  if (!(await localBranchExists(repo, sourceBranch))) {
    return { ok: false, reason: "source_branch_missing", message: `任务分支 ${sourceBranch} 不存在`, sourceBranch, targetBranch };
  }
  if (!(await localBranchExists(repo, targetBranch))) {
    return { ok: false, reason: "target_branch_missing", message: `目标本地分支 ${targetBranch} 不存在`, sourceBranch, targetBranch };
  }
  if (sourceBranch === targetBranch) {
    return { ok: false, reason: "source_equals_target", message: "任务分支不能同时作为验收目标分支", sourceBranch, targetBranch };
  }

  // 「只打标签不合并」：目标分支一动不动，只在任务分支的头上钉一个标签，日后要找回
  // 这份产物有个稳定的名字。
  //
  // **不用 `git tag -f`**：标签名是从 taskId 前 8 位算出来的，理论上撞不着，但真撞上
  // 时 -f 会把别人的标签指到别处去 —— 一个不可逆、而且用户完全看不见的覆盖。所以先
  // 看它现在指着谁：指着同一个 commit 就是重复验收，当成功；指着别处就报错让人处理。
  if (strategy === "tag") {
    const tag = acceptTagName(taskId);
    const [head, tagged] = await Promise.all([
      commitOf(repo, sourceBranch),
      commitOf(repo, `refs/tags/${tag}`),
    ]);
    if (tagged) {
      if (tagged === head) return { ok: true, sourceBranch, targetBranch, method: "tagged", tag };
      return {
        ok: false,
        reason: "merge_failed",
        message: `标签 ${tag} 已经存在、而且指向别的提交（${tagged.slice(0, 8)}）；`
          + "不覆盖它，请先确认那是什么再手动处理。",
        sourceBranch,
        targetBranch,
      };
    }
    try {
      await exec("git", ["-C", repo, "tag", tag, sourceBranch]);
      return { ok: true, sourceBranch, targetBranch, method: "tagged", tag };
    } catch (error) {
      return {
        ok: false,
        reason: "merge_failed",
        message: `打标签 ${tag} 失败：${gitError(error)}`,
        sourceBranch,
        targetBranch,
      };
    }
  }

  if (await isAncestor(repo, sourceBranch, targetBranch)) {
    return { ok: true, sourceBranch, targetBranch, method: "already_merged" };
  }

  if (strategy === "squash") {
    return inTargetCheckout(repo, sourceBranch, targetBranch, (cwd) =>
      squashInCheckedOutTarget(cwd, sourceBranch, targetBranch));
  }

  // First attempt the ref-only fast-forward. This changes no checked-out files;
  // non-FF and checked-out-target failures fall through to the guarded paths.
  try {
    await exec("git", ["-C", repo, "fetch", ".", `${sourceBranch}:${targetBranch}`]);
    return { ok: true, sourceBranch, targetBranch, method: "fast_forward" };
  } catch (fetchError) {
    const fastForward = await isAncestor(repo, targetBranch, sourceBranch);
    return inTargetCheckout(
      repo,
      sourceBranch,
      targetBranch,
      // 走到临时 worktree 时 fastForward 一定是 false（下面那个 beforeTemp 已经把
      // 「本来能 FF 却失败了」拦掉了），所以这儿直接把它透传下去。
      (cwd) => mergeInCheckedOutTarget(cwd, sourceBranch, targetBranch, fastForward),
      // 目标分支哪儿都没检出、而且本来就该能 fast-forward：那句 ref-only 的 fetch 失败
      // 是真出事了，别再开临时 worktree 拿 merge 去糊。
      () => fastForward
        ? {
            ok: false,
            reason: "fast_forward_failed",
            message: `纯 fast-forward 更新 ${targetBranch} 失败：${gitError(fetchError)}`,
            sourceBranch,
            targetBranch,
          }
        : null,
    );
  }
}

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
  await exec("git", ["-C", repo, "worktree", "prune"]).catch(() => {});
  const hadWorktree = plan.worktree && isDir(worktreePath);
  if (hadWorktree) {
    try {
      await removeWorktree(repo, worktreePath, false);
    } catch (error) {
      // 走到这儿只剩一种情形：工作区真脏（半删除的空壳已经由 removeWorktree 自己收拾了）。
      // 那是该拦的——里面可能有没提交的东西，自动流程不替用户拍板扔掉。但 git 只会说一句
      // "contains modified or untracked files"，不说是哪个文件；这障碍又不会自己消失，于是
      // 每点一次验收都撞同一堵墙、还是同一句看不出所以然的话。所以当场把挡路的清单查出来
      // 一起报——跟合并失败报冲突文件是同一副样子。
      const dirtyFiles = await dirtyFilesAt(worktreePath);
      const blocking = dirtyFiles.length > 0
        ? `挡路的是 ${worktreePath} 里这 ${dirtyFiles.length} 个文件：${listFiles(dirtyFiles)}；提交或丢弃它们之后再点一次验收`
        : `多半是 ${worktreePath} 里还有没提交的改动：去看一眼，提交或丢弃之后再点一次验收`;
      return {
        ok: false,
        reason: "worktree_remove_failed",
        message: `任务 worktree 删除失败：${gitError(error)}（${blocking}）`,
        sourceBranch,
        targetBranch,
        worktreePath,
        dirtyFiles,
      };
    }
  }
  await exec("git", ["-C", repo, "worktree", "prune"]).catch(() => {});
  // 线上写的是「分支留着」（或 squash/打标签之后根本删不掉）：到这儿就收工，下面那套
  // ancestor 校验和 `git branch -d` 一句都不跑——分支还在是**说好的结果**，不是失败。
  if (!plan.branch) {
    return { ok: true, sourceBranch, targetBranch, worktreePath, worktreeRemoved: hadWorktree, branchDeleted: false };
  }
  if (!(await localBranchExists(repo, sourceBranch))) {
    return { ok: true, sourceBranch, targetBranch, worktreePath, worktreeRemoved: hadWorktree, branchDeleted: false };
  }
  if (!(await isAncestor(repo, sourceBranch, targetBranch))) {
    return {
      ok: false,
      reason: "branch_not_merged",
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
      message: `分支已删除，但临时校验 worktree 清理失败：${cleanupError}`,
      sourceBranch,
      targetBranch,
      worktreePath,
    };
  }
  return { ok: true, sourceBranch, targetBranch, worktreePath, worktreeRemoved: hadWorktree, branchDeleted: true };
}
