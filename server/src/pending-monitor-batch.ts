import { and, eq, inArray, isNull } from "drizzle-orm";
import { monitorIdFromOrigin } from "@ash/shared/monitor";
import { readMonitorWake, type MonitorWakeData } from "@ash/shared/monitor-wake";
import { db } from "./db/index.js";
import { scheduledMessages } from "./db/schema.js";
import { beginDelivery } from "./pending-messages.js";
import { hasPendingDeliveryRecovery } from "./pending-delivery-recovery.js";
import { retryBlocked } from "./pending-redelivery.js";
import { isDueForDelivery } from "./pending-verdict.js";
import { now } from "./util.js";

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
    const selected: Row[] = [];
    for (const candidate of pending.slice(first)) {
      if (candidate.deliveringSince !== null || batchTarget(candidate) !== target
        || !isDueForDelivery(candidate, at) || retryBlocked(candidate.id, at.getTime())) break;
      selected.push(candidate);
    }
    if (!selected.length) return [];
    const claimed = await transaction.update(scheduledMessages).set({ deliveringSince: now() })
      .where(and(
        inArray(scheduledMessages.id, selected.map((candidate) => candidate.id)),
        eq(scheduledMessages.status, "pending"), isNull(scheduledMessages.deliveringSince),
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
