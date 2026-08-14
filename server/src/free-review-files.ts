import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { RUNS_DIR } from "./paths.js";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

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

export function freeReviewFile(taskId: string, runId: string, round: number, name: string): string | null {
  if (!name || name !== name.split(/[\\/]/).at(-1)) return null;
  const base = resolve(freeReviewEvidenceDir(taskId, runId, round));
  if (!safeEvidenceDir(base)) return null;
  const file = resolve(base, name);
  if (!file.startsWith(base + "/") || !existsSync(file)) return null;
  const info = lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink()) return null;
  // 硬链接 lstat 探测不出来（它就是普通文件）：nlink>1 说明同一 inode 还有别的名字，
  // 可能指向证据根之外的内容——审查证据由审查者独立创建，正常永远是 1，直接拒。
  if (info.nlink > 1) return null;
  const realBase = realpathSync(base);
  const realFile = realpathSync(file);
  return realFile.startsWith(realBase + "/") ? realFile : null;
}

export function readFreeReviewReport(taskId: string, runId: string, round: number): string {
  try {
    const file = freeReviewFile(taskId, runId, round, "report.md");
    return file ? readFileSync(file, "utf8") : "";
  } catch {
    return "";
  }
}

export function freeReviewScreenshots(taskId: string, runId: string, round: number): string[] {
  try {
    const dir = freeReviewEvidenceDir(taskId, runId, round);
    if (!safeEvidenceDir(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && IMAGE_EXTENSIONS.has(extname(entry.name).toLowerCase()))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}
