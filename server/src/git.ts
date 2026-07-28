import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, existsSync } from "node:fs";
import type { ProjectHealth } from "@harness/shared";
import { DATA_DIR } from "./paths.js";

const exec = promisify(execFile);

const isDir = (p: string) => {
  try { return statSync(p).isDirectory(); } catch { return false; }
};

const isFile = (p: string) => {
  try { return statSync(p).isFile(); } catch { return false; }
};

// Users type `~/code/foo`, but Node's fs/git APIs don't understand `~` (only
// shells do) — so expand a leading `~` to the home dir before any filesystem
// use. Applied at every repoPath boundary below so `~` works system-wide.
export function expandHome(p: string | null | undefined): string {
  if (!p) return "";
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

// Canonicalize a repoPath for *storage*: trim, drop trailing slashes, but keep
// `~` intact so the value stays portable/readable in the UI. `/Users/x/foo/`
// and `/Users/x/foo` collapse to the same stored form.
export function tidyRepoPath(p: string | null | undefined): string {
  const t = (p ?? "").trim();
  if (!t) return "";
  const stripped = t.replace(/\/+$/, "");
  return stripped || "/"; // a path of only slashes is root
}

// Canonical key for *comparing* two repoPaths that may be written differently —
// `~/code/foo` vs `/Users/me/code/foo` (expandHome) and trailing slashes. Used to
// find an existing project for a path without spawning a duplicate. Empty stays
// empty, so path-less projects never collide with each other here.
export function repoKey(p: string | null | undefined): string {
  return tidyRepoPath(expandHome(p));
}

// Guarantee an existing working directory for a run. Prefer the project's
// repoPath; if it is empty/missing — e.g. a pure-discussion debate, or a project
// whose path was never created — fall back to a per-task scratch dir. This keeps
// read-only phases (discussion, repo-less tasks) alive instead of dying with a
// misleading `spawn ENOENT` on a non-existent cwd. Only the write/implement
// phase needs a real git repo (see prepareWorkspace).
export function ensureWorkdir(repoPath: string | null | undefined, taskId: string): string {
  const p = expandHome(repoPath);
  if (p && isDir(p)) return p;
  const scratch = join(DATA_DIR, "scratch", taskId);
  mkdirSync(scratch, { recursive: true });
  return scratch;
}

export async function isGitRepo(repoPath: string): Promise<boolean> {
  const p = expandHome(repoPath);
  try {
    const { stdout } = await exec("git", ["-C", p, "rev-parse", "--is-inside-work-tree"]);
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

// Cheap, synchronous health for a repoPath — exists + is-it-a-git-repo. Drives
// the at-a-glance health dot everywhere a project is listed; no git spawn.
// `.git` is a *file* in worktrees/submodules, so existsSync (not isDir).
export function projectHealthLight(repoPath: string | null | undefined): ProjectHealth {
  const p = expandHome(repoPath);
  const exists = !!p && isDir(p);
  const gitPath = join(p, ".git");
  const isRepo = exists && existsSync(gitPath);
  // A linked worktree (`git worktree add`) keeps `.git` as a FILE pointing back to
  // the main repo; the main working tree keeps `.git` as a DIR. Surface it so the
  // UI can show when a project's working dir is itself a user-managed worktree.
  const isWorktree = isRepo && isFile(gitPath);
  return { exists, isRepo, isWorktree };
}

// Full health — adds current branch + dirty state. Only spawns git when it's
// actually a repo (so a bogus path like /tmp/demo returns instantly).
export async function projectHealthFull(repoPath: string | null | undefined): Promise<ProjectHealth> {
  const light = projectHealthLight(repoPath);
  if (!light.isRepo) return light;
  const p = expandHome(repoPath);
  let branch: string | null = null;
  let dirty = false;
  try {
    const { stdout } = await exec("git", ["-C", p, "rev-parse", "--abbrev-ref", "HEAD"]);
    branch = stdout.trim() || null; // "HEAD" when detached
  } catch { /* leave null */ }
  try {
    const { stdout } = await exec("git", ["-C", p, "status", "--porcelain"]);
    dirty = stdout.trim().length > 0;
  } catch { /* leave false */ }
  return { ...light, branch, dirty };
}

export interface Workspace {
  path: string;
  branch: string | null;
  isWorktree: boolean;
  // True only when THIS call created an empty worktree on a brand-new branch —
  // i.e. the task's previous work is gone (dir and branch both deleted). Callers
  // that resume an agent's CLI session must break its memory of the old files
  // (see WORKSPACE_RESET in orchestrator.ts): the conversation survives outside
  // the worktree (~/.claude/projects/<escaped cwd>/), so a resumed agent would
  // otherwise keep building on files that no longer exist.
  fresh?: boolean;
}

// Resolve where a run executes — and REPORT its git context, never creating
// anything. This is the path for tasks that DIDN'T opt into a worktree. A run
// happens directly in the project's repoPath (or a per-task scratch dir when
// there's no usable git repo — a repo-less discussion or a missing path). We just
// record the current branch and whether that dir is itself a user-managed linked
// worktree, so the UI can surface it. Tasks with `useWorktree=true` go through
// `prepareWorktree` instead — see below.
export async function resolveWorkspace(repoPath: string, taskId: string): Promise<Workspace> {
  const p = expandHome(repoPath);
  if (await isGitRepo(p)) {
    return { path: p, branch: await currentBranch(p), isWorktree: isFile(join(p, ".git")) };
  }
  return { path: ensureWorkdir(repoPath, taskId), branch: null, isWorktree: false };
}

// ── Opt-in per-task worktree (§4) ────────────────────────────────────────────
// The global factory default is ON; creation callers may explicitly override it.
// When ON, runTask materializes
// `<repoPath>/.worktrees/<taskId>` on branch `harness/<id8>` branched off the
// user-picked `base` (null = current HEAD) BEFORE handing the cwd to the agent.
// harness creates worktrees but never removes them on its own — cleanup is a
// one-click UI action.

// Stable derived branch name. taskId is opaque to users but unique; the first
// 8 chars are enough entropy in practice and keep the ref short/legible.
export function worktreeBranchName(taskId: string): string {
  return `harness/${taskId.slice(0, 8)}`;
}

// Conventional location for harness-managed worktrees: a dotfile dir at the repo
// root so it sits next to .git and stays out of the way. Each task gets its own
// subdir keyed by taskId so re-runs of the same task land on the same worktree.
export function worktreePathFor(repoPath: string, taskId: string): string {
  return join(expandHome(repoPath), ".worktrees", taskId);
}

// If a worktree we previously created for this task still exists on disk, return
// its path + branch so callers can surface it (DELETE /tasks/:id hint, "已存在"
// reuse on re-run). Cheap sync check — no git spawn.
export function detectTaskWorktree(repoPath: string, taskId: string): { path: string; branch: string } | null {
  const path = worktreePathFor(repoPath, taskId);
  if (!isDir(path)) return null;
  // A linked worktree's .git is a file pointing back to the main repo. We don't
  // verify the link target — if the dir is gone, `git worktree remove` from the
  // main repo is what fixes it anyway.
  return { path, branch: worktreeBranchName(taskId) };
}

// List the commits a worktree task produced. The agent's
// commits live on the task's branch since it forked from `base`, so `base..HEAD`
// is exactly them. base = the user-picked ref, else the main repo's current
// branch. Empty when we can't isolate (no worktree / unknown base) — honest, not
// noisy. Capped at 50.
export async function taskCommits(
  worktreePath: string | null | undefined,
  repoPath: string,
  base: string | null | undefined,
): Promise<{ branch: string | null; commits: { sha: string; subject: string; at: string }[] }> {
  const wt = expandHome(worktreePath);
  if (!wt || !isDir(wt)) return { branch: null, commits: [] };
  try {
    const branch = (await currentBranch(wt)) ?? null;
    let baseRef = (base ?? "").trim();
    if (!baseRef) baseRef = (await currentBranch(expandHome(repoPath))) ?? "";
    if (!baseRef || baseRef === branch) return { branch, commits: [] };
    const { stdout } = await exec("git", ["-C", wt, "log", "--format=%H%x1f%s%x1f%cI", "-n", "50", `${baseRef}..HEAD`]);
    const commits = stdout
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [sha, subject, at] = l.split("\x1f");
        return { sha, subject, at };
      });
    return { branch, commits };
  } catch {
    return { branch: null, commits: [] };
  }
}

// Materialize (or reuse) the worktree for this task. Idempotent, and graded by
// how much of the previous work survives:
//   • dir exists         → return as-is (re-run, retry, continue)
//   • dir gone, branch on → RESTORE: `git worktree add <path> <branch>` puts the
//                           agent's files and commits back exactly as they were
//   • dir + branch gone  → `git worktree add -b <branch> <path> [<base>]`, an
//                           EMPTY worktree; flagged `fresh` so resuming callers
//                           can tell the agent its old files are gone
// A dir deleted with plain `rm -rf` leaves a stale registration behind (git still
// lists it, and holds the branch), so prune first — that turns the common
// "I deleted the folder by hand" case back into a clean restore.
// Failures (bad base, .worktrees taken by a non-worktree dir, git permissions)
// throw — the caller (runTask) lets the task settle as failed so the user sees it
// rather than silently falling back to repoPath. `base` is the user-picked ref;
// empty string / null defers to git's default (current HEAD of repoPath).
export async function prepareWorktree(
  repoPath: string,
  taskId: string,
  base: string | null | undefined,
): Promise<Workspace> {
  const repo = expandHome(repoPath);
  if (!(await isGitRepo(repo))) {
    throw new Error(`项目 ${repoPath} 不是 git 仓库，无法创建 worktree`);
  }
  const path = worktreePathFor(repoPath, taskId);
  const branch = worktreeBranchName(taskId);
  if (isDir(path)) {
    // Re-use: read whatever branch the existing worktree is actually on (might
    // differ if the user manipulated it manually). isWorktree=true so callers
    // know it's a linked worktree.
    return { path, branch: (await currentBranch(path)) ?? branch, isWorktree: true };
  }
  // Drop registrations whose directory is gone. Without this, git still considers
  // the branch "checked out" at the missing path and refuses to touch it.
  await exec("git", ["-C", repo, "worktree", "prune"]).catch(() => {});
  // Ensure parent `<repo>/.worktrees/` exists; git itself won't auto-create it.
  mkdirSync(join(repo, ".worktrees"), { recursive: true });
  const restore = await branchExists(repo, branch);
  const args = ["-C", repo, "worktree", "add"];
  if (restore) {
    args.push(path, branch);
  } else {
    args.push("-b", branch, path);
    const trimmedBase = (base ?? "").trim();
    if (trimmedBase) args.push(trimmedBase);
  }
  try {
    await exec("git", args);
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr?.trim() || (err as Error).message;
    throw new Error(`git worktree add 失败：${stderr}`);
  }
  return { path, branch, isWorktree: true, fresh: !restore };
}

// `git worktree remove [--force] <path>` — wired to the one-click cleanup button
// in the delete-task confirmation. Returns nothing on success; throws with the
// raw git stderr so the UI can surface "dirty, use --force" etc.
export async function removeWorktree(repoPath: string, path: string, force: boolean): Promise<void> {
  const repo = expandHome(repoPath);
  const args = ["-C", repo, "worktree", "remove"];
  if (force) args.push("--force");
  args.push(path);
  try {
    await exec("git", args);
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr?.trim() || (err as Error).message;
    throw new Error(stderr);
  }
}

// ── Deterministic acceptance merge / cleanup ───────────────────────────────
// These helpers never checkout another branch in the user's project working
// directory. The only time that directory is touched is when it is ALREADY on
// the target branch and completely clean; git forbids checking that branch out
// in a temporary worktree, so merging in place is the safe, explicit fallback.

export type TaskMergeMethod = "already_merged" | "fast_forward" | "merge_commit";
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
    };

function gitError(error: unknown): string {
  return ((error as { stderr?: string }).stderr || (error as Error).message || String(error)).trim();
}

async function localBranchExists(repo: string, branch: string): Promise<boolean> {
  try {
    await exec("git", ["-C", repo, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

async function symbolicBranch(repo: string): Promise<string | null> {
  try {
    const { stdout } = await exec("git", ["-C", repo, "symbolic-ref", "--quiet", "--short", "HEAD"]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

function normalizeBranchName(branch: string): string {
  return branch.trim().replace(/^refs\/heads\//, "");
}

function sameFilesystemPath(a: string, b: string): boolean {
  try { return realpathSync(resolve(a)) === realpathSync(resolve(b)); }
  catch { return resolve(a) === resolve(b); }
}

export async function resolveTaskMergeTarget(
  repoPath: string,
  requested: string | null | undefined,
): Promise<string | null> {
  const explicit = normalizeBranchName(requested ?? "");
  return explicit || symbolicBranch(expandHome(repoPath));
}

async function isAncestor(repo: string, ancestor: string, descendant: string): Promise<boolean> {
  try {
    await exec("git", ["-C", repo, "merge-base", "--is-ancestor", ancestor, descendant]);
    return true;
  } catch {
    return false;
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

function porcelainFiles(output: string): string[] {
  return output
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(3).trim())
    .filter(Boolean);
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
  const root = mkdtempSync(join(tmpdir(), "harness-accept-"));
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
): Promise<TaskMergeResult> {
  const repo = expandHome(repoPath);
  const sourceBranch = worktreeBranchName(taskId);
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
  if (await isAncestor(repo, sourceBranch, targetBranch)) {
    return { ok: true, sourceBranch, targetBranch, method: "already_merged" };
  }

  // First attempt the ref-only fast-forward. This changes no checked-out files;
  // non-FF and checked-out-target failures fall through to the guarded paths.
  try {
    await exec("git", ["-C", repo, "fetch", ".", `${sourceBranch}:${targetBranch}`]);
    return { ok: true, sourceBranch, targetBranch, method: "fast_forward" };
  } catch (fetchError) {
    await exec("git", ["-C", repo, "worktree", "prune"]).catch(() => {});
    const targetPath = await checkedOutPath(repo, targetBranch).catch(() => null);
    const mainBranch = await symbolicBranch(repo);
    const targetAtRepo = targetPath !== null && sameFilesystemPath(targetPath, repo) && mainBranch === targetBranch;
    const fastForward = await isAncestor(repo, targetBranch, sourceBranch);

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
      return mergeInCheckedOutTarget(repo, sourceBranch, targetBranch, fastForward);
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
    if (fastForward) {
      return {
        ok: false,
        reason: "fast_forward_failed",
        message: `纯 fast-forward 更新 ${targetBranch} 失败：${gitError(fetchError)}`,
        sourceBranch,
        targetBranch,
      };
    }

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
    const result = await mergeInCheckedOutTarget(temp.path, sourceBranch, targetBranch, false);
    const cleanupError = await removeTemporaryWorktree(repo, temp);
    return withTemporaryCleanupOutcome(result, cleanupError, temp.path);
  }
}

export async function cleanupAcceptedTask(
  repoPath: string,
  taskId: string,
  targetBranch: string,
): Promise<TaskCleanupResult> {
  const repo = expandHome(repoPath);
  const sourceBranch = worktreeBranchName(taskId);
  const worktreePath = worktreePathFor(repo, taskId);
  await exec("git", ["-C", repo, "worktree", "prune"]).catch(() => {});
  const hadWorktree = isDir(worktreePath);
  if (hadWorktree) {
    try {
      await removeWorktree(repo, worktreePath, false);
    } catch (error) {
      return {
        ok: false,
        reason: "worktree_remove_failed",
        message: `任务 worktree 删除失败：${gitError(error)}`,
        sourceBranch,
        targetBranch,
        worktreePath,
      };
    }
  }
  await exec("git", ["-C", repo, "worktree", "prune"]).catch(() => {});
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

// List the project's local branch names (for the new-task form's base picker),
// plus the current branch so the UI can default-select it. Quietly returns
// empty when the path isn't a git repo — the picker degrades to a plain text
// field client-side.
export async function listBranches(repoPath: string): Promise<{ branches: string[]; current: string | null }> {
  const p = expandHome(repoPath);
  if (!(await isGitRepo(p))) return { branches: [], current: null };
  let branches: string[] = [];
  try {
    const { stdout } = await exec("git", ["-C", p, "for-each-ref", "--format=%(refname:short)", "refs/heads"]);
    branches = stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  } catch { /* leave [] */ }
  const current = await currentBranch(p);
  return { branches, current };
}

// Does this local branch exist? Decides restore-vs-create in prepareWorktree.
async function branchExists(repo: string, branch: string): Promise<boolean> {
  try {
    await exec("git", ["-C", repo, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

// Current branch of a working dir ("HEAD" when detached); null if git can't tell.
async function currentBranch(p: string): Promise<string | null> {
  try {
    const { stdout } = await exec("git", ["-C", p, "rev-parse", "--abbrev-ref", "HEAD"]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}
