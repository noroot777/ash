import { continueTask } from "./orchestrator.js";
import { createDeliveryLease } from "./delivery-lease.js";
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
    /** 摘掉这一次的「在途」标记(pending-in-flight.ts):回合起来了、或这一次投递收场,先到先摘。 */
    release?: () => void;
  },
): Promise<void> {
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
  // 在途租约:三档回执怎么处置这张租约、迟到的那一次怎么收口,统一在 ./delivery-lease.ts
  // (三个投递入口各写一遍就会各漏一处 —— 那正是第 2 轮自由审查 F3)。
  // `callerMustReturn()` 取代了原来那个 `delivered` 布尔:它答的是「这张租约该不该由我归还并
  // 重投」,**只按协议定论**算 —— accepted 一次都不授权归还(哪怕 markSent 还欠着,那是本地账,
  // 只能补不能靠退回来结;第 2 轮自由审查 F1 实测过那次重复执行),unknown 留在在途,
  // 确证拒收且还没归还成才轮到下面这几支动手(归还幂等,撞上也只是空转)。
  const lease = createDeliveryLease({
    label: `任务 ${message.taskId} 的待发送消息`,
    onAccepted: async () => {
      await markSent(claimed);
      noteDeliveryTiming(message.taskId, { ...context.spans, idleAt, at: Date.now() });
    },
    onReturn: async (why) => { await retry(why); },
  });
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
      pendingMessageIds: claimed.map((current) => current.id),
      // 合并成一回合的几条里有几条答复，就记几条（删这一回合时一并清掉它们的问答记录）。
      answerIds: claimed.flatMap((current) => current.answerId ? [current.answerId] : []),
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
      // 三档处置整份在 ./delivery-lease.ts(含「迟到的拒收由回执这条路自己归还」—— 三个入口
      // 各写一遍就会各漏一处,那正是第 2 轮自由审查 F3)。
      // 回执一落定,这一回合就已经起来了:在途标记到此为止,不跟着挂到回合跑完。
      onInputSettled: (acceptance) => lease.settle(acceptance).finally(() => context.release?.()),
    });
    if (lease.callerMustReturn()) {
      if (!monitor) {
        for (const current of claimed) {
          const reason = refused.get(current.id);
          if (reason) await cancelPendingMessage(current, reason);
        }
        claimed = claimed.filter((current) => !refused.has(current.id));
      }
      if (claimed.length) await retry(lease.acceptance() === "refused"
        // 确证拒收:说清是协议层拒了,别拿「起跑失败」盖过去(租约那边也在补同一笔,幂等)。
        ? "协议层明确拒收：回合输入一个字都没写出去，原文退回待发送"
        : context.team
          ? "这一轮没起：调度台收不下（正在收尾或已离线），或起跑前的资格检查读不到状态"
          : started
            ? "回合起跑失败，原文退回待发送"
            : "回合被其它执行抢占、工作区正被验收占用，或起跑前的资格检查读不到状态");
      // 这一次由我了结了(归还或取消):租约那条补偿到此为止,不许再醒来碰这几行 ——
      // 它们可能已经被下一次投递领走了(第 1 轮自由审查 F1)。
      lease.callerReturned();
    }
  } catch (error) {
    if (!lease.callerMustReturn()) {
      if (context.team) throw error;
      return;
    }
    const detail = error instanceof Error ? error.message : String(error);
    if (!claimed.length) scheduleRedelivery(message, `领取待发送消息失败：${detail}`);
    else if (monitor) {
      await retry(`续跑尚未送达，原文退回待发送：${detail}`);
      lease.callerReturned();
      return;
    }
    for (const current of claimed) {
      await cancelPendingMessage(current, `${context.team ? "调度台不可用" : "续跑失败"}：${detail}`).catch(() => {});
    }
    lease.callerReturned();
  } finally {
    if (lease.callerMustReturn() && !monitor) {
      for (const checkpoint of checkpoints.reverse()) await checkpoint.restore().catch(() => {});
    }
    context.release?.();
    if (context.seat && lease.callerMustReturn()) await context.seat.release();
  }
}
