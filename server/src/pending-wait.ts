// 托盘上每条待发送消息「此刻在等什么」「能不能引导」—— 随 `GET /tasks/:id/scheduled-messages` 下发。
//
// 等待原因不另起判据:跟投递扫描读同一份事实、过同一个纯判定(pending-delivery-facts.ts 的
// deliveryVerdictOf),只是把判了「等」的那几种按结构说出来。托盘从前按 mode 写死「等待当前一轮
// 结束」,任务早就不在跑、真正挡着它的是同队另一条任务时,用户只能得出「卡住了」。
import { eq } from "drizzle-orm";
import type { ScheduledMessageWait } from "@ash/shared/scheduled-message-wait";
import { isUserAuthoredMessage } from "@ash/shared/scheduled-message-author";
import { db } from "./db/index.js";
import { scheduledMessages, tasks } from "./db/schema.js";
import type { AfterGate } from "./pending-after.js";
import { deliveryVerdictOf } from "./pending-delivery-facts.js";
import { isDueForDelivery, storedExecutionIntent } from "./pending-verdict.js";
import { steerRefusal } from "./task-steer-gate.js";

type Row = typeof scheduledMessages.$inferSelect;
type TaskRow = typeof tasks.$inferSelect;

async function waitOf(m: Row & AfterGate, t: TaskRow | null, at: Date): Promise<ScheduledMessageWait | null> {
  if (m.deliveringSince) return { kind: "delivering" };
  const { verdict, facts } = await deliveryVerdictOf({ ...m, execution: storedExecutionIntent(m, t) }, t, at);
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
