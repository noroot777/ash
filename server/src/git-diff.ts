import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cappedGitStdout } from "./git-exec.js";
import { literalPathspec } from "./git-status.js";
import { expandHome, isGitRepo, resolveTaskMergeTarget, resolveWorktreeBranchName } from "./git.js";

const exec = promisify(execFile);
const DIFF_LIMIT_BYTES = 1024 * 1024;

export interface TaskDiffFile {
  path: string;
  additions: number | null;
  deletions: number | null;
  /** 改名/复制的来源路径。要按路径再单独 diff 这一个文件时，两头都得给 git。 */
  origPath: string | null;
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

/** 单个文件在某个提交区间上的 diff。形状对齐工作区那份 `ScmFileDiff`，中间栏用同一个查看器渲染。 */
export interface TaskFileDiffResult {
  available: boolean;
  path: string;
  origPath: string | null;
  diff: string;
  truncated: boolean;
  limitBytes: number;
  binary: boolean;
  reason?: string;
}

/**
 * `--numstat -z` 的输出 → 文件清单。
 *
 * 必须走 `-z`：默认输出会把非 ASCII 路径按 C 风格转义成 `"\344\275\240.txt"`，中文文件名
 * 在清单上就是一串八进制——更要命的是那串东西**当不了 pathspec**，点它单独看 diff 会
 * 落空。`-z` 给的是原样字节。
 *
 * 代价是改名的记录形状不同：普通行是 `add\tdel\tpath\0`，改名/复制则把路径拆成两条独立
 * 记录 `add\tdel\t\0old\0new\0`（默认输出里那个 `{a => b}` 合成路径同样不能当 pathspec 用）。
 */
function parseNumstat(numstat: string): TaskDiffFile[] {
  const fields = numstat.split("\0");
  const files: TaskDiffFile[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const match = /^(\S+)\t(\S+)\t([\s\S]*)$/.exec(fields[index] ?? "");
    if (!match) continue;
    const [, additions, deletions, inlinePath] = match;
    let path = inlinePath;
    let origPath: string | null = null;
    if (!path) {
      origPath = fields[index + 1] ?? "";
      path = fields[index + 2] ?? "";
      index += 2;
    }
    if (!path) continue;
    files.push({
      path,
      origPath: origPath || null,
      additions: additions === "-" ? null : Number(additions),
      deletions: deletions === "-" ? null : Number(deletions),
    });
  }
  return files;
}

/** 单个文件在 `from..to` 上的 diff。改名时两头路径都要给，只给新路径会得到一份空 diff。 */
async function rangeFileDiff(
  repo: string,
  from: string,
  to: string,
  path: string,
  origPath: string | null,
  limitBytes: number,
): Promise<TaskFileDiffResult> {
  const result = await cappedGitStdout(repo, [
    "diff", "--no-ext-diff", "--no-color", "--unified=3", "-M", from, to, "--",
    ...(origPath ? [literalPathspec(origPath)] : []),
    literalPathspec(path),
  ], limitBytes);
  return {
    available: true,
    path,
    origPath,
    diff: result.text,
    truncated: result.truncated,
    limitBytes,
    binary: /^Binary files .* differ$/m.test(result.text),
  };
}

function fileDiffUnavailable(path: string, origPath: string | null, reason: string, limitBytes: number): TaskFileDiffResult {
  return { available: false, path, origPath, diff: "", truncated: false, limitBytes, binary: false, reason };
}

async function localBranchExists(repo: string, branch: string): Promise<boolean> {
  try {
    await exec("git", ["-C", repo, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

type BranchRange =
  | { ok: true; sourceBranch: string; targetBranch: string; mergeBase: string }
  | { ok: false; sourceBranch: string; targetBranch: string | null; reason: string };

/**
 * 「这条任务分支相对合入目标」是哪一段区间——整份 diff 和单文件 diff 必须问同一句话，
 * 否则清单上列出来的文件、点进去按另一段区间比，得到的会是另一份内容（甚至空的）。
 */
async function taskBranchRange(
  repo: string,
  taskId: string,
  requestedTarget: string | null | undefined,
): Promise<BranchRange> {
  // 分支名走 resolveWorktreeBranchName：改名成 ash 之后新任务是 `ash/xxx`，改名前建的
  // 老任务还挂在 `harness/xxx` 上，这里得两边都认，否则老任务一律报 source_branch_missing。
  const sourceBranch = await resolveWorktreeBranchName(repo, taskId);
  const fail = (targetBranch: string | null, reason: string): BranchRange =>
    ({ ok: false, sourceBranch, targetBranch, reason });
  if (!(await isGitRepo(repo))) return fail(null, "not_git_repo");
  const targetBranch = await resolveTaskMergeTarget(repo, requestedTarget);
  if (!targetBranch) return fail(null, "target_unresolved");
  if (!(await localBranchExists(repo, sourceBranch))) return fail(targetBranch, "source_branch_missing");
  if (!(await localBranchExists(repo, targetBranch))) return fail(targetBranch, "target_branch_missing");
  try {
    const { stdout } = await exec("git", ["-C", repo, "merge-base", targetBranch, sourceBranch]);
    return { ok: true, sourceBranch, targetBranch, mergeBase: stdout.trim() };
  } catch {
    return fail(targetBranch, "no_merge_base");
  }
}

export async function taskBranchDiff(
  repoPath: string,
  taskId: string,
  requestedTarget: string | null | undefined,
  limitBytes = DIFF_LIMIT_BYTES,
): Promise<TaskDiffResult> {
  const repo = expandHome(repoPath);
  const range = await taskBranchRange(repo, taskId, requestedTarget);
  if (!range.ok) {
    return {
      available: false,
      sourceBranch: range.sourceBranch,
      targetBranch: range.targetBranch,
      mergeBase: null,
      diff: "",
      files: [],
      truncated: false,
      limitBytes,
      reason: range.reason,
    };
  }
  const { mergeBase, sourceBranch, targetBranch } = range;
  const [{ stdout: numstat }, diff] = await Promise.all([
    exec("git", ["-C", repo, "diff", "--numstat", "-z", mergeBase, sourceBranch], { maxBuffer: 16 * 1024 * 1024 }),
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

/**
 * 清单里点开的那一个文件。
 *
 * 为什么不在前端把整份 diff 切开就算了：整份是**带上限**读的（默认 1 MB），大改动里排在
 * 后面的文件在那份文本里根本不存在，切出来是空的。单独读一次，谁都不会落空。
 */
export async function taskBranchFileDiff(
  repoPath: string,
  taskId: string,
  requestedTarget: string | null | undefined,
  path: string,
  origPath: string | null = null,
  limitBytes = DIFF_LIMIT_BYTES,
): Promise<TaskFileDiffResult> {
  const repo = expandHome(repoPath);
  const range = await taskBranchRange(repo, taskId, requestedTarget);
  if (!range.ok) return fileDiffUnavailable(path, origPath, range.reason, limitBytes);
  return rangeFileDiff(repo, range.mergeBase, range.sourceBranch, path, origPath, limitBytes);
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
      exec("git", ["-C", repo, "diff", "--numstat", "-z", baseCommit, mergeCommit], { maxBuffer: 16 * 1024 * 1024 }),
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

/** 已验收任务的单文件 diff——清单来自 `acceptedCommitDiff`，点开时按同一段 commit 区间读。 */
export async function acceptedCommitFileDiff(
  repoPath: string,
  baseCommit: string,
  mergeCommit: string,
  path: string,
  origPath: string | null = null,
  limitBytes = DIFF_LIMIT_BYTES,
): Promise<TaskFileDiffResult> {
  const repo = expandHome(repoPath);
  if (!(await isGitRepo(repo))) return fileDiffUnavailable(path, origPath, "not_git_repo", limitBytes);
  try {
    return await rangeFileDiff(repo, baseCommit, mergeCommit, path, origPath, limitBytes);
  } catch {
    return fileDiffUnavailable(path, origPath, "accepted_snapshot_unreadable", limitBytes);
  }
}
