import { and, eq, inArray, isNull } from "drizzle-orm";
import { monitorIdFromOrigin } from "@ash/shared/monitor";
import { readMonitorWake, type MonitorWakeData } from "@ash/shared/monitor-wake";
import { db } from "./db/index.js";
import { scheduledMessages } from "./db/schema.js";
import { beginDelivery } from "./pending-messages.js";
import { hasPendingDeliveryRecovery } from "./pending-delivery-recovery.js";
import { preparePendingCheckpointStart } from "./pending-checkpoint-recovery.js";
import { retryBlocked } from "./pending-redelivery.js";
import { isDueForDelivery } from "./pending-verdict.js";
import { mintLeaseStamp } from "./delivery-fence.js";
import { endNotOwed, endOwedOrigins, finishingNow } from "./monitor-end-owed.js";

type Row = typeof scheduledMessages.$inferSelect;

export function pendingMessageOrder(first: Row, second: Row): number {
  return first.sendAt.localeCompare(second.sendAt)
    || first.createdAt.localeCompare(second.createdAt)
    || first.id.localeCompare(second.id);
}

function batchTarget(message: Row): string | null {
  if (monitorIdFromOrigin(message.origin) === null || message.mode !== "queued") return null;
  const role = message.sessionRole ?? "single";
  if (role !== "single" && role !== "reviewer") return null;
  return JSON.stringify([
    message.taskId, role,
    role === "reviewer" ? message.reviewRun : null,
    role === "reviewer" ? message.reviewRound ?? 1 : null,
    message.agent, message.executorId, message.model, message.reasoningEffort,
    message.ownerUserId, message.execution, message.attachments,
  ]);
}

export async function beginPendingBatch(message: Row): Promise<Row[]> {
  if (await preparePendingCheckpointStart(message.taskId)) return [];
  const target = batchTarget(message);
  if (target === null) {
    const claimed = await beginDelivery(message.id);
    return claimed ? [claimed] : [];
  }
  if (hasPendingDeliveryRecovery(message.taskId)) return [];
  return db.transaction(async (transaction) => {
    const pending = (await transaction.select().from(scheduledMessages).where(and(
      eq(scheduledMessages.taskId, message.taskId), eq(scheduledMessages.status, "pending"),
    ))).sort(pendingMessageOrder);
    const first = pending.findIndex((candidate) => candidate.id === message.id);
    if (first < 0) return [];
    const at = new Date();
    const owed = await endOwedOrigins(message.taskId, transaction);
    const selected: Row[] = [];
    for (const candidate of pending.slice(first)) {
      if (candidate.deliveringSince !== null || batchTarget(candidate) !== target
        || !isDueForDelivery(candidate, at) || retryBlocked(candidate.id, at.getTime())
        // 还欠着一声「结束」的哨兵名下的行这一批不带(monitor-end-owed.ts):结束并进来之后一起送。
        || owed.has(candidate.origin!)) break;
      selected.push(candidate);
    }
    // 收尾槽位只在内存里:发 CAS 之前同步再问一次,挑完之后才开始收尾的那条也不带走。
    if (!selected.length || selected.some((candidate) => finishingNow(candidate.origin))) return [];
    // 同一笔领取铸一个租约值,整批共用:后面的归还/确认凭它证明「还是这一次」(delivery-fence.ts)。
    const claimed = await transaction.update(scheduledMessages).set({ deliveringSince: mintLeaseStamp() })
      .where(and(
        inArray(scheduledMessages.id, selected.map((candidate) => candidate.id)),
        eq(scheduledMessages.status, "pending"), isNull(scheduledMessages.deliveringSince),
        endNotOwed,
      )).returning();
    if (claimed.length !== selected.length) throw new Error("哨兵批次投递租约未完整领取");
    return claimed.sort(pendingMessageOrder);
  });
}

export function batchMonitorWake(messages: Row[], checkpoints: string[]): MonitorWakeData | undefined {
  const data = messages.map((message) => readMonitorWake(message.monitorWake));
  if (data.some((input) => !input)) return undefined;
  return {
    version: 1,
    events: data.flatMap((input) => input!.events),
    omittedEvents: data.reduce((count, input) => count + input!.omittedEvents, 0),
    ...(checkpoints.length ? { checkpoint: checkpoints.join("\n\n") } : {}),
  };
}
