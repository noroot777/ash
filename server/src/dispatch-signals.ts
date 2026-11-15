// 派出的任务失败的那一刻（表与触发器见 db/schema-dispatch-signals.ts）：读、补原因。
//
// 这些只给**派它的那条任务的页面**看：不进它的会话正文、不进它的上下文、不叫醒它、不改它的状态。
// 写入在那一笔改动的事务里（失败原因：status.ts）。
//
// 派出的任务来问不记在这里：答题卡只在提问的那条任务自己的页面上，派它的那条任务靠任务列表里
// 那一条此刻的样子（question 非空）知道，不需要一份「那一刻」的记录。早一版记下的提问行还在库里，
// 读的时候不给。
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import type { DispatchSignal } from "@ash/shared";
import { bus } from "./bus.js";
import { db } from "./db/index.js";
import { dispatchSignals } from "./db/schema-dispatch-signals.js";
import type { ConclusionTransaction as Transaction } from "./regression-conclusion-commit.js";

/** 一条任务名下记下的那几次失败，按发生先后：(那一刻, 序号)，见 shared 那份类型的说明。 */
export async function listDispatchSignals(dispatcherId: string): Promise<DispatchSignal[]> {
  const rows = await db.select({
    seq: dispatchSignals.seq, taskId: dispatchSignals.taskId, at: dispatchSignals.occurredAt, reason: dispatchSignals.reason,
  }).from(dispatchSignals)
    .where(and(eq(dispatchSignals.dispatcherId, dispatcherId), eq(dispatchSignals.kind, "failed")))
    .orderBy(asc(dispatchSignals.occurredAt), asc(dispatchSignals.seq));
  return rows.map((row) => ({ ...row, kind: "failed" as const }));
}

/** 告诉开着派它的那条任务的页面：去重读一次。事件挂在派它的那条任务上，看得见那条任务的人才收得到。 */
export function announceDispatchSignalsTo(dispatcherId: string | null | undefined): void {
  if (dispatcherId) bus.publish({ type: "task.dispatchSignals", taskId: dispatcherId });
}

const REASON_MAX = 600;

/**
 * 这一次失败的原因，写进触发器**在同一个事务里刚插入**的那一行（status.ts 落 failed 那一笔调它）。
 * 那一行的时刻就是这一笔写下的 updated_at（触发器取 NEW.updated_at），按它认，不按「最新一行」猜：
 * 续聊回到原来的失败、本来就是失败时触发器不记，这里也就什么都不写。
 */
export async function writeDispatchFailureReason(transaction: Transaction, taskId: string, occurredAt: string,
  reason: string | null | undefined): Promise<void> {
  const text = (reason ?? "").replace(/\s+/g, " ").trim().slice(0, REASON_MAX);
  if (!text) return;
  const row = (await transaction.select({ seq: dispatchSignals.seq }).from(dispatchSignals).where(and(
    eq(dispatchSignals.taskId, taskId), eq(dispatchSignals.kind, "failed"),
    eq(dispatchSignals.occurredAt, occurredAt), isNull(dispatchSignals.reason),
  )).orderBy(desc(dispatchSignals.seq)).limit(1)).at(0);
  if (row) await transaction.update(dispatchSignals).set({ reason: text }).where(eq(dispatchSignals.seq, row.seq));
}
