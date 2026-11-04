// ── 「等某任务完成后发送」(mode=after)的前置判定 ───────────────────────────────
// 到期判据 `isDueForDelivery` 是纯函数,而 after 的「到没到」取决于**另一个任务**此刻的
// 状态。所以这里把前置任务的事实批量查好,折成 `afterDone` 贴在消息上交给它,判据本身
// 仍然只有一份(pending-verdict.ts)。投递扫描、让位交接、结算让路三个入口都经这里。
//
// 「完成」只认 done:失败/取消/被删/归档都不算 —— 用户说的是「等它完成」,它没完成就发
// 出去违背原意,悄悄取消又让那句话凭空消失。所以这些情形一律判「等」,并给出一句人话
// 说清在等什么(托盘与滞留告警读它);前置任务被重跑并最终完成时消息照常送出。
import { and, eq, inArray } from "drizzle-orm";
import type { TaskStatus } from "@ash/shared";
import { TASK_STATUS_LABELS } from "@ash/shared";
import { db } from "./db/index.js";
import { scheduledMessages, tasks } from "./db/schema.js";
import { queueStatus } from "./scheduler.js";

type AfterTaskFacts = {
  id: string;
  title: string | null;
  status: string;
  followUpFrom: string | null;
  archived: boolean;
  endedAt: string | null;
};

export type AfterGate = {
  /** 前置任务已完成 = 这条消息到期了(之后照常等本任务空闲)。 */
  afterDone: boolean;
  /** 前置任务完成的时刻:滞留告警从这一刻起算等待,而不是从排下消息那一刻。 */
  afterEndedAt: string | null;
  /** 没完成时在等什么,一句人话。 */
  afterWaitReason: string | null;
};

const NOT_AFTER: AfterGate = { afterDone: false, afterEndedAt: null, afterWaitReason: null };

/** 纯判定:给定前置任务的事实(null = 查不到),这条 after 消息到没到。 */
export function afterGateOf(task: AfterTaskFacts | null): AfterGate {
  if (!task) return { ...NOT_AFTER, afterWaitReason: "前置任务已删除或不可见，它不会再完成" };
  const name = `「${task.title || "未命名任务"}」`;
  // 续聊回合跑在已完成的任务上,status 是 running 但它早就完成了 —— 跟队列同一把尺子。
  const status = queueStatus(task);
  if (status === "done") return { afterDone: true, afterEndedAt: task.endedAt, afterWaitReason: null };
  if (task.archived) return { ...NOT_AFTER, afterWaitReason: `前置任务${name}已归档且未完成` };
  const label = TASK_STATUS_LABELS[status as TaskStatus] ?? status;
  if (status === "failed" || status === "canceled") {
    return { ...NOT_AFTER, afterWaitReason: `前置任务${name}${label}，重跑完成后才会发` };
  }
  return { ...NOT_AFTER, afterWaitReason: `等前置任务${name}完成（当前：${label}）` };
}

/** 给一批消息贴上前置判定。非 after 的原样返回(afterDone=false 对它们不起作用)。 */
export async function withAfterGates<T extends { mode: string; afterTaskId: string | null }>(
  rows: T[],
): Promise<(T & AfterGate)[]> {
  const ids = [...new Set(rows.filter((m) => m.mode === "after" && m.afterTaskId).map((m) => m.afterTaskId!))];
  const facts = ids.length
    ? await db
      .select({
        id: tasks.id, title: tasks.title, status: tasks.status, followUpFrom: tasks.followUpFrom,
        archived: tasks.archived, endedAt: tasks.endedAt,
      })
      .from(tasks)
      .where(inArray(tasks.id, ids))
    : [];
  const byId = new Map(facts.map((t) => [t.id, t] as const));
  return rows.map((m) => ({
    ...m,
    ...(m.mode === "after" ? afterGateOf(m.afterTaskId ? byId.get(m.afterTaskId) ?? null : null) : NOT_AFTER),
  }));
}

/**
 * 前置任务刚落到终态:把**等着它的那些消息所在的任务**各扫一遍。只靠 30s tick 的话,
 * 用户会对着一条已经该发的消息干等最多半分钟(status.ts 的终态钩子调)。
 */
export async function flushPendingAfterTask(taskId: string): Promise<void> {
  const waiting = await db
    .selectDistinct({ taskId: scheduledMessages.taskId })
    .from(scheduledMessages)
    .where(and(
      eq(scheduledMessages.afterTaskId, taskId),
      eq(scheduledMessages.mode, "after"),
      eq(scheduledMessages.status, "pending"),
    ));
  if (!waiting.length) return;
  const { flushPendingForTask, publishPendingMessages } = await import("./pending-messages.js");
  for (const row of waiting) {
    // 托盘里那一行的「在等什么」跟着前置任务变了(完成/失败),让它重拉一次。
    publishPendingMessages(row.taskId);
    flushPendingForTask(row.taskId);
  }
}
