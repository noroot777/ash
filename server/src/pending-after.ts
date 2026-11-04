// ── 「等某任务完成后发送」(mode=after)的前置判定 ───────────────────────────────
// 到期判据 `isDueForDelivery` 是纯函数,而 after 的「到没到」取决于**另一个任务**。所以这里
// 把前置的事实查好,折成 `afterDone` 贴在消息上交给它,判据本身仍然只有一份(pending-verdict.ts)。
// 投递扫描、让位交接、结算让路三个入口都经这里。
//
// 「完成」是一个**事件**,不是「前置此刻碰巧是什么状态」,而且得分得清是**哪一次**完成:
//   • 事件本身持久在前置任务的 `done_seq` 上 —— 每落一次 done 加一,跟 status=done 同一条
//     UPDATE(status.ts)。没有「状态写了、事件还没记」的缝,崩在哪一步都不丢。
//   • 消息登记时记下前置那一刻的基线 `after_seq`(`afterBaselineOf`):前置正闲着停在 done 上
//     = 那次完成就算(基线退一格);否则(在跑、在续聊、失败…)等**下一次**落 done。判据只有
//     `done_seq > after_seq` 这一句,所以迟到的钩子、扫描补锁都只会放行确实被那次完成覆盖的
//     消息,前置刚完成又开始续聊时新排下的那句不会被上一次完成带走。
//   • `done_seq` 只增不减,前置再被重跑、失败也撤不回已经等到的完成。等到时顺手把时刻锁存进
//     `after_done_at`:托盘据此改口,前置被删之后也还认这次完成(删除前先锁一遍,task-delete-routes.ts)。
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
  doneSeq: number;
};

type AfterRow = {
  id: string;
  taskId: string;
  mode: string;
  afterTaskId: string | null;
  afterDoneAt: string | null;
  afterSeq: number | null;
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

/** 登记基线:前置的 `done_seq` 超过它才算等到。读状态与读计数必须出自同一行快照。 */
export function afterBaselineOf(task: { status: string; doneSeq: number }): number {
  return task.status === "done" ? task.doneSeq - 1 : task.doneSeq;
}

/** 纯判定:给定消息的锁存/基线与前置任务的事实(null = 查不到),这条 after 消息到没到。 */
export function afterGateOf(
  message: { afterDoneAt: string | null; afterSeq: number | null },
  task: AfterTaskFacts | null,
): AfterGate {
  if (message.afterDoneAt) return { afterDone: true, afterEndedAt: message.afterDoneAt, afterWaitReason: null };
  if (!task) return { ...NOT_AFTER, afterWaitReason: "前置任务已删除或不可见，它不会再完成" };
  const name = `「${task.title || "未命名任务"}」`;
  const unsupported = afterTargetUnsupported(task);
  if (unsupported) return { ...NOT_AFTER, afterWaitReason: `前置任务${name}：${unsupported}` };
  // 没有基线的行(升级前排下的)只能退回看此刻的状态。
  const done = message.afterSeq == null ? task.status === "done" : task.doneSeq > message.afterSeq;
  if (done) return { afterDone: true, afterEndedAt: task.endedAt, afterWaitReason: null };
  if (task.archived) return { ...NOT_AFTER, afterWaitReason: `前置任务${name}已归档且未完成` };
  const label = TASK_STATUS_LABELS[task.status as TaskStatus] ?? task.status;
  if (task.status === "failed" || task.status === "canceled") {
    return { ...NOT_AFTER, afterWaitReason: `前置任务${name}${label}，重跑完成后才会发` };
  }
  return { ...NOT_AFTER, afterWaitReason: `等前置任务${name}完成（当前：${label}）` };
}

/** 给一批消息贴上前置判定。非 after 的原样返回(afterDone=false 对它们不起作用)。
 * 判到等到了而行上还没锁存的,按**消息 id** 补锁并让托盘重拉 —— 只锁这几行,不按前置 id 扩散。 */
export async function withAfterGates<T extends AfterRow>(rows: T[]): Promise<(T & AfterGate)[]> {
  const ids = [...new Set(rows.filter((m) => m.mode === "after" && m.afterTaskId && !m.afterDoneAt).map((m) => m.afterTaskId!))];
  const facts = ids.length
    ? await db
      .select({
        id: tasks.id, title: tasks.title, mode: tasks.mode, status: tasks.status,
        archived: tasks.archived, endedAt: tasks.endedAt, doneSeq: tasks.doneSeq,
      })
      .from(tasks)
      .where(inArray(tasks.id, ids))
    : [];
  const byId = new Map(facts.map((t) => [t.id, t] as const));
  const at = new Date().toISOString();
  const latch: string[] = [];
  const gated = rows.map((m) => {
    if (m.mode !== "after") return { ...m, ...NOT_AFTER };
    const gate = afterGateOf(m, m.afterTaskId ? byId.get(m.afterTaskId) ?? null : null);
    if (!gate.afterDone || m.afterDoneAt) return { ...m, ...gate };
    latch.push(m.id);
    const doneAt = gate.afterEndedAt ?? at;
    return { ...m, ...gate, afterDoneAt: doneAt, afterEndedAt: doneAt };
  });
  if (latch.length) {
    for (const m of gated) {
      if (!latch.includes(m.id)) continue;
      await db.update(scheduledMessages).set({ afterDoneAt: m.afterDoneAt })
        .where(and(eq(scheduledMessages.id, m.id), isNull(scheduledMessages.afterDoneAt)));
    }
    const { publishPendingMessages } = await import("./pending-messages.js");
    for (const taskId of new Set(gated.filter((m) => latch.includes(m.id)).map((m) => m.taskId))) {
      publishPendingMessages(taskId);
    }
  }
  return gated;
}

async function pendingAfter(afterTaskId: string) {
  return db.select().from(scheduledMessages).where(and(
    eq(scheduledMessages.afterTaskId, afterTaskId),
    eq(scheduledMessages.mode, "after"),
    eq(scheduledMessages.status, "pending"),
  ));
}

/** 把等 `afterTaskId` 的消息里已经等到的锁存下来。前置任务被删之前调:删了就查不到 done_seq 了。 */
export async function latchAfterTask(afterTaskId: string): Promise<void> {
  await withAfterGates(await pendingAfter(afterTaskId));
}

/**
 * 前置任务刚落到终态(status.ts 的终态钩子调):先按完成计数锁存等到的那几条,再把**等着它的
 * 那些消息所在的任务**各扫一遍。只靠 30s tick 的话,用户会对着一条已经该发的消息干等最多半分钟。
 * 这一步迟到、没跑成都不影响对错 —— 事件已经跟状态同一笔落在 done_seq 上,扫描照样判得出来。
 */
export async function flushPendingAfterTask(taskId: string): Promise<void> {
  const waiting = await pendingAfter(taskId);
  if (!waiting.length) return;
  await withAfterGates(waiting);
  const { flushPendingForTask, publishPendingMessages } = await import("./pending-messages.js");
  for (const receiver of new Set(waiting.map((m) => m.taskId))) {
    // 托盘里那一行的「在等什么」跟着前置任务变了(完成/失败),让它重拉一次。
    publishPendingMessages(receiver);
    flushPendingForTask(receiver);
  }
}
