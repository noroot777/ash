import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { expandHome, isGitRepo, resolveTaskMergeTarget, worktreeBranchName } from "./git.js";

const exec = promisify(execFile);
const DIFF_LIMIT_BYTES = 1024 * 1024;

export interface TaskDiffFile {
  path: string;
  additions: number | null;
  deletions: number | null;
}

export interface TaskDiffResult {
  available: boolean;
  sourceBranch: string;
  targetBranch: string | null;
  mergeBase: string | null;
  diff: string;
  files: TaskDiffFile[];
  truncated: boolean;
  limitBytes: number;
  reason?: string;
}

async function localBranchExists(repo: string, branch: string): Promise<boolean> {
  try {
    await exec("git", ["-C", repo, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

async function cappedGitStdout(
  repo: string,
  args: string[],
  limitBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", repo, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    let size = 0;
    let errorSize = 0;
    let truncated = false;
    child.stdout.on("data", (chunk: Buffer) => {
      if (size >= limitBytes) {
        truncated = true;
        return;
      }
      const remaining = limitBytes - size;
      const kept = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      chunks.push(kept);
      size += kept.length;
      if (kept.length < chunk.length) truncated = true;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (errorSize >= 64 * 1024) return;
      const kept = chunk.subarray(0, 64 * 1024 - errorSize);
      errors.push(kept);
      errorSize += kept.length;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve({ text: Buffer.concat(chunks).toString("utf8"), truncated });
      else reject(new Error(Buffer.concat(errors).toString("utf8").trim() || `git exited ${code}`));
    });
  });
}

export async function taskBranchDiff(
  repoPath: string,
  taskId: string,
  requestedTarget: string | null | undefined,
  limitBytes = DIFF_LIMIT_BYTES,
): Promise<TaskDiffResult> {
  const repo = expandHome(repoPath);
  const sourceBranch = worktreeBranchName(taskId);
  const empty = (targetBranch: string | null, reason: string): TaskDiffResult => ({
    available: false,
    sourceBranch,
    targetBranch,
    mergeBase: null,
    diff: "",
    files: [],
    truncated: false,
    limitBytes,
    reason,
  });
  if (!(await isGitRepo(repo))) return empty(null, "not_git_repo");
  const targetBranch = await resolveTaskMergeTarget(repo, requestedTarget);
  if (!targetBranch) return empty(null, "target_unresolved");
  if (!(await localBranchExists(repo, sourceBranch))) return empty(targetBranch, "source_branch_missing");
  if (!(await localBranchExists(repo, targetBranch))) return empty(targetBranch, "target_branch_missing");
  let mergeBase: string;
  try {
    const { stdout } = await exec("git", ["-C", repo, "merge-base", targetBranch, sourceBranch]);
    mergeBase = stdout.trim();
  } catch {
    return empty(targetBranch, "no_merge_base");
  }
  const [{ stdout: numstat }, diff] = await Promise.all([
    exec("git", ["-C", repo, "diff", "--numstat", mergeBase, sourceBranch], { maxBuffer: 16 * 1024 * 1024 }),
    cappedGitStdout(repo, ["diff", "--no-ext-diff", "--no-color", "--unified=3", mergeBase, sourceBranch], limitBytes),
  ]);
  const files = numstat
    .split("\n")
    .filter(Boolean)
    .map((line): TaskDiffFile => {
      const [additions, deletions, ...pathParts] = line.split("\t");
      return {
        path: pathParts.join("\t"),
        additions: additions === "-" ? null : Number(additions),
        deletions: deletions === "-" ? null : Number(deletions),
      };
    });
  return {
    available: true,
    sourceBranch,
    targetBranch,
    mergeBase,
    diff: diff.text,
    files,
    truncated: diff.truncated,
    limitBytes,
  };
}
