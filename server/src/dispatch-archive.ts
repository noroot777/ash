// 派出去的子孙（`dispatchedBy` 整棵往下）跟着派活的那条一起归档、一起取回。
//
// 用户 2026-11-19 定的：主任务归档了，子孙任务都跟着归档；有还没结束的就挡回去，等都结束了再归档。
// 原先归档只收派活那一条：它从侧栏消失，名下还停着的那几条各自浮到顶层，挂着一颗指向已归档任务的
// 「父任务」图标，看着像来路不明的任务（T1Au21zo7wPK 那一次）。
//
// 团队执行者（parentId）不走这里，它们照旧跟团队一起走（task-archive-routes.ts）。派出去的任务只会
// 是普通任务（task-dispatch.ts `canBeDispatched`），所以这棵树里没有团队。
//
// 取回只带回**跟它同一刻归档**的那几条（archivedAt 相同）：在这之前就被单独归档的，不是这一次归档
// 收走的，取回派活的那条也不该把它们拉回来。
//
// 能处置派活的那条，不等于能处置它名下的每一条：派活可以跨项目（task-dispatch.ts），名下可能有调用者看不见的
// 项目里的任务。整棵里有一条看不见，整笔都不做（归档、取回、清磁盘都不碰它），说的时候也不带它的标题。
//
// 整棵的「判 → 写」期间成员集合不能长：归档占住整棵的冻结位，建任务那一层占「挂进来」的位，两边互斥
// （acceptance-lock.ts、team-admission.ts）。
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Actor } from "./auth/context.js";
import { visibleProjectIds } from "./auth/visibility.js";
import { db } from "./db/index.js";
import { tasks } from "./db/schema.js";
import { dispatchTree } from "./dispatch-hold.js";
import { hasActiveFreeReview } from "./free-workflow.js";
import type { DispatchBelow } from "./task-action-verdicts.js";
export { HIDDEN_BELOW_TEXT } from "./task-action-verdicts.js";

/** 能当派活人的：普通的独立任务（同 task-dispatch.ts `canDispatch`）。 */
export function isDispatcher(row: { mode: string | null; parentId: string | null }): boolean {
  return (row.mode ?? "single") === "single" && !row.parentId;
}

/** `actor` 看不见的项目（不给 actor = 服务端自己读，全看得见）。 */
async function hiddenProject(actor: Actor | undefined): Promise<(projectId: string) => boolean> {
  const visible = actor ? await visibleProjectIds(actor) : null;
  return (projectId) => visible !== null && !visible.has(projectId);
}

/**
 * 名下整棵往下还没归档的那几条，带归档判据要的事实。中间那层归档了照样往下找。`actor` 看不见的那几条只记
 * 「看不见」，标题不带出去。
 */
export async function readDispatchBelow(taskId: string, actor?: Actor): Promise<DispatchBelow[]> {
  const ids = await dispatchTree(taskId);
  if (!ids.length) return [];
  const hidden = await hiddenProject(actor);
  const rows = await db.select({
    id: tasks.id, title: tasks.title, status: tasks.status, verifyRound: tasks.verifyRound, workflowMode: tasks.workflowMode,
    projectId: tasks.projectId,
  }).from(tasks).where(and(inArray(tasks.id, ids), eq(tasks.archived, false), isNull(tasks.parentId)));
  return Promise.all(rows.map(async (row) => ({
    id: row.id,
    hidden: hidden(row.projectId),
    title: hidden(row.projectId) ? null : row.title,
    status: row.status,
    verifyRound: row.verifyRound,
    freeReviewActive: row.workflowMode === "free" ? await hasActiveFreeReview(row.id) : false,
  })));
}

/** 取回时跟着回来的：名下整棵里跟它同一刻归档的。`hidden` = 里面有 `actor` 看不见的（那就整笔不取回）。 */
export async function archivedTogether(taskId: string, archivedAt: string | null, actor?: Actor): Promise<{ ids: string[]; hidden: boolean }> {
  if (!archivedAt) return { ids: [], hidden: false };
  const ids = await dispatchTree(taskId);
  if (!ids.length) return { ids: [], hidden: false };
  const hidden = await hiddenProject(actor);
  const rows = await db.select({ id: tasks.id, projectId: tasks.projectId }).from(tasks)
    .where(and(inArray(tasks.id, ids), eq(tasks.archived, true), eq(tasks.archivedAt, archivedAt)));
  return { ids: rows.map((row) => row.id), hidden: rows.some((row) => hidden(row.projectId)) };
}
