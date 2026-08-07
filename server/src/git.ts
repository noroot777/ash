import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, isAbsolute, dirname } from "node:path";
import { homedir } from "node:os";
import { mkdirSync, statSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import type { ProjectHealth } from "@harness/shared";
import { DATA_DIR } from "./paths.js";
import { withRepoLock } from "./repo-lock.js";

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
// repoPath; if it is empty/missing — e.g. a pure-discussion duet, or a project
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

// 「这个任务留下的 worktree/分支还在不在」搬到了 ./workspace-cleanup.ts
// (detectTaskWorkspace):删除任务时要连分支一起问,光看目录在不在已经不够。

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
// harness 把任务 worktree 建在 `<repo>/.worktrees/` —— 那是**用户仓库里的一个目录**，
// 不登记忽略的话 `git status --porcelain` 就永远不空，于是验收的原地合并一律被
// `target_dirty` 挡掉：这个项目从此再也验收不成功。写进 `.git/info/exclude` 而不是
// `.gitignore`：忽略是 harness 自己的实现细节，不该往用户仓库里塞一个待提交的改动。
// 幂等（已有同样一行就不再写），失败只警告——它不该拦住任务开工。
async function ensureWorktreesIgnored(repo: string): Promise<void> {
  const entry = ".worktrees/";
  try {
    // worktree 里的 .git 是文件而不是目录，exclude 只存在于 common dir。
    const commonDir = (await exec("git", ["-C", repo, "rev-parse", "--git-common-dir"])).stdout.trim();
    const gitDir = isAbsolute(commonDir) ? commonDir : join(repo, commonDir);
    const excludePath = join(gitDir, "info", "exclude");
    const current = existsSync(excludePath) ? readFileSync(excludePath, "utf8") : "";
    if (current.split("\n").some((line) => line.trim() === entry)) return;
    mkdirSync(dirname(excludePath), { recursive: true });
    writeFileSync(
      excludePath,
      `${current}${current && !current.endsWith("\n") ? "\n" : ""}# harness 任务 worktree（本地忽略，不入库）\n${entry}\n`,
    );
  } catch (err) {
    console.warn("[harness] 无法把 .worktrees/ 写进 .git/info/exclude：", err instanceof Error ? err.message : err);
  }
}

// 仓库级串行(见 repo-lock.ts):prune/add 改的是全仓共用的 worktree 注册表,
// 两个任务同时起跑就会互相看见对方半成品的注册状态。
export async function prepareWorktree(
  repoPath: string,
  taskId: string,
  base: string | null | undefined,
): Promise<Workspace> {
  return withRepoLock(repoPath, () => prepareWorktreeLocked(repoPath, taskId, base));
}

async function prepareWorktreeLocked(
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
  await ensureWorktreesIgnored(repo);
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
  return withRepoLock(repoPath, async () => {
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
  });
}

// ── 分支与合并目标：验收链（git-accept.ts）与 diff/清理都要用的那几句 ─────────

export function gitError(error: unknown): string {
  return ((error as { stderr?: string }).stderr || (error as Error).message || String(error)).trim();
}

export async function localBranchExists(repo: string, branch: string): Promise<boolean> {
  try {
    await exec("git", ["-C", repo, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

/** 当前检出的分支名（detached 时 null）。git-accept 判「目标分支在不在项目目录上」要用。 */
export async function symbolicBranch(repo: string): Promise<string | null> {
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

export async function resolveTaskMergeTarget(
  repoPath: string,
  requested: string | null | undefined,
): Promise<string | null> {
  const explicit = normalizeBranchName(requested ?? "");
  return explicit || symbolicBranch(expandHome(repoPath));
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
