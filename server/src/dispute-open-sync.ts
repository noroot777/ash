import { and, eq } from "drizzle-orm";
import { bus } from "./bus.js";
import { db } from "./db/index.js";
import { freeReviewRounds, freeReviewRuns } from "./db/schema.js";
import { awaitingRuling } from "./free-review-awaiting-ruling.js";

// 「等你裁定」（Task.disputeOpen）变了就重发一次任务快照。
//
// 它是任务列表上的一格后台事实（task-store.ts 现查），住在审查轮次上，改它不动 tasks.updated_at；
// 侧栏只认 task.created / task.updated，审查面板才认 task.review。驳回落下、维持、采纳、转独立任务
// （连同建任务失败后的回滚）、被新一轮审查取代 —— 每一处写完都会发 task.review，所以推送挂在这条
// 事件上：任何一个出口不必再记得「另外补发一次快照」，以后多一个出口也一样（第 1 轮审查：转独立
// 任务那一路提前返回，漏了补发，侧栏一直写着等你裁定）。
//
// task.review 也随审查进度频繁地发；这里先查一次那一格，**变了**才重发，不变不打扰列表。只记
// 「此刻是 true」的那些任务：重启后第一次看到它为 true 时会多发一次，无害。

const open = new Set<string>();
const pending = new Map<string, Promise<void>>();

async function disputeOpenNow(taskId: string): Promise<boolean> {
  const rows = await db.select({ id: freeReviewRounds.id }).from(freeReviewRounds)
    .innerJoin(freeReviewRuns, eq(freeReviewRuns.id, freeReviewRounds.runId))
    .where(and(eq(freeReviewRuns.taskId, taskId), awaitingRuling))
    .limit(1);
  return rows.length > 0;
}

async function check(taskId: string): Promise<void> {
  const now = await disputeOpenNow(taskId);
  if (now === open.has(taskId)) return;
  if (now) open.add(taskId);
  else open.delete(taskId);
  const { publishTaskUpdated } = await import("./task-store.js");
  await publishTaskUpdated(taskId);
}

/** 同一个任务的几次核对排成一队：并发跑的话，后读到的旧值可能晚落地，把集合改回去。 */
function queueCheck(taskId: string): Promise<void> {
  const next = (pending.get(taskId) ?? Promise.resolve())
    .then(() => check(taskId))
    .catch((error: unknown) => console.warn(`[ash] 核对任务 ${taskId} 的等裁定标记失败:`, error));
  pending.set(taskId, next);
  void next.finally(() => { if (pending.get(taskId) === next) pending.delete(taskId); });
  return next;
}

let started = false;
/** 挂上事件总线。task-store.ts 加载时调一次 —— 列表投影在哪，这条推送就在哪。 */
export function startDisputeOpenSync(): void {
  if (started) return;
  started = true;
  bus.subscribe((event) => {
    if (event.type === "task.review") void queueCheck(event.taskId);
  });
}

/** 测试用：等某个任务排着的核对都落地。 */
export function disputeOpenSettled(taskId: string): Promise<void> {
  return pending.get(taskId) ?? Promise.resolve();
}
