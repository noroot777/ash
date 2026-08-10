import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { RUNS_DIR } from "./paths.js";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

export function freeReviewEvidenceDir(taskId: string, runId: string, round: number): string {
  return join(RUNS_DIR, taskId, "free-review", runId, `round-${round}`);
}

export function freeReviewReportPath(taskId: string, runId: string, round: number): string {
  return join(freeReviewEvidenceDir(taskId, runId, round), "report.md");
}

export function freeReviewFile(taskId: string, runId: string, round: number, name: string): string | null {
  if (!name || name !== name.split(/[\\/]/).at(-1)) return null;
  const base = resolve(freeReviewEvidenceDir(taskId, runId, round));
  const file = resolve(base, name);
  if (!file.startsWith(base + "/") || !existsSync(file)) return null;
  const info = lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink()) return null;
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
    return readdirSync(freeReviewEvidenceDir(taskId, runId, round), { withFileTypes: true })
      .filter((entry) => entry.isFile() && IMAGE_EXTENSIONS.has(extname(entry.name).toLowerCase()))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}
