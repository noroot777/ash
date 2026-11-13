// 一条待发送消息「此刻送不送得出去」要的那几样持久事实：队列占位、分组暂停、起哨兵的那次审查还在不在、审查归属。
// 判定本身是 pending-verdict.ts 的纯函数 deliveryVerdict，这里只负责把它要的事实读齐。
//
// 两处读同一份：投递扫描（pending-messages.ts scanPendingMessages）按它决定发不发；飞书推卡（im/attention.ts）按它
// 判「任务停下来了，但托盘里那条一会儿就会把它叫起来」。事实从前内联在扫描循环里，推卡那边只能拿「到期了」去近似，
// 于是一条被分组暂停挡着、永远不会自己送出去的执行型消息，把失败卡撤掉了（第 1 轮审查实测）。
import { and, eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { groups, scheduledMessages, tasks } from "./db/schema.js";
import { monitorIdFromOrigin } from "@ash/shared/monitor";
import { monitorEventSourceState } from "./monitor-session.js";
import { withAfterGates, type AfterGate } from "./pending-after.js";
import { deliveryVerdict, storedExecutionIntent, type DeliveryVerdict } from "./pending-verdict.js";
import { queueBlockerDetails, type QueueBlocker } from "./queues.js";
import { reviewDeliveryBlocked, reviewDeliveryFrom } from "./review-ownership.js";

type Row = typeof scheduledMessages.$inferSelect;
type TaskRow = typeof tasks.$inferSelect;

export interface DeliveryFacts {
  /** 投递是续聊、不是执行回合（paused + resumePrompt 上的追问，或审查答复）：不问队列。 */
  checkpointFollowUp: boolean;
  /** 这一次投递会开执行回合，要认领队列执行占位。 */
  needQueueCheck: boolean;
  queueBlocked: boolean;
  /** 挡路的是哪几条(带标题,在跑的排前);没问队列或没被挡时为空。托盘的等待说明点名用。 */
  queueBlocking: QueueBlocker[];
  groupPaused: boolean;
}

/** m.execution 由调用方按 storedExecutionIntent 定好再传进来（扫描会把它写回库，这里不写）。 */
export async function deliveryVerdictOf(m: Row & AfterGate, t: TaskRow | null, at: Date): Promise<{ verdict: DeliveryVerdict; facts: DeliveryFacts }> {
  // checkpoint 追问经待发送路径投递(定时发送、第一句还在回答时自动排队的第二句)
  // 时,与直接回复同判据旁路(task-reply.ts / orchestrator 的 checkpointFollowUp):
  // paused+resumePrompt 任务上的非执行型消息,投递是续聊不是执行 —— 占位会把
  // paused 翻成 queued,orchestrator 误判成执行回合:消费继续指令、无确认结算
  // failed(第 ll7XKsu_ps0n 链第 1 轮:定时追问与连续追问实测,直接回复对照正常)。
  const checkpointFollowUp =
    reviewDeliveryFrom(m)?.kind === "answer" ||
    t != null && t.mode === "single" && !m.execution && t.status === "paused" && !!t.resumePrompt;
  // paused/backlog 的单任务、以及执行型消息(不论任务状态)才需要问队列;执行型
  // 还要问分组暂停。其余状态别白查几张表。
  const needQueueCheck =
    t != null && t.mode === "single" && !checkpointFollowUp
    && (m.execution || t.status === "paused" || t.status === "backlog");
  const queueBlocking = needQueueCheck ? await queueBlockerDetails(m.taskId) : [];
  const queueBlocked = queueBlocking.length > 0;
  const groupPaused =
    t != null && t.mode === "single" && m.execution && t.groupId
      ? !!(await db.select().from(groups).where(eq(groups.id, t.groupId))).at(0)?.paused
      : false;
  // 「**起它的那次、那一轮**审查现在是什么状态」——只对哨兵事件查,但**无条件查**,
  // 不按任务状态短路:来源失效是这条消息自己的资格,而审查完全可以跑在一个 paused
  // 任务上、它收尾时也不触发任何终态清理(第 2 轮审查 F5)。只多这一次库查,而且只在
  // 托盘里真有哨兵事件时才发生。
  const monitorSource = t != null && monitorIdFromOrigin(m.origin) !== null
    ? await monitorEventSourceState(m.origin)
    : undefined;
  const reviewBlocked = await reviewDeliveryBlocked(reviewDeliveryFrom(m), m.taskId);
  const verdict = deliveryVerdict(m, t ? { ...t, queueBlocked, groupPaused, monitorSource, reviewBlocked,
    reviewUncertain: t.waitOwnership?.start?.phase === "uncertain" } : null, at);
  return { verdict, facts: { checkpointFollowUp, needQueueCheck, queueBlocked, queueBlocking, groupPaused } };
}

/**
 * 托盘里有没有一条此刻判得出「送」的消息 —— 任务一空下来它就会被送进会话、接着跑。正在送的（带租约）也算。
 * 只回答「自己会接着跑吗」，不管投递节奏（失败退避、正在恢复的交付）：那些是送的过程，不改变它会被送这件事。
 */
export async function deliversOnItsOwn(taskId: string, at = new Date()): Promise<boolean> {
  const t = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0) ?? null;
  if (!t) return false;
  const rows = await db.select().from(scheduledMessages)
    .where(and(eq(scheduledMessages.taskId, taskId), eq(scheduledMessages.status, "pending")));
  for (const m of await withAfterGates(rows)) {
    if (m.deliveringSince) return true;
    const { verdict } = await deliveryVerdictOf({ ...m, execution: storedExecutionIntent(m, t) }, t, at);
    if (verdict.action === "deliver") return true;
  }
  return false;
}
