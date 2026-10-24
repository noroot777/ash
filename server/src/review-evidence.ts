// 验证证据的落盘与读取：报告、截图、结论文件，全部住在
// `data/runs/<被验 taskId>/review/round-<n>/`。
//
// 从 review.ts 拆出来是因为这一层跟「谁来验、验完怎么走」完全无关：它只回答
// 「这一轮的证据在哪、怎么读才安全」。安全那部分（symlink 祖先、O_EXCL 写结论）
// 是有回归测试钉住的边界，单独成文件才不会跟编排逻辑搅在一起改坏。
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ReviewConclusion } from "@ash/shared";
import {
  containedPath,
  evidenceSegments,
  EVIDENCE_IMAGE_EXTENSIONS,
  EVIDENCE_MAX_DEPTH,
} from "./evidence-path.js";
import { RUNS_DIR } from "./paths.js";
import { id, now } from "./util.js";

/**
 * 往证据目录里**原子替换**一个普通文件。
 *
 * 不直接 writeFile：目标可能已经被换成 symlink，写下去就落到证据根之外。先用
 * O_EXCL|O_NOFOLLOW 写一个临时文件，再 rename 顶上去——rename 换的是目录项本身，
 * 不会顺着旧文件上的 symlink 走。调用方要先 `safeRunDirectory(dir, true)` 保证祖先干净。
 */
export async function replaceEvidenceFile(path: string, content: string): Promise<void> {
  const temporary = join(dirname(path), `.${basename(path)}.${id()}.tmp`);
  const handle = await open(
    temporary,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(content);
    await handle.close();
    await rename(temporary, path);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}



export function reviewRoundDir(taskId: string, round: number): string {
  return join(RUNS_DIR, taskId, "review", `round-${round}`);
}

export function nextReviewRound(existingRounds: number): number {
  return Math.max(0, Math.floor(existingRounds)) + 1;
}

// Resolve only one file inside a single round directory. Both the route and its
// regression test use this helper so path traversal cannot drift from policy.
// `name` 是证据目录内的相对路径，**允许子目录**（审查者把截图归到 `shots/` 是合法写法；
// 形状判据见 evidence-path.ts）。词法包含在这里判，符号链接祖先由 readReviewFile 的
// safeRunDirectory + containedPath 判 —— 这个函数也用在「该回 400 还是 404」的判断上，
// 不碰磁盘。
export function safeReviewFilePath(taskId: string, round: number, name: string): string | null {
  if (!Number.isInteger(round) || round < 1 || !taskId || basename(taskId) !== taskId) return null;
  const segments = evidenceSegments(name);
  if (!segments) return null;
  const base = resolve(reviewRoundDir(taskId, round));
  const file = resolve(base, ...segments);
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

// 子目录一起列（跟 free-review-files.ts 的 filesUnder 同一口径）：归到 `shots/` 里的那
// 几张接口服务得了，列不出来就等于截图条里没有。深度与类型跟**能不能服务**共用一份常量
// （evidence-path.ts）—— 这份清单以前不收 WebP，自由工作流那份收（审查第 2 轮 N1）。
async function filesUnder(
  dir: string,
  prefix: string,
  depth: number,
  extensions: ReadonlySet<string>,
): Promise<string[]> {
  if (depth <= 0) return [];
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    // isSymbolicLink 先问：指向目录的符号链接 isDirectory() 是 false，跟着走会爬出证据根。
    if (entry.isSymbolicLink()) continue;
    const name = `${prefix}${entry.name}`;
    if (entry.isDirectory()) found.push(...await filesUnder(join(dir, entry.name), `${name}/`, depth - 1, extensions));
    else if (entry.isFile() && extensions.has(extname(entry.name).toLowerCase())) found.push(name);
  }
  return found;
}

async function listEvidence(taskId: string, round: number, extensions: ReadonlySet<string>): Promise<string[]> {
  try {
    const dir = reviewRoundDir(taskId, round);
    if (!(await safeRunDirectory(dir))) return [];
    return (await filesUnder(dir, "", EVIDENCE_MAX_DEPTH, extensions)).sort();
  } catch {
    return [];
  }
}

/** 截图条铺的那几张（图片类型）。 */
export async function screenshots(taskId: string, round: number): Promise<string[]> {
  return listEvidence(taskId, round, EVIDENCE_IMAGE_EXTENSIONS);
}

export async function readReviewFile(taskId: string, round: number, name: string): Promise<Buffer | null> {
  const file = safeReviewFilePath(taskId, round, name);
  if (!file) return null;
  try {
    const base = resolve(reviewRoundDir(taskId, round));
    if (!(await safeRunDirectory(base))) return null;
    // lstat (not stat) rejects symlinks, including a reviewer-created link to a
    // file outside the evidence directory with an otherwise harmless .md name.
    if (!(await lstat(file)).isFile()) return null;
    // 放开子目录之后，**中间那几段**也可能是符号链接 —— 词法前缀和对最终文件的 lstat 都
    // 看不出来，只有解完链接再比根能看出来。
    if (!containedPath(base, file)) return null;
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
  strict = false,
): Promise<void> {
  if (!conclusion) return;
  const dir = reviewRoundDir(targetId, round);
  if (!(await safeRunDirectory(dir, true))) {
    if (strict) throw new Error("审查结论目录安全检查不通过");
    return;
  }
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
    if (strict && await readConclusion(targetId, round) !== conclusion) throw new Error("审查结论文件不可读或与持久结论不一致");
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
