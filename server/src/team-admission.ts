// 往团队里加成员（建执行者、建审查）与团队验收互斥（team-acceptance-hold.ts 文件头：验收期间成员集合不能长）。
// 所有建任务的路都经过 createTasks（task-store.ts），所以在那里占：落库那一下占着「加成员」的位（acceptance-lock.ts
// beginAdmitting），团队验收开不了；验收已经在进行就不建。派活另外占一段更长的（team/dispatch.ts：连摘牌、起跑一起）。
import { inArray } from "drizzle-orm";
import { beginAdmitting } from "./acceptance-lock.js";
import { db } from "./db/index.js";
import { tasks } from "./db/schema.js";

export class TeamAcceptingError extends Error {
  constructor() {
    super("所属团队正在验收（或在更新工作区），结束后再添加执行者或审查");
  }
}

/**
 * 加成员时要占住的那几位：新任务挂靠的任务（parentId / reviewOf）里属于团队的 —— 团队调度台本身，或团队执行者连同
 * 它的调度台。不是团队的（普通任务派生的子任务）不占：它们的验收不管名下多了谁。
 */
export async function admissionKeysOf(refs: (string | null | undefined)[]): Promise<string[]> {
  const ids = [...new Set(refs.filter((ref): ref is string => !!ref))];
  if (!ids.length) return [];
  const rows = await db.select({ id: tasks.id, mode: tasks.mode, parentId: tasks.parentId }).from(tasks).where(inArray(tasks.id, ids));
  const parentIds = [...new Set(rows.flatMap((row) => row.parentId ? [row.parentId] : []))];
  const parents = parentIds.length
    ? await db.select({ id: tasks.id, mode: tasks.mode, parentId: tasks.parentId }).from(tasks).where(inArray(tasks.id, parentIds))
    : [];
  const isLead = (row: { mode: string; parentId: string | null }) => row.mode === "team" && !row.parentId;
  const leads = new Set([...rows, ...parents].filter(isLead).map((row) => row.id));
  return [...new Set(rows.flatMap((row) => leads.has(row.id) ? [row.id] : row.parentId && leads.has(row.parentId) ? [row.id, row.parentId] : []))];
}

/** 占住这几位的「加成员」位：同步，要么全占上、要么一个不占。有谁正在验收就返回 null；否则返回释放函数。 */
export function admitMembers(keys: readonly string[]): (() => void) | null {
  const releases: (() => void)[] = [];
  for (const key of keys) {
    const release = beginAdmitting(key);
    if (!release) {
      for (const taken of releases) taken();
      return null;
    }
    releases.push(release);
  }
  return () => { for (const release of releases) release(); };
}
