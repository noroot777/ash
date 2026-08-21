// 验证证据的落盘与读取：报告、截图、结论文件，全部住在
// `data/runs/<被验 taskId>/review/round-<n>/`。
//
// 从 review.ts 拆出来是因为这一层跟「谁来验、验完怎么走」完全无关：它只回答
// 「这一轮的证据在哪、怎么读才安全」。安全那部分（symlink 祖先、O_EXCL 写结论）
// 是有回归测试钉住的边界，单独成文件才不会跟编排逻辑搅在一起改坏。
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readFile, readdir } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ReviewConclusion } from "@ash/shared";
import { RUNS_DIR } from "./paths.js";
import { now } from "./util.js";

export const REVIEW_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".md": "text/markdown; charset=utf-8",
};

export function reviewRoundDir(taskId: string, round: number): string {
  return join(RUNS_DIR, taskId, "review", `round-${round}`);
}

export function nextReviewRound(existingRounds: number): number {
  return Math.max(0, Math.floor(existingRounds)) + 1;
}

// Resolve only one file inside a single round directory. Both the route and its
// regression test use this helper so path traversal cannot drift from policy.
export function safeReviewFilePath(taskId: string, round: number, name: string): string | null {
  if (
    !Number.isInteger(round) ||
    round < 1 ||
    !taskId ||
    basename(taskId) !== taskId ||
    !name ||
    basename(name) !== name
  ) return null;
  const base = resolve(reviewRoundDir(taskId, round));
  const file = resolve(base, name);
  return file.startsWith(base + sep) ? file : null;
}

// Lexical containment is not enough: a reviewer can replace `review` or
// `round-N` with a symlink and make an otherwise harmless `report.md` resolve
// outside RUNS_DIR. Walk every directory component with lstat so both reads and
// server-owned conclusion writes reject symlink ancestors.
export async function safeRunDirectory(dir: string, create = false): Promise<boolean> {
  const root = resolve(RUNS_DIR);
  const target = resolve(dir);
  const rel = relative(root, target);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return false;
  if (create) await mkdir(root, { recursive: true });
  try {
    const rootStat = await lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return false;
  } catch {
    return false;
  }
  let current = root;
  for (const part of rel.split(sep)) {
    current = join(current, part);
    if (create) await mkdir(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    try {
      const stat = await lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    } catch {
      return false;
    }
  }
  return true;
}

export async function readReport(taskId: string, round: number): Promise<string> {
  return (await readReviewFile(taskId, round, "report.md"))?.toString("utf8") ?? "";
}

export async function screenshots(taskId: string, round: number): Promise<string[]> {
  try {
    const dir = reviewRoundDir(taskId, round);
    if (!(await safeRunDirectory(dir))) return [];
    return (await readdir(dir, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && [".png", ".jpg", ".jpeg"].includes(extname(entry.name).toLowerCase()))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

export async function readReviewFile(taskId: string, round: number, name: string): Promise<Buffer | null> {
  const file = safeReviewFilePath(taskId, round, name);
  if (!file) return null;
  try {
    if (!(await safeRunDirectory(reviewRoundDir(taskId, round)))) return null;
    // lstat (not stat) rejects symlinks, including a reviewer-created link to a
    // file outside the evidence directory with an otherwise harmless .md name.
    if (!(await lstat(file)).isFile()) return null;
    return await readFile(file);
  } catch {
    return null;
  }
}

// reviewTaskId 为 null = 就地验证轮（没有另一个任务），历史的独立审查任务才有 id。
export async function writeConclusion(
  targetId: string,
  round: number,
  reviewTaskId: string | null,
  conclusion: ReviewConclusion,
): Promise<void> {
  if (!conclusion) return;
  const dir = reviewRoundDir(targetId, round);
  if (!(await safeRunDirectory(dir, true))) return;
  const file = join(dir, "conclusion.json");
  try {
    const handle = await open(
      file,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(
        JSON.stringify({ conclusion, reviewTaskId, recordedAt: now() }, null, 2) + "\n",
      );
    } finally {
      await handle.close();
    }
  } catch (error) {
    // A conclusion is immutable once recorded. EEXIST also covers a malicious
    // final symlink without following or overwriting its target.
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

export async function readConclusion(targetId: string, round: number): Promise<ReviewConclusion> {
  try {
    const raw = await readReviewFile(targetId, round, "conclusion.json");
    if (!raw) return null;
    const parsed = JSON.parse(raw.toString("utf8")) as {
      conclusion?: unknown;
    };
    return parsed.conclusion === "verified" || parsed.conclusion === "verify_failed"
      ? parsed.conclusion
      : null;
  } catch {
    return null;
  }
}
