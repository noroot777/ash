import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cappedGitStdout } from "./git-exec.js";
import { expandHome, isGitRepo, resolveTaskMergeTarget, resolveWorktreeBranchName } from "./git.js";

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

function parseNumstat(numstat: string): TaskDiffFile[] {
  return numstat.split("\n").filter(Boolean).map((line): TaskDiffFile => {
    const [additions, deletions, ...pathParts] = line.split("\t");
    return {
      path: pathParts.join("\t"),
      additions: additions === "-" ? null : Number(additions),
      deletions: deletions === "-" ? null : Number(deletions),
    };
  });
}

async function localBranchExists(repo: string, branch: string): Promise<boolean> {
  try {
    await exec("git", ["-C", repo, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

export async function taskBranchDiff(
  repoPath: string,
  taskId: string,
  requestedTarget: string | null | undefined,
  limitBytes = DIFF_LIMIT_BYTES,
): Promise<TaskDiffResult> {
  const repo = expandHome(repoPath);
  const sourceBranch = await resolveWorktreeBranchName(repo, taskId);
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
  const files = parseNumstat(numstat);
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

/** 验收后原任务分支/worktree 已清理，按冻结的准确 commit 区间读取合并结果。 */
export async function acceptedCommitDiff(
  repoPath: string,
  branch: string,
  baseCommit: string,
  mergeCommit: string,
  limitBytes = DIFF_LIMIT_BYTES,
): Promise<TaskDiffResult> {
  const repo = expandHome(repoPath);
  const sourceBranch = `${branch}@${baseCommit.slice(0, 8)}`;
  const targetBranch = `${branch}@${mergeCommit.slice(0, 8)}`;
  const empty = (reason: string): TaskDiffResult => ({
    available: false,
    sourceBranch,
    targetBranch,
    mergeBase: baseCommit,
    diff: "",
    files: [],
    truncated: false,
    limitBytes,
    reason,
  });
  if (!(await isGitRepo(repo))) return empty("not_git_repo");
  try {
    const [{ stdout: numstat }, diff] = await Promise.all([
      exec("git", ["-C", repo, "diff", "--numstat", baseCommit, mergeCommit], { maxBuffer: 16 * 1024 * 1024 }),
      cappedGitStdout(repo, ["diff", "--no-ext-diff", "--no-color", "--unified=3", baseCommit, mergeCommit], limitBytes),
    ]);
    return {
      available: true,
      sourceBranch,
      targetBranch,
      mergeBase: baseCommit,
      diff: diff.text,
      files: parseNumstat(numstat),
      truncated: diff.truncated,
      limitBytes,
    };
  } catch {
    return empty("accepted_snapshot_unreadable");
  }
}
