import { dbClient } from "./db/index.js";
import { abortDelivery, cancelPendingMessage } from "./pending-messages.js";
import { scheduleRedelivery } from "./pending-redelivery.js";
import type { scheduledMessages } from "./db/schema.js";

type Row = typeof scheduledMessages.$inferSelect;
const recovering = new Map<string, Set<symbol>>();

export function hasPendingDeliveryRecovery(taskId: string): boolean {
  return !!recovering.get(taskId)?.size;
}

export async function recoverPendingDelivery(
  messages: Row[],
  refused: Map<string, string>,
  checkpoints: { restore: () => Promise<void> }[],
  reason: string,
): Promise<void> {
  const anchor = messages[0]!;
  const task = recovering.get(anchor.taskId) ?? new Set<symbol>();
  const recovery = Symbol(anchor.id);
  recovering.set(anchor.taskId, task);
  task.add(recovery);
  const cancellations = new Map(refused);
  const retry = messages.filter((message) => !refused.has(message.id));
  const receipts = [...checkpoints];
  let released = false;
  let attempts = 0;
  const forget = () => {
    task.delete(recovery);
    if (!task.size) recovering.delete(anchor.taskId);
  };
  const attempt = async (): Promise<void> => {
    if (dbClient.closed) {
      forget();
      return;
    }
    try {
      for (const [messageId, why] of cancellations) {
        await cancelPendingMessage(messages.find((message) => message.id === messageId)!, why);
        cancellations.delete(messageId);
      }
      if (!released) {
        await abortDelivery(retry);
        released = true;
      }
      while (receipts.length) {
        await receipts.at(-1)!.restore();
        receipts.pop();
      }
      const at = Date.now();
      for (const message of retry) scheduleRedelivery(message, reason, at);
      forget();
    } catch (error) {
      const delay = Math.min(200 * 2 ** Math.min(attempts++, 8), 30_000);
      console.warn(`[ash] 未送达消息补偿失败 task=${anchor.taskId} message=${anchor.id}，${delay}ms 后继续补偿:`, error);
      const timer = setTimeout(() => void attempt(), delay);
      timer.unref?.();
    }
  };
  await attempt();
}
