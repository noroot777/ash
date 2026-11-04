import { and, gte, inArray, isNull, lte, or } from "drizzle-orm";
import { db } from "./db/index.js";
import { monitors } from "./db/schema-monitors.js";
import { sessions, sessionTurns, tasks } from "./db/schema.js";
import type { WorkspaceRoot } from "./file-browser.js";
import type { PathLens } from "./task-artifact-paths.js";
import { workspaceRunOwners, type ArtifactScope, type ArtifactTask } from "./task-artifact-scope.js";
import { runWindows, withinWindows, type RunWindow } from "./task-artifact-windows.js";

// 「那一刻还有哪些别的任务在跑」——共享目录上只靠时间认的那些候选（命令渲染的视频、截图），卡片上
// 照实说一句「当时 X 也在跑」。
//
// **只用来说明，不参与判定**：只靠时间认的在共享目录上一律是候选（task-artifacts.ts 顶部），这里
// 找不全也不会让谁变成确定——任务能起 ash 管不到的进程，「没找到别人」本来就证明不了「没有别人」。
// 所以核对有上限（`MAX_RIVALS`）、读失败也只是少说一句。
//
// 问的是整台机器上的全部任务，不只是跟这个目录沾边的：命令写到哪儿记不下来，别的项目里的任务
// 照样能用一条脚本把东西生成到这里。标题给不给看，按查看者的权限另算（task-artifacts.ts 的
// `nameRival`）。

/** 最多核对这么多个（每个都要算一遍运行区间），按最近活动先留。超出的那些卡片上就不点名了。 */
const MAX_RIVALS = 48;
/**
 * 粗筛时往前多看这么久：对手的区间可能比它的会话起止更宽（收尾宽限、没收尾的按 6 小时兜底），
 * 只按起止卡会漏掉。粗筛之后每个对手都会按自己真正的区间再核一遍，宽一点只是多算几个。
 */
const ROUGH_MARGIN_MS = 24 * 60 * 60 * 1000;

export interface Rivals {
  /** 这一刻也在跑的别的任务（id）。 */
  at(ms: number | null): string[];
  /** 在跑的任务的标题和所属项目（全实例；给不给看按查看者权限另算）。 */
  titles: Map<string, { title: string; projectId: string }>;
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
  const rivals = (await Promise.all(pending.slice(0, MAX_RIVALS).map(async (id) => ({
    id,
    // 它在哪个目录跑都算：命令的输出落在哪儿，从它的工作目录看不出来。
    windows: (await runWindows([{ id }], root, lens, { anywhere: true })).windows,
  })))).filter((rival) => rival.windows.some((span) => scope.windows.some((own) => overlaps(span, own))));
  const titles = new Map(rivals.length
    ? (await db.select({ id: tasks.id, title: tasks.title, projectId: tasks.projectId }).from(tasks)
      .where(inArray(tasks.id, rivals.map((r) => r.id))))
      .map((row) => [row.id, { title: row.title?.trim() || row.id, projectId: row.projectId }] as const)
    : []);
  return {
    titles,
    at: (ms) => rivals.filter((rival) => withinWindows(ms, rival.windows)).map((rival) => rival.id),
  };
}
