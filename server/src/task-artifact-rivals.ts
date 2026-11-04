import { and, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { sep } from "node:path";
import { db } from "./db/index.js";
import { monitors } from "./db/schema-monitors.js";
import { sessions, sessionTurns, tasks, taskWrites } from "./db/schema.js";
import type { WorkspaceRoot } from "./file-browser.js";
import type { PathLens } from "./task-artifact-paths.js";
import { workspaceRunOwners, type ArtifactScope, type ArtifactTask } from "./task-artifact-scope.js";
import { runWindows, withinWindows, type RunWindow } from "./task-artifact-windows.js";

// 「那一刻还有谁在这个目录里干活」——共享目录上，只靠时间认的那些文件（命令渲染的视频、截图，
// 没有提交证据也没有亲手写下的记录）能不能算**确定**，就看这一问。
//
// **它只回答「在不在」，不回答「是谁做的」**：两个任务同时在一个目录里干活，命令写出来的文件
// 是谁的，物理上问不出来（要知道得做进程级的文件追踪）。所以有人在场 = 这个文件只能当候选，并且
// 把在场的是谁照实说出来；没人在场 = 照旧按时间认。这里不判「离谁更近」：拿附近写过什么去猜作者，
// 一开始就是错的方向——每一种猜法都有反例（曾经按这条路做过一版，改了六轮审查仍有新漏洞），
// 而猜错的代价是把别人的东西标成确定、或者把自己的东西藏起来。
//
// 找不全、读失败一律往候选那边落：漏掉一个在场的人，就会把它的东西标成确定。

/**
 * 最多核对这么多个候选——每个都要算一遍运行区间。超了就如实说「没核全」，只靠时间认的条目
 * 全部降成候选：没核对的那些里可能就有当时在场的人。
 */
const MAX_RIVALS = 48;
/**
 * 粗筛时往前多看这么久：对手的区间可能比它的会话起止更宽（收尾宽限、没收尾的按 6 小时兜底），
 * 只按起止卡会漏掉。粗筛之后每个对手都会按自己真正的区间再核一遍，宽一点只是多算几个。
 */
const ROUGH_MARGIN_MS = 24 * 60 * 60 * 1000;
/** 写入记录与它所在那一段运行区间对齐时的余量：记录是事件消费时落的，可能比回合收尾晚一点。 */
const RECORD_SLACK_MS = 60 * 1000;

export interface Rivals {
  /** 这一刻也在这个目录里干活的别的任务（id）。 */
  at(ms: number | null): string[];
  /** 在场任务的标题，面板上说「同一时间 X 也在这里」用。 */
  titles: Map<string, string>;
  /** 没核全时的一句人话（面板照实说）；有它时只靠时间认的条目一律当候选。 */
  incomplete?: string;
}

const overlaps = (a: RunWindow, b: RunWindow) => a.start <= b.end && b.start <= a.end;

/** 工作区根的两种写法（原样、解开软链）：写入记录存的是解开软链的，老一点的记录可能不是。 */
async function rootPrefixes(root: WorkspaceRoot, lens: PathLens): Promise<string[]> {
  return [...new Set([root.path, await lens.canonical(root.path)].map((dir) => dir.replace(/[\\/]+$/, "")))];
}

/** 写入记录里指向这个目录（它自己或底下）的那几行的条件。 */
export function writesUnder(prefixes: readonly string[]) {
  return or(...prefixes.flatMap((dir) => [
    sql`${taskWrites.path} = ${dir}`,
    sql`substr(${taskWrites.path}, 1, ${dir.length + 1}) = ${dir + sep}`,
  ]));
}

/**
 * 时间上跟本任务挨着、而且**跟这个目录沾边**的那些任务——候选对手。两路：
 *
 *   - 工作目录沾边：会话、回合、哨兵记下来的目录就是它、在它底下、或者是它的上层（开在
 *     `~/code` 的任务照样能往 `~/code/empty` 里写）。没记目录的老行只在同项目里才算。
 *   - 写入记录指进了这里：从隔壁目录开工、用绝对路径把东西写进来的任务，工作目录一点不沾，
 *     却实打实在这儿干过活。
 *
 * 这里只是粗筛，最终以各自核出来的区间为准。返回按最近活动排序（截断时先留最近的）。
 */
async function rivalCandidates(
  task: ArtifactTask,
  windows: readonly RunWindow[],
  root: WorkspaceRoot,
  lens: PathLens,
): Promise<{ ids: string[]; writes: Map<string, RunWindow[]> }> {
  const from = new Date(Math.min(...windows.map((w) => w.start)) - ROUGH_MARGIN_MS).toISOString();
  const latest = Math.max(...windows.map((w) => w.end));
  const until = Number.isFinite(latest) ? new Date(latest).toISOString() : null;
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
    db.select({ taskId: taskWrites.taskId, firstAt: taskWrites.firstAt, lastAt: taskWrites.lastAt })
      .from(taskWrites).where(and(
        until ? lte(taskWrites.firstAt, until) : undefined,
        gte(taskWrites.lastAt, from),
        writesUnder(await rootPrefixes(root, lens)),
      )),
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
  const writes = new Map<string, RunWindow[]>();
  for (const row of writeRows) {
    if (row.taskId === task.id) continue;
    const start = Date.parse(row.firstAt);
    const end = Date.parse(row.lastAt);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    writes.set(row.taskId, [...(writes.get(row.taskId) ?? []), { start: start - RECORD_SLACK_MS, end: end + RECORD_SLACK_MS }]);
    if ((latestAt.get(row.taskId) ?? "") < row.lastAt) latestAt.set(row.taskId, row.lastAt);
  }
  return { ids: [...latestAt].sort((a, b) => b[1].localeCompare(a[1])).map(([id]) => id), writes };
}

/**
 * 跟本任务**共用这摊活的归属**的任务不算对手，两个方向都要排：
 *
 *   - 本任务的归属链（它自己是审查就跟到被审、它是领队就收进全部执行者）——本来就算它的；
 *   - 反过来，**把本任务算进自己归属链**的那些：审查本任务的、本任务所在团队的领队。它们的
 *     运行时间里本来就包着本任务的活，当成对手会把本任务做的东西全打成候选。
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

const NOBODY: Rivals = { at: () => [], titles: new Map() };

/**
 * 共享目录上这次查询的「同时在场的人」。目录独占、没跑过的，用不着问。
 *
 * 每个候选对手的区间：
 *   - 按工作目录核对出来的那几段（含开在上层目录的）；
 *   - 只是**写进来过**的，取它那几段运行区间里、跟它写进这个目录的记录挨着的那几段——它后来去
 *     别处续聊的那些回合跟这里无关，不能整段算它在场（XPvT3Fdm8bi5 第 2 轮 #2）。
 */
export async function concurrentRivals(
  task: ArtifactTask,
  scope: ArtifactScope,
  root: WorkspaceRoot,
  lens: PathLens,
): Promise<Rivals> {
  if (scope.exclusive || !scope.windows.length) return NOBODY;
  const ownerIds = scope.owners.map((owner) => owner.id);
  const { ids: candidates, writes } = await rivalCandidates(task, scope.windows, root, lens);
  const excluded = await collaborators(candidates, ownerIds, task.id);
  const pending = candidates.filter((id) => !excluded.has(id));
  // 截断只发生在**目录核对之后**：先把协作关系上的筛掉，剩下的才按最近活动排队。仍然超了就是
  // 真没核全。
  const incomplete = pending.length > MAX_RIVALS;
  const rivals = (await Promise.all(pending.slice(0, MAX_RIVALS).map(async (id) => {
    const here = (await runWindows([{ id }], root, lens, { fromAbove: true })).windows;
    const wrote = writes.get(id);
    const there = wrote
      ? (await runWindows([{ id }], root, lens, { anywhere: true })).windows
        .filter((span) => wrote.some((mark) => overlaps(span, mark)))
      : [];
    return { id, windows: [...here, ...there] };
  }))).filter((rival) => rival.windows.some((span) => scope.windows.some((own) => overlaps(span, own))));
  const titles = new Map(rivals.length
    ? (await db.select({ id: tasks.id, title: tasks.title }).from(tasks).where(inArray(tasks.id, rivals.map((r) => r.id))))
      .map((row) => [row.id, row.title?.trim() || row.id] as const)
    : []);
  return {
    titles,
    incomplete: incomplete
      ? `同一时间在这个目录附近跑过的任务太多（超过 ${MAX_RIVALS} 个），没能逐个核对，只靠时间认的都按候选列`
      : undefined,
    at: (ms) => rivals.filter((rival) => withinWindows(ms, rival.windows)).map((rival) => rival.id),
  };
}
