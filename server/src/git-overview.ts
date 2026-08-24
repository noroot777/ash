import { expandHome, listBranches } from "./git.js";
import { execFileText as exec } from "./exec.js";

export type GitWorktreeOverview = {
  path: string;
  branch: string | null;
  head: string | null;
  detached: boolean;
};

export type GitOverview = {
  branches: string[];
  current: string | null;
  worktrees: GitWorktreeOverview[];
};

export function parseWorktreePorcelain(output: string): GitWorktreeOverview[] {
  const worktrees: GitWorktreeOverview[] = [];
  let current: GitWorktreeOverview | null = null;
  const finish = () => {
    if (current) worktrees.push(current);
    current = null;
  };

  for (const field of output.split("\0")) {
    if (!field) {
      finish();
      continue;
    }
    const separator = field.indexOf(" ");
    const key = separator < 0 ? field : field.slice(0, separator);
    const value = separator < 0 ? "" : field.slice(separator + 1);
    if (key === "worktree") {
      finish();
      current = { path: value, branch: null, head: null, detached: false };
    } else if (current && key === "HEAD") {
      current.head = value || null;
    } else if (current && key === "branch") {
      current.branch = value.replace(/^refs\/heads\//, "") || null;
    } else if (current && key === "detached") {
      current.detached = true;
    }
  }
  finish();
  return worktrees;
}

export async function getGitOverview(repoPath: string): Promise<GitOverview> {
  const branchOverview = await listBranches(repoPath);
  try {
    const { stdout } = await exec(
      "git",
      ["-C", expandHome(repoPath), "worktree", "list", "--porcelain", "-z"],
      { maxBuffer: 2 * 1024 * 1024 },
    );
    return { ...branchOverview, worktrees: parseWorktreePorcelain(stdout) };
  } catch {
    return { ...branchOverview, worktrees: [] };
  }
}
