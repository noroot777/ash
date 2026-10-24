import { continueTask } from "./orchestrator.js";
import { abortDelivery, cancelPendingMessage, markSent } from "./pending-messages.js";
import { beginPendingBatch, batchMonitorWake } from "./pending-monitor-batch.js";
import { recoverPendingDelivery } from "./pending-delivery-recovery.js";
import { monitorIdFromOrigin } from "@ash/shared/monitor";
import { scheduleRedelivery } from "./pending-redelivery.js";
import { deliveryOptions, monitorWakeGuard } from "./pending-verdict.js";
import { monitorWakeCheckpoint } from "./monitor-session.js";
import { noteDeliveryTiming } from "./pending-delivery-timing.js";
import type { scheduledMessages } from "./db/schema.js";
import type { QueueSeat } from "./queue-seat.js";

type Row = typeof scheduledMessages.$inferSelect;
type Checkpoint = NonNullable<Awaited<ReturnType<typeof monitorWakeCheckpoint>>>;

export async function dispatchPendingMessage(
  message: Row,
  context: {
    spans: { dueAt: number; busyMs: number; queuedAt: number };
    team?: boolean;
    seat?: QueueSeat;
    onClaim: () => void;
    onSettled?: () => void;
  },
): Promise<void> {
  let delivered = false;
  const refused = new Map<string, string>();
  const checkpoints: Checkpoint[] = [];
  let claimed: Row[] = [];
  const idleAt = Date.now();
  const monitor = monitorIdFromOrigin(message.origin) !== null;
  const retry = async (reason: string) => {
    if (monitor) {
      await recoverPendingDelivery(claimed, refused, checkpoints, reason);
      return;
    }
    await abortDelivery(claimed);
    const at = Date.now();
    for (const current of claimed) scheduleRedelivery(current, reason, at);
  };
  try {
    claimed = await beginPendingBatch(message);
    if (!claimed.length) return;
    context.onClaim();
    const texts: string[] = [];
    try {
      for (const current of claimed) {
        const checkpoint = await monitorWakeCheckpoint(current);
        if (checkpoint) checkpoints.push(checkpoint);
        texts.push(checkpoint?.text ?? current.text);
      }
    } catch (error) {
      await retry(`读取续跑交代失败，原文退回待发送：${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const guards = claimed.map((current) => ({ current, guard: monitorWakeGuard(current) }));
    const started = await continueTask(message.taskId, texts.join("\n\n"), {
      ...deliveryOptions(claimed[0]!),
      monitorWake: batchMonitorWake(claimed, checkpoints.map((checkpoint) => checkpoint.checkpoint)),
      ...(guards.some(({ guard }) => guard) ? {
        wakeGuard: async () => {
          for (const { current, guard } of guards) {
            const reason = await guard?.();
            if (reason) refused.set(current.id, reason);
          }
          return refused.values().next().value ?? null;
        },
      } : {}),
      ...(context.team ? { throwOnTeamUnavailable: true } : {}),
      onDelivered: async () => {
        delivered = true;
        await markSent(claimed);
        noteDeliveryTiming(message.taskId, { ...context.spans, idleAt, at: Date.now() });
      },
    });
    if (!delivered) {
      if (!monitor) {
        for (const current of claimed) {
          const reason = refused.get(current.id);
          if (reason) await cancelPendingMessage(current, reason);
        }
        claimed = claimed.filter((current) => !refused.has(current.id));
      }
      if (claimed.length) await retry(context.team
        ? "这一轮没起：调度台收不下（正在收尾或已离线），或起跑前的资格检查读不到状态"
        : started
          ? "回合起跑失败，原文退回待发送"
          : "回合被其它执行抢占、工作区正被验收占用，或起跑前的资格检查读不到状态");
    }
  } catch (error) {
    if (delivered) {
      if (context.team) throw error;
      return;
    }
    const detail = error instanceof Error ? error.message : String(error);
    if (!claimed.length) scheduleRedelivery(message, `领取待发送消息失败：${detail}`);
    else if (monitor) {
      await retry(`续跑尚未送达，原文退回待发送：${detail}`);
      return;
    }
    for (const current of claimed) {
      await cancelPendingMessage(current, `${context.team ? "调度台不可用" : "续跑失败"}：${detail}`).catch(() => {});
    }
  } finally {
    if (!delivered && !monitor) {
      for (const checkpoint of checkpoints.reverse()) await checkpoint.restore().catch(() => {});
    }
    context.onSettled?.();
    if (context.seat && !delivered) await context.seat.release();
  }
}
