import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";

const exec = promisify(execFile);

export async function isGitRepo(repoPath: string): Promise<boolean> {
  try {
    const { stdout } = await exec("git", ["-C", repoPath, "rev-parse", "--is-inside-work-tree"]);
    return stdout.trim() === "true";
  } catch {
    return false;
  }
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
