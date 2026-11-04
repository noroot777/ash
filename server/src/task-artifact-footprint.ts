import { and, gte, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import { dirname, isAbsolute, relative, sep } from "node:path";
import { db } from "./db/index.js";
import { monitors } from "./db/schema-monitors.js";
import { sessions, sessionTurns, tasks, taskWrites } from "./db/schema.js";
import type { WorkspaceRoot } from "./file-browser.js";
import type { PathLens } from "./task-artifact-paths.js";
import { workspaceRunOwners, type ArtifactScope, type ArtifactTask } from "./task-artifact-scope.js";
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

/**
 * 最多核对这么多个候选对手——每个都要算一遍运行区间。超了就如实说「没比全」，所有原本能判
 * 成「没别人」「是它的」的条目都降成候选：没核对的那些里可能就有当时在场的人。
 */
const MAX_RIVALS = 48;
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
  /** 没比全时的一句人话（面板照实说）。 */
  incomplete?: string;
}

interface Footprint {
  /** 写文件工具的目标所在目录、后台命令的工作目录。 */
  strong: string[][];
  /** 普通命令的工作目录（进去可能只是看一眼）。 */
  weak: string[][];
}

/** 一处写入位置，连同它**从什么时候起**成立（写入记录的首次时刻、哨兵的起点）。 */
interface Mark {
  segs: string[];
  at: number;
}

/** 一个任务全部的写入位置，带时刻；判某一刻的文件时先用 `asOf` 截到那一刻。 */
interface Trail {
  strong: Mark[];
  weak: Mark[];
}

/**
 * 写入记录比文件晚这么久以内仍算「当时就在」。写入端已经按**这一步操作开始的时刻**记账（工具
 * 调用发出、条目 started 的那一刻，或完成时刻减去它自报的耗时，见 executors/tool-writes.ts），
 * 一步操作写出的文件天然不早于它开始；剩下要容的只有文件时间戳精度和两边取时钟的先后。
 * 留宽了，一份半分钟后才写的无关说明就能回头认领早先的成品（复审第 3 轮 #1）。
 */
const EVIDENCE_SKEW_MS = 2 * 1000;

/**
 * 判 `at` 那一刻落下的文件时，这个任务的哪些写入位置能拿来作证：只认那一刻**已经成立**的
 * （记录的起点不晚于它，容一个落定余量）。
 *
 * **后来才有的证据不能回头改判早先的文件**（复审第 1 轮 #1、第 2 轮 #1）：两个任务曾同时在跑，
 * 其中一个后来在对方成品旁边写了一份说明——哪怕还在同一段运行区间里——拿它来比，对方那份早就
 * 做完、一个字没改的网页会被判给它。「落在同一段区间里」只说明两件事时间上挨着，不说明那份
 * 文件是这次写入产生的。能解释的延迟只有一种：一步操作本身花的时间（命令跑了十分钟才报出来），
 * 那已经在写入端按开始时刻记好了（task-writes.ts）。
 *
 * 代价如实承担：老任务只有哨兵目录可比，哨兵挂上之前出的文件拿不出当时的证据，只能当候选——
 * 不回填老任务是定好的边界，候选至少是照实说的。
 */
const asOf = (trail: Trail | undefined, at: number | null): Footprint => {
  const keep = (marks: Mark[]) => marks
    .filter((mark) => at !== null && mark.at <= at + EVIDENCE_SKEW_MS)
    .map((mark) => mark.segs);
  return trail ? { strong: keep(trail.strong), weak: keep(trail.weak) } : { strong: [], weak: [] };
};

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

const overlaps = (a: RunWindow, b: RunWindow) => a.start <= b.end && b.start <= a.end;

/**
 * 时间上跟本任务挨着、**工作目录**跟这个目录沾边的那些任务——候选对手。
 *
 * 按目录找，不按项目找：同一个目录可能被几个项目同时登记（一个项目开在 `~/code/empty`、
 * 另一个开在 `~/code`），也可能被一个开在上层目录的任务写进来。「沾边」= 记下来的工作目录
 * 就是它、在它底下、或者是它的上层；没记目录的老行只在同项目里才算（它当时在哪儿无从查证，
 * 跟 `runWindows` 的 `stale` 那一档一个意思）。这里只是粗筛，最终以 `runWindows` 核出来的
 * 区间为准。
 *
 * 粗筛按会话、回合、哨兵三处的记录收：会话的启动目录、每个回合实际的工作目录、哨兵的工作
 * 目录可能各不相同。返回按最近活动排序（截断时先留最近的）。
 *
 * 还有一路**不看工作目录**：写入记录指进了这个目录的任务（复审第 3 轮 #3）。在隔壁目录开工、
 * 用绝对路径把东西写进来的任务，工作目录跟这里一点不沾，却实打实在这儿写过——它们记在
 * `writers` 里，后面核区间时不按目录卡（`runWindows` 的 `anywhere`）。
 */
async function rivalCandidates(
  task: ArtifactTask,
  windows: readonly RunWindow[],
  root: WorkspaceRoot,
  lens: PathLens,
): Promise<{ ids: string[]; writers: Set<string> }> {
  const from = new Date(Math.min(...windows.map((w) => w.start)) - ROUGH_MARGIN_MS).toISOString();
  const latest = Math.max(...windows.map((w) => w.end));
  const until = Number.isFinite(latest) ? new Date(latest).toISOString() : null;
  const prefixes = [...new Set([root.path, await lens.canonical(root.path)].map((dir) => dir.replace(/[\\/]+$/, "")))];
  const [sessionRows, turnRows, monitorRows, writeRows] = await Promise.all([
    db.select({ taskId: sessions.taskId, cwd: sessions.cwd, alt: sessions.worktreePath, at: sessions.startedAt })
      .from(sessions).where(and(
        until ? lte(sessions.startedAt, until) : undefined,
        or(isNull(sessions.endedAt), gte(sessions.endedAt, from)),
      )),
    db.select({ taskId: sessionTurns.taskId, cwd: sessionTurns.cwd, alt: sql<null>`null`, at: sessionTurns.startedAt })
      .from(sessionTurns).where(and(
        until ? lte(sessionTurns.startedAt, until) : undefined,
        or(isNull(sessionTurns.endedAt), gte(sessionTurns.endedAt, from)),
      )),
    db.select({ taskId: monitors.taskId, cwd: monitors.cwd, alt: sql<null>`null`, at: monitors.startedAt })
      .from(monitors).where(and(
        until ? lte(monitors.startedAt, until) : undefined,
        or(isNull(monitors.endedAt), gte(monitors.endedAt, from)),
      )),
    db.select({ taskId: taskWrites.taskId, at: sql<string>`max(${taskWrites.lastAt})` })
      .from(taskWrites).where(and(
        ne(taskWrites.taskId, task.id),
        until ? lte(taskWrites.firstAt, until) : undefined,
        gte(taskWrites.lastAt, from),
        or(...prefixes.flatMap((dir) => [
          sql`${taskWrites.path} = ${dir}`,
          sql`substr(${taskWrites.path}, 1, ${dir.length + 1}) = ${dir + sep}`,
        ])),
      )).groupBy(taskWrites.taskId),
  ]);
  const projectOf = new Map<string, string>();
  const rows = [...sessionRows, ...turnRows, ...monitorRows].filter((row) => row.taskId !== task.id);
  const unknownDir = rows.filter((row) => !(row.cwd ?? row.alt ?? "").trim()).map((row) => row.taskId);
  if (unknownDir.length) {
    for (const row of await db.select({ id: tasks.id, projectId: tasks.projectId }).from(tasks)
      .where(inArray(tasks.id, [...new Set(unknownDir)]))) projectOf.set(row.id, row.projectId);
  }
  const related = async (row: (typeof rows)[number]) => {
    const recorded = (row.cwd ?? row.alt ?? "").trim();
    if (!recorded) return projectOf.get(row.taskId) === task.projectId;
    return await lens.underDir(recorded, root.path) || await lens.underDir(root.path, recorded)
      || (!!root.repo && await lens.underDir(recorded, root.repo) && !(await lens.dirExists(recorded)));
  };
  // 一个任务只要有一条记录沾边就入选；它别的记录只用来刷新「最近活动」。
  const latestAt = new Map<string, string>();
  for (const row of rows) {
    const seen = latestAt.get(row.taskId);
    if (seen !== undefined ? seen >= (row.at ?? "") : !(await related(row))) continue;
    latestAt.set(row.taskId, row.at ?? "");
  }
  const writers = new Set<string>();
  for (const row of writeRows) {
    writers.add(row.taskId);
    if ((latestAt.get(row.taskId) ?? "") < (row.at ?? "")) latestAt.set(row.taskId, row.at ?? "");
  }
  return { ids: [...latestAt].sort((a, b) => b[1].localeCompare(a[1])).map(([id]) => id), writers };
}

/**
 * 跟本任务**共用这摊活的归属**的任务不算对手，两个方向都要排：
 *
 *   - 本任务的归属链（它自己是审查就跟到被审、它是领队就收进全部执行者）——本来就算它的；
 *   - 反过来，**把本任务算进自己归属链**的那些：审查本任务的、本任务所在团队的领队。它们的
 *     运行时间里本来就包着本任务的活，当成对手会把本任务做的东西判成「拿不准」甚至判走。
 *
 * 同一个团队里的兄弟执行者**仍是对手**：它们各干各的（领队页汇总、执行者各认自己的，理由见
 * `workspaceRunOwners`）。
 */
async function collaborators(candidates: string[], ownerIds: readonly string[], taskId: string): Promise<Set<string>> {
  const out = new Set(ownerIds);
  const rows = candidates.length
    ? await db.select().from(tasks).where(inArray(tasks.id, candidates.filter((id) => !out.has(id))))
    : [];
  await Promise.all(rows.map(async (row) => {
    if ((await workspaceRunOwners(row)).some((owner) => owner.id === taskId)) out.add(row.id);
  }));
  return out;
}

/** 这些任务各自在工作区根底下写过哪些目录、从什么时候起。根外面的不算（那是别处的活）。 */
async function footprints(ids: string[], root: WorkspaceRoot, lens: PathLens): Promise<Map<string, Trail>> {
  const out = new Map<string, Trail>(ids.map((id) => [id, { strong: [], weak: [] }]));
  if (!ids.length) return out;
  const [writeRows, monitorRows] = await Promise.all([
    db.select().from(taskWrites).where(inArray(taskWrites.taskId, ids)),
    db.select({ taskId: monitors.taskId, cwd: monitors.cwd, at: monitors.startedAt }).from(monitors)
      .where(and(inArray(monitors.taskId, ids), ne(monitors.cwd, ""))),
  ]);
  const rootPath = await lens.canonical(root.path);
  const under = async (absDir: string): Promise<string[] | null> => {
    const rel = relative(rootPath, await lens.canonical(absDir));
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
    return segmentsOf(rel);
  };
  const add = (id: string, strength: keyof Trail, segs: string[] | null, at: string | null) => {
    const ms = Date.parse(at ?? "");
    // 说不出从什么时候起的记录，哪一刻都不能拿来作证。
    if (segs && Number.isFinite(ms)) out.get(id)?.[strength].push({ segs, at: ms });
  };
  for (const row of writeRows) {
    // 写文件工具记的是**文件**，比的是它所在的目录；命令记的本来就是目录。
    add(row.taskId, row.weak ? "weak" : "strong", await under(row.weak ? row.path : dirname(row.path)), row.firstAt);
  }
  // 哨兵的工作目录：后台渲染、长跑脚本的产物多半就落在那儿，算强证据。
  for (const row of monitorRows) if (row.cwd) add(row.taskId, "strong", await under(row.cwd), row.at);
  return out;
}

const hasPrint = (print: Footprint) => print.strong.length > 0 || print.weak.length > 0;

/**
 * 给共享目录上的这次查询配一个裁决者。目录独占、没跑过的，用不着裁决。
 *
 * 判法（对一个修改时间落在本任务区间里的文件）：
 *   1. 找出同一刻**也在**这个目录里跑的别的任务。没有 → `alone`，照旧按时间认。
 *   2. 本任务一条写入记录都没有（老任务、没接上的执行器）→ `unsure`：拿不出证据就不硬判。
 *
 * 2–5 里说的「写入记录」只认这个文件落下时已经有的（`asOf`）：之后才有的记录不参赛。
 *   3. 有写入记录的对手里，有人比本任务离这个文件更近 → `theirs`，从清单里拿掉。
 *   4. 本任务严格最近、而且所有对手都有写入记录可比 → `mine`，归属确定。
 *   5. 其余（一样近、或者有对手没记录可比）→ `unsure`，留作候选。
 *
 * 对手太多没核全时（`incomplete`），1 和 4 都不成立——没核的那些里可能就有当时在场、离得
 * 更近的人——一律降成 `unsure`；3 照旧，核到的那个对手确实更近。
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
  const { ids: candidates, writers } = await rivalCandidates(task, scope.windows, root, lens);
  const excluded = await collaborators(candidates, ownerIds, task.id);
  const pending = candidates.filter((id) => !excluded.has(id));
  // 截断只发生在**目录核对之后**：先把在别处干活的、协作关系上的都筛掉，剩下的才按最近活动
  // 排队。仍然超了就是真没比全，下面整套判法都要知道这一点。
  const incomplete = pending.length > MAX_RIVALS;
  const rivals = (await Promise.all(pending.slice(0, MAX_RIVALS).map(async (id) => ({
    id,
    windows: (await runWindows([{ id }], root, lens, { fromAbove: true, anywhere: writers.has(id) })).windows,
  })))).filter((rival) => rival.windows.some((span) => scope.windows.some((own) => overlaps(span, own))));
  const note = incomplete
    ? `同一时间在这个目录附近跑过的任务太多（超过 ${MAX_RIVALS} 个），没能逐个比对写入位置，没判给别人的都按候选列`
    : undefined;

  const prints = await footprints([...ownerIds, ...rivals.map((rival) => rival.id)], root, lens);
  const mine: Trail = { strong: [], weak: [] };
  for (const id of ownerIds) {
    const print = prints.get(id);
    if (print) { mine.strong.push(...print.strong); mine.weak.push(...print.weak); }
  }
  // 扫描顺序不吃时间：先扫它写过的地方，不管是什么时候写的。
  const focus = [...new Set(mine.strong.filter((mark) => mark.segs.length > 0).map((mark) => mark.segs.join("/")))];
  if (!rivals.length && !incomplete) return { judge: () => "alone", focus };

  return {
    focus,
    incomplete: note,
    judge(relPath, mtimeMs) {
      const present = rivals.filter((rival) => withinWindows(mtimeMs, rival.windows));
      if (!present.length) return incomplete ? "unsure" : "alone";
      const ownPrint = asOf(mine, mtimeMs);
      if (!hasPrint(ownPrint)) return "unsure";
      const dir = segmentsOf(relPath).slice(0, -1);
      const own = closeness(dir, ownPrint);
      let best: [number, number] = [0, 0];
      let blind = false;
      for (const rival of present) {
        const print = asOf(prints.get(rival.id), mtimeMs);
        if (!hasPrint(print)) { blind = true; continue; }
        const theirs = closeness(dir, print);
        if (compare(theirs, best) > 0) best = theirs;
      }
      if (compare(best, own) > 0 && (best[0] > 0 || best[1] > 0)) return "theirs";
      if (!blind && !incomplete && compare(own, best) > 0 && (own[0] > 0 || own[1] > 0)) return "mine";
      return "unsure";
    },
  };
}
