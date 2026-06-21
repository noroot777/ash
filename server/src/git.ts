import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync, statSync, existsSync } from "node:fs";
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
}

// Resolve where a run executes — and REPORT its git context, never creating
// anything. harness no longer manages worktrees; that is the user's call now. A
// run happens directly in the project's repoPath (or a per-task scratch dir when
// there's no usable git repo — a repo-less discussion or a missing path). We just
// record the current branch and whether that dir is itself a user-managed linked
// worktree, so the UI can surface it.
export async function resolveWorkspace(repoPath: string, taskId: string): Promise<Workspace> {
  const p = expandHome(repoPath);
  if (await isGitRepo(p)) {
    return { path: p, branch: await currentBranch(p), isWorktree: isFile(join(p, ".git")) };
  }
  return { path: ensureWorkdir(repoPath, taskId), branch: null, isWorktree: false };
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
