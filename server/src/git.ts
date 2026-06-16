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

// Users type `~/code/foo`, but Node's fs/git APIs don't understand `~` (only
// shells do) — so expand a leading `~` to the home dir before any filesystem
// use. Applied at every repoPath boundary below so `~` works system-wide.
export function expandHome(p: string | null | undefined): string {
  if (!p) return "";
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
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
  const isRepo = exists && existsSync(join(p, ".git"));
  return { exists, isRepo };
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

// Best-effort removal of a task's worktree when a project is deleted. Silent on
// any failure (repo may be gone, worktree may never have existed).
export async function removeWorktree(repoPath: string, taskId: string): Promise<void> {
  const p = expandHome(repoPath);
  try {
    await exec("git", ["-C", p, "worktree", "remove", "--force", join(".worktrees", taskId)]);
    await exec("git", ["-C", p, "worktree", "prune"]);
  } catch { /* best effort */ }
}

export interface Workspace {
  path: string;
  branch: string | null;
  isWorktree: boolean;
}

// Create an isolated git worktree + branch for a task (DESIGN.md §4).
// Falls back to the repo path itself when worktree isn't possible/wanted.
export async function prepareWorkspace(
  repoPath: string,
  taskId: string,
  useWorktree: boolean,
): Promise<Workspace> {
  repoPath = expandHome(repoPath);
  if (!useWorktree || !(await isGitRepo(repoPath))) {
    return { path: repoPath, branch: null, isWorktree: false };
  }
  const branch = `harness/${taskId}`;
  const path = join(repoPath, ".worktrees", taskId);
  try {
    await exec("git", ["-C", repoPath, "worktree", "add", "-b", branch, path, "HEAD"]);
  } catch (e: any) {
    // Branch/worktree may already exist from a prior run — reuse it.
    if (/already exists/i.test(e?.stderr ?? "")) {
      try {
        await exec("git", ["-C", repoPath, "worktree", "add", path, branch]);
      } catch {
        return { path: repoPath, branch: null, isWorktree: false };
      }
    } else {
      return { path: repoPath, branch: null, isWorktree: false };
    }
  }
  return { path, branch, isWorktree: true };
}

// Resolve where a run executes. A worktree only makes sense when the *project's*
// repoPath is a real git repo; otherwise (repo-less discussion, or a missing
// path) we run directly in a scratch dir — never trying to worktree the scratch
// dir, which would create stray worktrees/branches in whatever repo contains it.
export async function resolveWorkspace(
  repoPath: string,
  taskId: string,
  useWorktree: boolean,
): Promise<Workspace> {
  if (await isGitRepo(repoPath)) return prepareWorkspace(repoPath, taskId, useWorktree);
  return { path: ensureWorkdir(repoPath, taskId), branch: null, isWorktree: false };
}

// Commit whatever the implementer changed in its worktree (DESIGN.md §4: default
// auto-commit). No-op if nothing changed. Returns the commit sha or null.
export async function commitWorktree(path: string, message: string): Promise<string | null> {
  try {
    await exec("git", ["-C", path, "add", "-A"]);
    const { stdout: status } = await exec("git", ["-C", path, "status", "--porcelain"]);
    if (!status.trim()) return null; // nothing to commit
    await exec("git", [
      "-C",
      path,
      "-c",
      "user.name=harness",
      "-c",
      "user.email=harness@local",
      "commit",
      "-m",
      message,
    ]);
    const { stdout: sha } = await exec("git", ["-C", path, "rev-parse", "HEAD"]);
    return sha.trim();
  } catch {
    return null;
  }
}
