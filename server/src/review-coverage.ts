import { expandHome } from "./git.js";
import { execFileText as exec } from "./exec.js";
const FIELD_SEPARATOR = "\x1f";
const MAX_COMMITS = 100;

export interface ReviewCoverageCommit {
  sha: string;
  subject: string;
  at: string;
  files: string[];
}

export interface ReviewCoverageFinding {
  basis: "artifact_files" | "ended_at_fallback";
  artifactCommits: Pick<ReviewCoverageCommit, "sha" | "subject" | "at">[];
  artifactFiles: string[];
  laterCommits: ReviewCoverageCommit[];
}

export interface ReviewCoverageInput {
  repoPath: string;
  ref?: string | null;
  turnStartedAt?: string | null;
  endedAt?: string | null;
}

async function git(repoPath: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", ["-C", expandHome(repoPath), ...args], {
    maxBuffer: 8 * 1024 * 1024,
    timeout: 5_000,
  });
  return stdout;
}

function parseCommits(output: string): Omit<ReviewCoverageCommit, "files">[] {
  return output
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha = "", subject = "", at = ""] = line.split(FIELD_SEPARATOR);
      return { sha, subject, at };
    })
    .filter((commit) => commit.sha.length > 0);
}

async function logCommits(repoPath: string, args: string[]): Promise<Omit<ReviewCoverageCommit, "files">[]> {
  const output = await git(repoPath, [
    "log",
    `--max-count=${MAX_COMMITS}`,
    `--format=%H${FIELD_SEPARATOR}%s${FIELD_SEPARATOR}%cI`,
    ...args,
  ]);
  return parseCommits(output);
}

async function commitFiles(repoPath: string, sha: string): Promise<string[]> {
  const output = await git(repoPath, [
    "diff-tree",
    "--root",
    "--no-commit-id",
    "--name-only",
    "-r",
    "-m",
    "-z",
    sha,
  ]);
  return [...new Set(output.split("\0").filter(Boolean))].sort();
}

async function withFiles(
  repoPath: string,
  commits: Omit<ReviewCoverageCommit, "files">[],
): Promise<ReviewCoverageCommit[]> {
  return Promise.all(commits.map(async (commit) => ({
    ...commit,
    files: await commitFiles(repoPath, commit.sha),
  })));
}

function gitSecondBoundary(value: string, end: boolean): string | null {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  const second = Math.floor(ms / 1_000) * 1_000;
  return new Date(second + (end ? 999 : 0)).toISOString();
}

// Git only stores commit timestamps to whole-second precision. Round the task
// window outwards to the containing seconds so a commit made in the same second
// as spawn/settlement is not silently missed.
async function artifactCommits(input: ReviewCoverageInput, ref: string) {
  if (!input.turnStartedAt || !input.endedAt) return [];
  const since = gitSecondBoundary(input.turnStartedAt, false);
  const until = gitSecondBoundary(input.endedAt, true);
  if (!since || !until) return [];
  return logCommits(input.repoPath, ["--reverse", `--since=${since}`, `--until=${until}`, ref]);
}

async function fallbackCommits(input: ReviewCoverageInput, ref: string) {
  if (!input.endedAt || !gitSecondBoundary(input.endedAt, true)) return [];
  return logCommits(input.repoPath, ["--reverse", `--after=${input.endedAt}`, ref]);
}

export async function detectReviewCoverage(
  input: ReviewCoverageInput,
): Promise<ReviewCoverageFinding | null> {
  if (!input.repoPath) return null;
  const requestedRef = input.ref?.trim() || "HEAD";
  let ref: string;
  try {
    ref = (await git(input.repoPath, ["rev-parse", "--verify", `${requestedRef}^{commit}`])).trim();
  } catch {
    if (requestedRef === "HEAD") return null;
    try {
      ref = (await git(input.repoPath, ["rev-parse", "--verify", "HEAD^{commit}"])).trim();
    } catch {
      return null;
    }
  }

  try {
    const artifacts = await artifactCommits(input, ref);
    const artifactsWithFiles = await withFiles(input.repoPath, artifacts);
    const artifactFiles = [...new Set(artifactsWithFiles.flatMap((commit) => commit.files))].sort();

    if (artifacts.length > 0 && artifactFiles.length > 0) {
      const lastArtifact = artifacts.at(-1)!;
      const later = await withFiles(
        input.repoPath,
        await logCommits(input.repoPath, ["--reverse", `${lastArtifact.sha}..${ref}`]),
      );
      const fileSet = new Set(artifactFiles);
      const overlaps = later
        .map((commit) => ({ ...commit, files: commit.files.filter((file) => fileSet.has(file)) }))
        .filter((commit) => commit.files.length > 0);
      if (overlaps.length === 0) return null;
      return {
        basis: "artifact_files",
        artifactCommits: artifacts,
        artifactFiles,
        laterCommits: overlaps,
      };
    }
  } catch {
    // If the artifact commit or its file set cannot be recovered, use the
    // explicit endedAt fallback below instead of losing the guard entirely.
  }

  try {
    const later = await withFiles(input.repoPath, await fallbackCommits(input, ref));
    if (later.length === 0) return null;
    return {
      basis: "ended_at_fallback",
      artifactCommits: [],
      artifactFiles: [],
      laterCommits: later,
    };
  } catch {
    // Coverage detection is defensive metadata. A deleted repo or old task
    // without usable timestamps must not break review settlement.
    return null;
  }
}

const list = (values: string[], limit = 12) => {
  const shown = values.slice(0, limit).join("、") || "(无文件记录)";
  return values.length > limit ? `${shown} 等 ${values.length} 个文件` : shown;
};

export function formatReviewCoverageFacts(finding: ReviewCoverageFinding): string {
  const basis = finding.basis === "artifact_files"
    ? `被审产物提交 ${finding.artifactCommits.map((commit) => commit.sha).join("、")} 的文件集之后`
    : "无法可靠定位被审产物提交，已退化按任务结束时间检查；任务结束之后";
  const commits = finding.laterCommits.slice(0, 12).map((commit) =>
    `- ${commit.sha} ${commit.subject || "(无提交说明)"}；触及文件：${list(commit.files)}`,
  );
  if (finding.laterCommits.length > commits.length) {
    commits.push(`- 另有 ${finding.laterCommits.length - commits.length} 个后续提交`);
  }
  return `覆盖检测事实（仅说明 Git 历史，是否有意由人拍板）：${basis}存在后续提交：\n${commits.join("\n")}`;
}

export function repairCoverageGuard(finding: ReviewCoverageFinding | null): string {
  if (!finding) return "";
  return `${formatReviewCoverageFacts(finding)}\n` +
    "不要直接恢复你原来的改动。先调用 ask_question 说明后续提交、冲突文件和审查发现，等调度者或用户拍板后再继续。";
}
