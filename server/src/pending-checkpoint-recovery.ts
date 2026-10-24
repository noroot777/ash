import { and, eq, isNotNull, isNull, ne } from "drizzle-orm";
import { db, dbClient } from "./db/index.js";
import { scheduledMessages, tasks } from "./db/schema.js";
import { restoreMonitorCheckpoint } from "./monitor-checkpoint-handoff.js";

export const CHECKPOINT_RUN_ORIGIN = "checkpoint:resume";

const undeliveredCheckpoint = () => and(
  ne(scheduledMessages.status, "sent"),
  isNotNull(scheduledMessages.checkpointTaken),
);

export async function recoverPendingCheckpoints(taskId?: string): Promise<Set<string>> {
  const failed = new Set<string>();
  if (dbClient.closed) return failed;
  let receipts: (typeof scheduledMessages.$inferSelect)[];
  try {
    receipts = await db.select().from(scheduledMessages).where(and(
      undeliveredCheckpoint(), isNull(scheduledMessages.deliveringSince),
      taskId ? eq(scheduledMessages.taskId, taskId) : undefined,
    ));
  } catch (error) {
    console.error(`[ash] 未送达续跑交代读取失败 task=${taskId ?? "all"}:`, error);
    if (!taskId) throw error;
    failed.add(taskId);
    return failed;
  }
  for (const receipt of receipts) {
    if (failed.has(receipt.taskId)) continue;
    try {
      await restoreMonitorCheckpoint(receipt);
    } catch {
      failed.add(receipt.taskId);
    }
  }
  return failed;
}

export async function pendingCheckpointBlockReason(
  taskId: string,
  ownedMessageIds: readonly string[] = [],
): Promise<string | null> {
  const receipts = await db.select().from(scheduledMessages).where(and(
    eq(scheduledMessages.taskId, taskId), undeliveredCheckpoint(),
  ));
  const owned = new Set(ownedMessageIds);
  return receipts.some((receipt) => !owned.has(receipt.id) || receipt.deliveringSince === null
    || (receipt.status !== "pending" && receipt.origin !== CHECKPOINT_RUN_ORIGIN))
    ? "未送达的续跑交代仍由消息账本保管，归还或完成交接后才能启动"
    : null;
}

export async function preparePendingCheckpointStart(taskId: string): Promise<string | null> {
  try {
    if (dbClient.closed) return "数据库正在关闭，续跑交代尚未交接";
    const failed = await recoverPendingCheckpoints(taskId);
    if (failed.has(taskId)) return "续跑交代归还失败，原文仍保存在消息账本中，请稍后重试";
    return await pendingCheckpointBlockReason(taskId);
  } catch (error) {
    console.error(`[ash] 续跑交代准入检查失败 task=${taskId}:`, error);
    return "暂时无法确认续跑交代的持久归属，请稍后重试";
  }
}

export async function checkpointReadyTask(taskId: string): Promise<typeof tasks.$inferSelect | null> {
  return db.transaction(async (transaction) => {
    const outstanding = await transaction.select({ id: scheduledMessages.id }).from(scheduledMessages)
      .where(and(eq(scheduledMessages.taskId, taskId), undeliveredCheckpoint()));
    if (outstanding.length) return null;
    return (await transaction.select().from(tasks).where(eq(tasks.id, taskId))).at(0) ?? null;
  });
}
