import { dirname, join, relative, sep } from "node:path";
import { db } from "./db/index.js";
import { taskWrites } from "./db/schema.js";
import { fileDigest } from "./file-digest.js";
import type { WorkspaceRoot } from "./file-browser.js";
import type { PathLens } from "./task-artifact-paths.js";
import { writesUnder } from "./task-artifact-rivals.js";

// 生成物归属里**唯一不靠推断**的那条证据：这份文件是它用写文件工具亲手写下的，而且磁盘上现在
// 这份跟它写成那一刻一模一样（内容指纹在执行器那一侧当场记下，见 executors/tool-writes.ts）。
//
// 不问时间、不问目录远近、不问同时还有谁在跑：内容对得上就是对得上。反过来也一样——现在这份
// 正是**别的任务**亲手写下的那一版，那它就是别人的，不列进来。两边写下的恰好是同一份内容时，
// 谁也证明不了，照实当候选。
//
// 命令写出来的文件（渲染的视频、截图）没有这条证据：执行器只报命令在哪个目录跑，不报它写了哪些
// 文件。那些文件只能按时间认（task-artifacts.ts）。

/** 这份文件按亲手写下的记录归谁。null = 没有谁的记录对得上（交给其余线索）。 */
export type DirectVerdict = "mine" | "theirs" | "contested" | null;

export interface DirectEvidence {
  /** 本任务（及其归属链）亲手写过的产物，相对工作区根、posix 分隔符。 */
  ownPaths: string[];
  /** 本任务写过的目录（相对工作区根），扫描时先看这几处。 */
  focus: string[];
  judge(relPath: string): Promise<DirectVerdict>;
}

const posix = (rel: string) => rel.split(sep).join("/");

export async function directEvidence(
  root: WorkspaceRoot,
  ownerIds: readonly string[],
  lens: PathLens,
): Promise<DirectEvidence> {
  const canonicalRoot = await lens.canonical(root.path);
  const prefixes = [...new Set([root.path, canonicalRoot].map((dir) => dir.replace(/[\\/]+$/, "")))];
  const rows = await db.select().from(taskWrites).where(writesUnder(prefixes));
  const owners = new Set(ownerIds);
  /** 相对路径 → 本任务写下过的指纹 / 别的任务写下过的指纹。 */
  const byPath = new Map<string, { own: Set<string>; others: Set<string> }>();
  const focus = new Set<string>();
  for (const row of rows) {
    if (row.weak) continue;
    const rel = relative(canonicalRoot, await lens.canonical(row.path));
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`)) continue;
    if (owners.has(row.taskId) && dirname(rel) !== ".") focus.add(posix(dirname(rel)));
    if (!row.digest) continue;
    const key = posix(rel);
    const entry = byPath.get(key) ?? { own: new Set<string>(), others: new Set<string>() };
    byPath.set(key, entry);
    (owners.has(row.taskId) ? entry.own : entry.others).add(row.digest);
  }
  const ownPaths = [...byPath].filter(([, entry]) => entry.own.size > 0).map(([path]) => path);
  return {
    ownPaths,
    focus: [...focus],
    async judge(relPath) {
      const entry = byPath.get(relPath);
      if (!entry) return null;
      const disk = await fileDigest(join(root.path, relPath));
      if (!disk) return null;
      const mine = entry.own.has(disk);
      const theirs = entry.others.has(disk);
      if (mine && theirs) return "contested";
      if (mine) return "mine";
      return theirs ? "theirs" : null;
    },
  };
}
