import { and, gte, inArray, isNull, lte, or } from "drizzle-orm";
import { db } from "./db/index.js";
import { monitors } from "./db/schema-monitors.js";
import { sessions, sessionTurns, tasks } from "./db/schema.js";
import type { WorkspaceRoot } from "./file-browser.js";
import type { PathLens } from "./task-artifact-paths.js";
import { workspaceRunOwners, type ArtifactScope, type ArtifactTask } from "./task-artifact-scope.js";
import { runWindows, withinWindows, type RunWindow } from "./task-artifact-windows.js";

// 「那一刻还有没有别的任务在跑」——共享目录上，只靠时间认的那些文件（命令渲染的视频、截图，
// 没有提交证据也没有亲手写下的记录）能不能算**确定**，就看这一问。
//
// **问的是整台机器上的全部任务，不是「跟这个目录沾边的」**：命令写到哪儿是记不下来的——codex 只报
// 命令的工作目录，claude 的 Bash 什么都不报——一个在别的项目里开工的任务，照样能用一条脚本把
// 网页、视频生成到这里。按工作目录、按写入记录去找「可能在这儿写的人」，找到的永远只是一部分，
// 而「没找到」会被当成「没有」，把别人的成品标成确定（审查 TgRjUOJWF1Ci 第 1 轮 #2；之前按目录
// 关系一档一档补上层目录、软链入口、写进来的记录，补不完）。ash 起的每个任务都有运行区间，这个
// 集合才是完整的：那一刻只有它在跑，按时间认才算数。
//
// **它只回答「在不在」，不回答「是谁做的」**：同时在跑就分不出来（要知道得做进程级的文件追踪），
// 这一条只能当候选，并把在跑的是谁照实说出来。找不全、读失败一律往候选那边落。

/**
 * 最多核对这么多个——每个都要算一遍运行区间。超了就如实说「没核全」，只靠时间认的条目全部降成
 * 候选：没核对的那些里可能就有当时在跑的。
 */
const MAX_RIVALS = 48;
/**
 * 粗筛时往前多看这么久：对手的区间可能比它的会话起止更宽（收尾宽限、没收尾的按 6 小时兜底），
 * 只按起止卡会漏掉。粗筛之后每个对手都会按自己真正的区间再核一遍，宽一点只是多算几个。
 */
const ROUGH_MARGIN_MS = 24 * 60 * 60 * 1000;

export interface Rivals {
  /** 这一刻也在跑的别的任务（id）。 */
  at(ms: number | null): string[];
  /** 在跑的任务的标题，面板上说「同一时间 X 也在跑」用。 */
  titles: Map<string, string>;
  /** 没核全时的一句人话（面板照实说）；有它时只靠时间认的条目一律当候选。 */
  incomplete?: string;
}

const overlaps = (a: RunWindow, b: RunWindow) => a.start <= b.end && b.start <= a.end;

/**
 * 时间上跟本任务挨着的全部任务——会话、回合、哨兵任何一样跟它的区间（放宽之后）沾边就算。
 * 这里只是粗筛，最终以各自核出来的区间为准。返回按最近活动排序（截断时先留最近的）。
 */
async function rivalCandidates(task: ArtifactTask, windows: readonly RunWindow[]): Promise<string[]> {
  const from = new Date(Math.min(...windows.map((w) => w.start)) - ROUGH_MARGIN_MS).toISOString();
  const latest = Math.max(...windows.map((w) => w.end));
  const until = Number.isFinite(latest) ? new Date(latest).toISOString() : null;
  const rows = (await Promise.all([
    db.select({ taskId: sessions.taskId, at: sessions.startedAt }).from(sessions).where(and(
      until ? lte(sessions.startedAt, until) : undefined,
      or(isNull(sessions.endedAt), gte(sessions.endedAt, from)),
    )),
    db.select({ taskId: sessionTurns.taskId, at: sessionTurns.startedAt }).from(sessionTurns).where(and(
      until ? lte(sessionTurns.startedAt, until) : undefined,
      or(isNull(sessionTurns.endedAt), gte(sessionTurns.endedAt, from)),
    )),
    db.select({ taskId: monitors.taskId, at: monitors.startedAt }).from(monitors).where(and(
      until ? lte(monitors.startedAt, until) : undefined,
      or(isNull(monitors.endedAt), gte(monitors.endedAt, from)),
    )),
  ])).flat();
  const latestAt = new Map<string, string>();
  for (const row of rows) {
    if (row.taskId === task.id) continue;
    if ((latestAt.get(row.taskId) ?? "") <= (row.at ?? "")) latestAt.set(row.taskId, row.at ?? "");
  }
  return [...latestAt].sort((a, b) => b[1].localeCompare(a[1])).map(([id]) => id);
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

/** 共享目录上这次查询的「同时在跑的别的任务」。目录独占、没跑过的，用不着问。 */
export async function concurrentRivals(
  task: ArtifactTask,
  scope: ArtifactScope,
  root: WorkspaceRoot,
  lens: PathLens,
): Promise<Rivals> {
  if (scope.exclusive || !scope.windows.length) return NOBODY;
  const ownerIds = scope.owners.map((owner) => owner.id);
  const candidates = await rivalCandidates(task, scope.windows);
  const excluded = await collaborators(candidates, ownerIds, task.id);
  const pending = candidates.filter((id) => !excluded.has(id));
  // 截断只发生在协作关系筛掉之后，剩下的按最近活动排队。仍然超了就是真没核全。
  const incomplete = pending.length > MAX_RIVALS;
  const rivals = (await Promise.all(pending.slice(0, MAX_RIVALS).map(async (id) => ({
    id,
    // 它在哪个目录跑都算：命令的输出落在哪儿，从它的工作目录看不出来。
    windows: (await runWindows([{ id }], root, lens, { anywhere: true })).windows,
  })))).filter((rival) => rival.windows.some((span) => scope.windows.some((own) => overlaps(span, own))));
  const titles = new Map(rivals.length
    ? (await db.select({ id: tasks.id, title: tasks.title }).from(tasks).where(inArray(tasks.id, rivals.map((r) => r.id))))
      .map((row) => [row.id, row.title?.trim() || row.id] as const)
    : []);
  return {
    titles,
    incomplete: incomplete
      ? `同一时间在跑的任务太多（超过 ${MAX_RIVALS} 个），没能逐个核对，只靠时间认的都按候选列`
      : undefined,
    at: (ms) => rivals.filter((rival) => withinWindows(ms, rival.windows)).map((rival) => rival.id),
  };
}
