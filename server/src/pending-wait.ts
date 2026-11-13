// 托盘上每条待发送消息「此刻在等什么」「能不能引导」—— 随 `GET /tasks/:id/scheduled-messages` 下发。
//
// 等待原因不另起判据:跟投递扫描读同一份事实、过同一个纯判定(pending-delivery-facts.ts 的
// deliveryVerdictOf),只是把判了「等」的那几种按结构说出来。托盘从前按 mode 写死「等待当前一轮
// 结束」,任务早就不在跑、真正挡着它的是同队另一条任务时,用户只能得出「卡住了」。
import { and, eq, inArray } from "drizzle-orm";
import type { ScheduledMessageWait } from "@ash/shared/scheduled-message-wait";
import { isUserAuthoredMessage } from "@ash/shared/scheduled-message-author";
import { db } from "./db/index.js";
import { queueItems, scheduledMessages, tasks } from "./db/schema.js";
import type { AfterGate } from "./pending-after.js";
import { deliveryVerdictOf } from "./pending-delivery-facts.js";
import { isDueForDelivery, pendingExecutionIntent } from "./pending-verdict.js";
import { publishPendingMessages } from "./pending-messages.js";
import { steerRefusal } from "./task-steer-gate.js";

type Row = typeof scheduledMessages.$inferSelect;
type TaskRow = typeof tasks.$inferSelect;

async function waitOf(m: Row & AfterGate, t: TaskRow | null, at: Date): Promise<ScheduledMessageWait | null> {
  if (m.deliveringSince) return { kind: "delivering" };
  const { verdict, facts } = await deliveryVerdictOf({ ...m, execution: pendingExecutionIntent(m, t) }, t, at);
  if (verdict.action !== "wait" || !t) return null;
  if (!isDueForDelivery(m, at)) return { kind: "schedule" };
  // 次序跟 deliveryVerdict 一致:先看本任务这一轮,再看队列与分组。
  if (t.mode === "single" && t.status === "running") return { kind: "turn" };
  if (facts.groupPaused) return { kind: "groupPaused" };
  if (facts.queueBlocking.length) return { kind: "queue", blockers: facts.queueBlocking };
  // queued = 已被拉起、还没 spawn:也是在等本任务这一轮。
  if (t.mode === "single" && t.status === "queued") return { kind: "turn" };
  // 余下的是审查归属没落定这类过程态:说不准就不说。
  return null;
}

/** rows 已按托盘顺序排好(sendAt、createdAt、id),同一个任务。 */
export async function pendingMessagePresence<R extends Row & AfterGate>(taskId: string, rows: R[], at = new Date()):
  Promise<Array<R & { wait: ScheduledMessageWait | null; steerable: boolean }>> {
  if (!rows.length) return [];
  const t = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0) ?? null;
  const firstUserQueued = rows.find((m) => m.mode === "queued" && isUserAuthoredMessage(m))?.id;
  return Promise.all(rows.map(async (m) => ({
    ...m,
    wait: await waitOf(m, t, at),
    steerable: steerRefusal(m, t, firstUserQueued) === null,
  })));
}

// ── 等待说明的失效通知 ──────────────────────────────────────────────────────────
// 上面算出来的 wait / steerable 读的是别处的事实:本任务和同队成员的状态、队列成员与顺序、分组
// 暂停。这些一变,已经打开的托盘就该重拉,否则会一直说着「等某某」(而某某早跑完了),或者分组
// 都暂停了还说在等前项。通知只有一种 —— 托盘本来就认的 task.pendingMessages,前端不必再猜哪些
// 事件可能改了等待原因。只发给真挂着待发送消息的任务。

async function republish(taskIds: readonly string[]): Promise<void> {
  if (!taskIds.length) return;
  const rows = await db.selectDistinct({ taskId: scheduledMessages.taskId }).from(scheduledMessages)
    .where(and(inArray(scheduledMessages.taskId, [...taskIds]), eq(scheduledMessages.status, "pending")));
  for (const { taskId } of rows) publishPendingMessages(taskId);
}

/** 任务状态变了(status.ts 每次落状态都调):它自己和同队成员的等待原因都可能变。 */
export async function republishWaitsAround(taskId: string): Promise<void> {
  const item = (await db.select().from(queueItems).where(eq(queueItems.taskId, taskId))).at(0);
  const members = item
    ? (await db.select({ taskId: queueItems.taskId }).from(queueItems).where(eq(queueItems.queueId, item.queueId))).map((m) => m.taskId)
    : [];
  await republish([taskId, ...members]);
}

/** 队列成员或顺序变了:调用方给出受影响的那几条(连同被移出的)。 */
export const republishWaitsOf = republish;

/** 分组暂停 / 恢复。 */
export async function republishGroupWaits(groupId: string): Promise<void> {
  await republish((await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.groupId, groupId))).map((t) => t.id));
}
