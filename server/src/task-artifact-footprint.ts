import { and, desc, eq, gte, inArray, isNull, lte, ne, or } from "drizzle-orm";
import { dirname, isAbsolute, relative, sep } from "node:path";
import { db } from "./db/index.js";
import { monitors } from "./db/schema-monitors.js";
import { sessions, tasks, taskWrites } from "./db/schema.js";
import type { WorkspaceRoot } from "./file-browser.js";
import type { PathLens } from "./task-artifact-paths.js";
import type { ArtifactScope, ArtifactTask } from "./task-artifact-scope.js";
import { runWindows, withinWindows, type RunWindow } from "./task-artifact-windows.js";

// 共享目录上**同时在跑**的任务怎么分开——时间判据答不了的那一问，交给「谁在这附近写过
// 东西」。证据是执行器当场报出来的写入位置（task-writes.ts 记的那张表），不是猜的。
//
// 时间那一档的边界写在 `task-artifact-scope.ts`：「同时在跑的两个任务，谁写的那个文件，
// 物理上问不出来」。这句话只对 mtime 成立——两个任务的 agent 各自调过的写文件工具、
// 各自后台命令的工作目录，是分得开的。一个文件离谁写过的地方更近，就更可能是谁做的：
// 渲染出来的视频、截图是 shell 命令写的，写文件记录里没有它们，但它们落在那个任务自己
// 搭起来的目录里。
//
// **只裁决冲突，不改没冲突的**：一个文件的修改时间只落在本任务的运行区间里时，照旧按时间
// 认。只有同一刻还有别的任务在这个目录里跑，才拿写入位置来比；比不出来（一样近、或者有一方
// 没有任何写入记录）就照实标成候选，不硬判。

/** 一次最多拿这么多个时间上挨着的任务来比——每个都要算一遍运行区间。 */
const MAX_RIVALS = 24;
/**
 * 粗筛时往前多看这么久：对手的区间可能比它的会话起止更宽（收尾宽限、没收尾的按 6 小时兜底），
 * 只按起止卡会漏掉。粗筛之后每个对手都会按自己真正的区间再核一遍，宽一点只是多算几个。
 */
const ROUGH_MARGIN_MS = 24 * 60 * 60 * 1000;

/** 这个文件归谁：本任务 / 别人 / 比不出来 / 没有别人同时在跑。 */
export type FootprintVerdict = "mine" | "theirs" | "unsure" | "alone";

export interface FootprintArbiter {
  judge(relPath: string, mtimeMs: number | null): FootprintVerdict;
  /** 本任务写过的目录（相对工作区根），扫描时先看这几处。 */
  focus: string[];
}

interface Footprint {
  /** 写文件工具的目标所在目录、后台命令的工作目录。 */
  strong: string[][];
  /** 普通命令的工作目录（进去可能只是看一眼）。 */
  weak: string[][];
}

const ALONE: FootprintArbiter = { judge: () => "alone", focus: [] };

const segmentsOf = (rel: string) => rel.split(/[\\/]/).filter(Boolean);

/** 两串目录段从头算起有几段相同。 */
const sharedDepth = (a: readonly string[], b: readonly string[]) => {
  let depth = 0;
  while (depth < a.length && depth < b.length && a[depth] === b[depth]) depth += 1;
  return depth;
};

/**
 * 离这个目录最近的那处写入有多近：强证据先比，打平再比弱证据。
 *
 * 弱证据只在它**比强证据更近**时才算数：两边真写过的地方都只跟这个文件共享 `videos/` 一层时，
 * 一方曾在 `videos/别处/` 跑过命令，同样只多出 `videos/` 这一层，什么也说明不了——拿它打破
 * 平局，等于让「进去看了一眼」决定归属。
 */
const closeness = (dir: readonly string[], print: Footprint): [number, number] => {
  const strong = Math.max(0, ...print.strong.map((seg) => sharedDepth(dir, seg)));
  const weak = Math.max(0, ...print.weak.map((seg) => sharedDepth(dir, seg)));
  return [strong, weak > strong ? weak : 0];
};

const compare = (a: [number, number], b: [number, number]) => a[0] - b[0] || a[1] - b[1];

/**
 * 时间上跟本任务挨着、在同一个项目里跑过的那些任务——候选对手。
 *
 * 归属链上的任务（审查跟到被审、领队汇总执行者）不算对手：它们本来就跟本任务共用这摊活的
 * 归属，见 `workspaceRunOwners`。
 */
async function rivalIds(task: ArtifactTask, ownerIds: string[], windows: readonly RunWindow[]): Promise<string[]> {
  const from = new Date(Math.min(...windows.map((w) => w.start)) - ROUGH_MARGIN_MS).toISOString();
  const latest = Math.max(...windows.map((w) => w.end));
  const until = Number.isFinite(latest) ? new Date(latest).toISOString() : null;
  const sameProject = db.select({ id: tasks.id }).from(tasks).where(eq(tasks.projectId, task.projectId));
  const [sessionRows, monitorRows] = await Promise.all([
    db.select({ taskId: sessions.taskId, at: sessions.startedAt }).from(sessions).where(and(
      inArray(sessions.taskId, sameProject),
      until ? lte(sessions.startedAt, until) : undefined,
      or(isNull(sessions.endedAt), gte(sessions.endedAt, from)),
    )).orderBy(desc(sessions.startedAt)),
    db.select({ taskId: monitors.taskId, at: monitors.startedAt }).from(monitors).where(and(
      inArray(monitors.taskId, sameProject),
      until ? lte(monitors.startedAt, until) : undefined,
      or(isNull(monitors.endedAt), gte(monitors.endedAt, from)),
    )).orderBy(desc(monitors.startedAt)),
  ]);
  const owners = new Set(ownerIds);
  const ids: string[] = [];
  for (const row of [...sessionRows, ...monitorRows].sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""))) {
    if (owners.has(row.taskId) || ids.includes(row.taskId)) continue;
    ids.push(row.taskId);
    if (ids.length >= MAX_RIVALS) break;
  }
  return ids;
}

/** 这些任务各自在工作区根底下写过哪些目录。根外面的不算（那是别处的活）。 */
async function footprints(ids: string[], root: WorkspaceRoot, lens: PathLens): Promise<Map<string, Footprint>> {
  const out = new Map<string, Footprint>(ids.map((id) => [id, { strong: [], weak: [] }]));
  if (!ids.length) return out;
  const [writeRows, monitorRows] = await Promise.all([
    db.select().from(taskWrites).where(inArray(taskWrites.taskId, ids)),
    db.select({ taskId: monitors.taskId, cwd: monitors.cwd }).from(monitors)
      .where(and(inArray(monitors.taskId, ids), ne(monitors.cwd, ""))),
  ]);
  const rootPath = await lens.canonical(root.path);
  const under = async (absDir: string): Promise<string[] | null> => {
    const rel = relative(rootPath, await lens.canonical(absDir));
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
    return segmentsOf(rel);
  };
  const add = (id: string, strength: keyof Footprint, segs: string[] | null) => {
    if (segs) out.get(id)?.[strength].push(segs);
  };
  for (const row of writeRows) {
    // 写文件工具记的是**文件**，比的是它所在的目录；命令记的本来就是目录。
    add(row.taskId, row.weak ? "weak" : "strong", await under(row.weak ? row.path : dirname(row.path)));
  }
  // 哨兵的工作目录：后台渲染、长跑脚本的产物多半就落在那儿，算强证据。
  for (const row of monitorRows) if (row.cwd) add(row.taskId, "strong", await under(row.cwd));
  return out;
}

const hasPrint = (print: Footprint | undefined) => !!print && (print.strong.length > 0 || print.weak.length > 0);

/**
 * 给共享目录上的这次查询配一个裁决者。目录独占、没跑过的，用不着裁决。
 *
 * 判法（对一个修改时间落在本任务区间里的文件）：
 *   1. 找出同一刻**也在**这个目录里跑的别的任务。没有 → `alone`，照旧按时间认。
 *   2. 本任务一条写入记录都没有（老任务、没接上的执行器）→ `unsure`：拿不出证据就不硬判。
 *   3. 有写入记录的对手里，有人比本任务离这个文件更近 → `theirs`，从清单里拿掉。
 *   4. 本任务严格最近、而且所有对手都有写入记录可比 → `mine`，归属确定。
 *   5. 其余（一样近、或者有对手没记录可比）→ `unsure`，留作候选。
 *
 * 「更近」要真有东西可比：离得最近的那处也只跟这个文件共享工作区根本身（深度 0）的话，
 * 等于谁都没在附近写过，不算证据。
 */
export async function footprintArbiter(
  task: ArtifactTask,
  scope: ArtifactScope,
  root: WorkspaceRoot,
  lens: PathLens,
): Promise<FootprintArbiter> {
  if (scope.exclusive || !scope.windows.length) return ALONE;
  const ownerIds = scope.owners.map((owner) => owner.id);
  const rivals = (await Promise.all((await rivalIds(task, ownerIds, scope.windows)).map(async (id) => ({
    id,
    windows: (await runWindows([{ id }], root, lens)).windows,
  })))).filter((rival) => rival.windows.length > 0);

  const prints = await footprints([...ownerIds, ...rivals.map((rival) => rival.id)], root, lens);
  const mine: Footprint = { strong: [], weak: [] };
  for (const id of ownerIds) {
    const print = prints.get(id);
    if (print) { mine.strong.push(...print.strong); mine.weak.push(...print.weak); }
  }
  const focus = [...new Set(mine.strong.filter((segs) => segs.length > 0).map((segs) => segs.join("/")))];
  if (!rivals.length) return { judge: () => "alone", focus };

  return {
    focus,
    judge(relPath, mtimeMs) {
      const present = rivals.filter((rival) => withinWindows(mtimeMs, rival.windows));
      if (!present.length) return "alone";
      if (!hasPrint(mine)) return "unsure";
      const dir = segmentsOf(relPath).slice(0, -1);
      const own = closeness(dir, mine);
      let best: [number, number] = [0, 0];
      let blind = false;
      for (const rival of present) {
        const print = prints.get(rival.id);
        if (!hasPrint(print)) { blind = true; continue; }
        const theirs = closeness(dir, print!);
        if (compare(theirs, best) > 0) best = theirs;
      }
      if (compare(best, own) > 0 && (best[0] > 0 || best[1] > 0)) return "theirs";
      if (!blind && compare(own, best) > 0 && (own[0] > 0 || own[1] > 0)) return "mine";
      return "unsure";
    },
  };
}
