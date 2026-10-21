import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  containedPath,
  evidenceSegments,
  EVIDENCE_IMAGE_EXTENSIONS,
  EVIDENCE_MAX_DEPTH,
  EVIDENCE_SERVABLE_EXTENSIONS,
} from "./evidence-path.js";
import { RUNS_DIR } from "./paths.js";

export function freeReviewEvidenceDir(taskId: string, runId: string, round: number): string {
  return join(RUNS_DIR, taskId, "free-review", runId, `round-${round}`);
}

export function freeReviewReportPath(taskId: string, runId: string, round: number): string {
  return join(freeReviewEvidenceDir(taskId, runId, round), "report.md");
}

// 词法包含不够：审查者可以把 `free-review` 或 `round-N` 换成 symlink，让一个看似无害的
// report.md 解析到 RUNS_DIR 之外（对最终文件做 realpath 校验时 realBase 自己已经在外面了）。
// 与 review-evidence.ts 的 safeRunDirectory 同一原理：从 RUNS_DIR 起逐级 lstat，任何一级
// 祖先是 symlink 就整体拒绝。这里是同步读取路径，所以持有一份同步实现。
function safeEvidenceDir(dir: string): boolean {
  const root = resolve(RUNS_DIR);
  const target = resolve(dir);
  const rel = relative(root, target);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return false;
  try {
    const rootStat = lstatSync(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return false;
  } catch {
    return false;
  }
  let current = root;
  for (const part of rel.split(sep)) {
    current = join(current, part);
    try {
      const stat = lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    } catch {
      return false;
    }
  }
  return true;
}

// `name` 是证据目录内的相对路径，**允许子目录**（`shots/a.png`）：形状判据在
// evidence-path.ts，越界判据是这里的 lstat/nlink 加它的 containedPath。
export function freeReviewFile(taskId: string, runId: string, round: number, name: string): string | null {
  const segments = evidenceSegments(name);
  if (!segments) return null;
  const base = resolve(freeReviewEvidenceDir(taskId, runId, round));
  if (!safeEvidenceDir(base)) return null;
  const file = resolve(base, ...segments);
  if (!existsSync(file)) return null;
  const info = lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink()) return null;
  // 硬链接 lstat 探测不出来（它就是普通文件）：nlink>1 说明同一 inode 还有别的名字，
  // 可能指向证据根之外的内容——审查证据由审查者独立创建，正常永远是 1，直接拒。
  if (info.nlink > 1) return null;
  return containedPath(base, file);
}

export function readFreeReviewReport(taskId: string, runId: string, round: number): string {
  try {
    const file = freeReviewFile(taskId, runId, round, "report.md");
    return file ? readFileSync(file, "utf8") : "";
  } catch {
    return "";
  }
}

// 子目录一起列：审查者把截图归到 `shots/` 里是合法写法（接口也服务得了），列不出来就
// 等于那几张只能靠报告正文提到才看得见。深度与类型都跟**能不能服务**共用一份常量
// （evidence-path.ts）—— 两边一松一紧就会出现「打得开、但面板里没有」。
function filesUnder(dir: string, prefix: string, depth: number, extensions: ReadonlySet<string>): string[] {
  if (depth <= 0) return [];
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    // isSymbolicLink 要先问：符号链接的目录 isDirectory() 是 false，但跟着它走会爬出证据根。
    if (entry.isSymbolicLink()) continue;
    const name = `${prefix}${entry.name}`;
    if (entry.isDirectory()) found.push(...filesUnder(join(dir, entry.name), `${name}/`, depth - 1, extensions));
    else if (entry.isFile() && extensions.has(extname(entry.name).toLowerCase())) found.push(name);
  }
  return found;
}

function listFreeEvidence(taskId: string, runId: string, round: number, extensions: ReadonlySet<string>): string[] {
  try {
    const dir = freeReviewEvidenceDir(taskId, runId, round);
    if (!safeEvidenceDir(dir)) return [];
    return filesUnder(dir, "", EVIDENCE_MAX_DEPTH, extensions).sort();
  } catch {
    return [];
  }
}

/** 截图条铺的那几张（图片类型）。 */
export function freeReviewScreenshots(taskId: string, runId: string, round: number): string[] {
  return listFreeEvidence(taskId, runId, round, EVIDENCE_IMAGE_EXTENSIONS);
}

/** 这一轮证据目录里**服务得了的全部文件** —— 用处见 review-evidence.ts 的 evidenceFiles。 */
export function freeReviewFiles(taskId: string, runId: string, round: number): string[] {
  return listFreeEvidence(taskId, runId, round, EVIDENCE_SERVABLE_EXTENSIONS);
}
