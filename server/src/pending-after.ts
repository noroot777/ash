// ── 「等某任务完成后发送」(mode=after)的前置判定 ───────────────────────────────
// 到期判据 `isDueForDelivery` 是纯函数,而 after 的「到没到」取决于**另一个任务**。所以这里
// 把前置的事实查好,折成 `afterDone` 贴在消息上交给它,判据本身仍然只有一份(pending-verdict.ts)。
// 投递扫描、让位交接、结算让路三个入口都经这里。
//
// 「完成」是一个**事件**——前置任务落 done 的那一刻,不是「它此刻碰巧是什么状态」:
//   • 事件发生就锁存进 `after_done_at`(status.ts 终态钩子写;漏写的由这里读到 done 时补写)。
//     锁存之后前置任务再被重跑、失败、删除都撤不回 —— 那句话已经等到了,只差本任务空闲。
//   • 没锁存时只认**实际** status=done。已完成任务正在处理新消息(running + followUpFrom=done)
//     不算:用户在候选里看到的是「运行中」,等的就是这一轮结束(结束时落 done,事件照常触发)。
//     队列的 `queueStatus` 把这种续聊当 done 透明跳过,那是队列的口径,不能拿来当这里的「完成」。
//   • 失败/取消/被删/归档都不算 —— 用户说的是「等它完成」,没完成就发出去违背原意,悄悄取消又让
//     那句话凭空消失。一律判「等」,给一句人话说清在等什么(托盘与滞留告警读它)。
//   • 团队调度台正常收尾落 idle,没有 done 这一步,等它永远等不到:写入口拒收(task-reply.ts),
//     存量行在这里说清原因。
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { TaskStatus } from "@ash/shared";
import { TASK_STATUS_LABELS } from "@ash/shared";
import { db } from "./db/index.js";
import { scheduledMessages, tasks } from "./db/schema.js";

type AfterTaskFacts = {
  id: string;
  title: string | null;
  mode: string;
  status: string;
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

/** 团队调度台没有「完成」这一步,不能被等(写入口与存量行共用这一句)。 */
export function afterTargetUnsupported(task: { mode: string }): string | null {
  return task.mode === "team" ? "团队调度台收工后是待命、不会落到「完成」，不能等它完成后再发" : null;
}

/** 纯判定:给定锁存时刻与前置任务的事实(null = 查不到),这条 after 消息到没到。 */
export function afterGateOf(doneAt: string | null, task: AfterTaskFacts | null): AfterGate {
  if (doneAt) return { afterDone: true, afterEndedAt: doneAt, afterWaitReason: null };
  if (!task) return { ...NOT_AFTER, afterWaitReason: "前置任务已删除或不可见，它不会再完成" };
  const name = `「${task.title || "未命名任务"}」`;
  const unsupported = afterTargetUnsupported(task);
  if (unsupported) return { ...NOT_AFTER, afterWaitReason: `前置任务${name}：${unsupported}` };
  if (task.status === "done") return { afterDone: true, afterEndedAt: task.endedAt, afterWaitReason: null };
  if (task.archived) return { ...NOT_AFTER, afterWaitReason: `前置任务${name}已归档且未完成` };
  const label = TASK_STATUS_LABELS[task.status as TaskStatus] ?? task.status;
  if (task.status === "failed" || task.status === "canceled") {
    return { ...NOT_AFTER, afterWaitReason: `前置任务${name}${label}，重跑完成后才会发` };
  }
  return { ...NOT_AFTER, afterWaitReason: `等前置任务${name}完成（当前：${label}）` };
}

/** 锁存:把等 `afterTaskId` 的、还没记下完成时刻的待发送消息记成「已等到」。幂等。 */
export async function latchAfterDone(afterTaskId: string, doneAt: string): Promise<void> {
  await db.update(scheduledMessages).set({ afterDoneAt: doneAt }).where(and(
    eq(scheduledMessages.afterTaskId, afterTaskId),
    eq(scheduledMessages.mode, "after"),
    eq(scheduledMessages.status, "pending"),
    isNull(scheduledMessages.afterDoneAt),
  ));
}

/** 给一批消息贴上前置判定。非 after 的原样返回(afterDone=false 对它们不起作用)。
 * 读到前置已 done 而行上还没锁存的(终态钩子没赶上:进程中途退出、状态被直接改写),顺手补锁。 */
export async function withAfterGates<T extends { mode: string; afterTaskId: string | null; afterDoneAt: string | null }>(
  rows: T[],
): Promise<(T & AfterGate)[]> {
  const ids = [...new Set(rows.filter((m) => m.mode === "after" && m.afterTaskId && !m.afterDoneAt).map((m) => m.afterTaskId!))];
  const facts = ids.length
    ? await db
      .select({
        id: tasks.id, title: tasks.title, mode: tasks.mode, status: tasks.status,
        archived: tasks.archived, endedAt: tasks.endedAt,
      })
      .from(tasks)
      .where(inArray(tasks.id, ids))
    : [];
  const byId = new Map(facts.map((t) => [t.id, t] as const));
  const gated = rows.map((m) => ({
    ...m,
    ...(m.mode === "after"
      ? afterGateOf(m.afterDoneAt, m.afterTaskId ? byId.get(m.afterTaskId) ?? null : null)
      : NOT_AFTER),
  }));
  const late = new Map<string, string>();
  for (const m of gated) {
    if (m.mode === "after" && m.afterTaskId && !m.afterDoneAt && m.afterDone) {
      late.set(m.afterTaskId, m.afterEndedAt ?? new Date().toISOString());
    }
  }
  for (const [afterTaskId, doneAt] of late) await latchAfterDone(afterTaskId, doneAt);
  return gated;
}

/**
 * 前置任务刚落到终态(status.ts 的终态钩子调):落的是 done 就先锁存,再把**等着它的那些消息
 * 所在的任务**各扫一遍。只靠 30s tick 的话,用户会对着一条已经该发的消息干等最多半分钟。
 */
export async function flushPendingAfterTask(taskId: string, status: string): Promise<void> {
  if (status === "done") await latchAfterDone(taskId, new Date().toISOString());
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
