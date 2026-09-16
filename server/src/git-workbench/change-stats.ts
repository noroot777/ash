import type { GitFile } from "@ash/shared/git-workbench";
import { git } from "./core.js";

export async function readChangeStats(root: string, cached: boolean) {
  const raw = await git(root, [
    "diff",
    "--numstat",
    "-z",
    "-M",
    "--no-ext-diff",
    "--no-textconv",
    ...(cached ? ["--cached"] : []),
  ]);
  const fields = raw.split("\0");
  const stats = new Map<string, { additions: number; deletions: number }>();
  for (let i = 0; i < fields.length; i++) {
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(fields[i]);
    if (!match) continue;
    let path = match[3];
    if (!path) {
      i += 2;
      path = fields[i];
    }
    if (path && match[1] !== "-" && match[2] !== "-")
      stats.set(path, {
        additions: Number(match[1]),
        deletions: Number(match[2]),
      });
  }
  return stats;
}

export function withChangeStats(
  files: GitFile[],
  stats: Awaited<ReturnType<typeof readChangeStats>>,
): GitFile[] {
  return files.map((file) => ({ ...file, ...stats.get(file.path) }));
}
