// ── 待发送消息(scheduled_messages)的投递 ─────────────────────────────────────
// 两种 mode 共用这一条链路,区别只有「什么时候算到期」:
//   • timed  = 定时发送:到了 sendAt 那个时刻才发
//   • queued = 排队追问:不看时间,任务一空下来就发(运行中还想补一句时用)
// 其余(附件、@指派的执行器/模型/思考强度、取消、托盘展示)完全一样,所以它们是
// 同一张表的两个 mode,而不是两套机制。
//
// 投递有两个触发源,都走这里:
//   ① scheduler 的 30s tick(schedules.ts)——定时消息的正常到期路径,也是兜底
//   ② 任务落终态时的钩子(status.ts)——排队消息的正常路径,做到「跑完立刻发出」,
//      不让用户对着一条已经该发的消息干等最多 30 秒
// 于是「排队」不需要第二套定时器:它就是一条永远已到期、但要等任务空闲的消息。
import { and, eq } from "drizzle-orm";
import type { AgentType } from "@harness/shared";
import { db } from "./db/index.js";
import { scheduledMessages, tasks } from "./db/schema.js";
import { continueTask } from "./orchestrator.js";
import { appendTaskTimeline } from "./task-timeline.js";
import { now } from "./util.js";

type Row = typeof scheduledMessages.$inferSelect;

// 判定所需的最小任务形状,写成结构类型,单测就能直接喂字面量。
export type DeliveryTaskView = { mode: string | null; status: string; archived: boolean };
export type DeliveryMessageView = { mode: string; sendAt: string };
export type DeliveryVerdict =
  | { action: "deliver" }
  | { action: "wait" }
  | { action: "cancel"; reason: string };

// 投递判定的纯函数核心(单测 server/scripts/test-pending-messages.ts)。
// 三档:发、等、取消。取消只给「永远等不到了」的情形——任务没了/归档/类型不支持
// 回复;「任务在忙」永远是等,不是取消。
export function deliveryVerdict(
  message: DeliveryMessageView,
  task: DeliveryTaskView | null,
  at: Date,
): DeliveryVerdict {
  if (!task) return { action: "cancel", reason: "任务不存在" };
  if (task.archived) return { action: "cancel", reason: "任务已归档" };
  if (task.mode !== "single" && task.mode !== "team")
    return { action: "cancel", reason: `任务类型 ${task.mode} 不支持回复` };
  // 定时消息先看钟点;排队消息压根不看(它要的就是「一空闲就发」)。
  if (message.mode !== "queued" && new Date(message.sendAt) > at) return { action: "wait" };
  // 常驻调度台(team)正在说话时也接得住,所以只有单任务需要等它闲下来。
  if (task.mode === "single" && (task.status === "running" || task.status === "queued"))
    return { action: "wait" };
  return { action: "deliver" };
}

// 一次投递之后的冷却:continueTask 对单任务是「先同步占住内存锁,再异步把状态
// 改成 running」,中间那一小段里任务读出来还是空闲的。两个触发源(tick 与终态
// 钩子)如果恰好挤在这道缝里,第二条消息会被标成 sent 却被 continueTask 的单飞
// 锁直接丢掉——消息就凭空消失了。所以同一任务刚发过就先按住,下一次触发再说。
const FIRE_COOLDOWN_MS = 5_000;
const lastFiredAt = new Map<string, number>();

function cooling(taskId: string, at: number): boolean {
  const last = lastFiredAt.get(taskId);
  return last != null && at - last < FIRE_COOLDOWN_MS;
}

export async function cancelPendingMessage(message: Row, reason: string): Promise<void> {
  await db
    .update(scheduledMessages)
    .set({ status: "canceled", sentAt: null })
    .where(eq(scheduledMessages.id, message.id));
  const label = message.mode === "queued" ? "排队消息" : "定时消息";
  const when = message.mode === "queued" ? "" : `（原定 ${message.sendAt}）`;
  const note = `〔系统〕${label}未发送，已取消${when}：${reason}`;
  if (!(await appendTaskTimeline(message.taskId, note))) {
    console.warn(`[harness] ${note} task=${message.taskId} message=${message.id}`);
  }
}

// 抢占一条消息:pending → sent 必须是原子的,否则两个触发源会把同一条发两遍。
// 抢到才返回 true(WHERE 里带 status='pending',谁的 UPDATE 真改到行谁就赢)。
async function claim(messageId: string): Promise<boolean> {
  const claimed = await db
    .update(scheduledMessages)
    .set({ status: "sent", sentAt: now() })
    .where(and(eq(scheduledMessages.id, messageId), eq(scheduledMessages.status, "pending")))
    .returning({ id: scheduledMessages.id });
  return claimed.length > 0;
}

function deliveryOptions(m: Row) {
  return {
    attachments: JSON.parse(m.attachments) as string[],
    agent: (m.agent as AgentType) ?? undefined,
    // 要跑的还是用户当时选的那一套执行器/模型/思考强度（没选就是 null=按默认解析）。
    executorId: m.executorId ?? null,
    model: m.model ?? null,
    reasoningEffort: m.reasoningEffort ?? null,
  };
}

// 投递一批待发送消息。taskId 非空 = 只看这个任务(终态钩子用);为空 = 全表扫一遍
// (tick 用)。同一个任务一次只发一条——发完它就又在跑了,剩下的继续排着。
export async function deliverPendingMessages(taskId?: string): Promise<void> {
  const at = new Date();
  const all = await db.select().from(scheduledMessages).where(eq(scheduledMessages.status, "pending"));
  const pending = (taskId ? all.filter((m) => m.taskId === taskId) : all)
    .sort((a, b) => a.sendAt.localeCompare(b.sendAt)); // 排队消息的 sendAt=入队时刻,天然是先来后到
  const fired = new Set<string>(); // 每个任务每轮至多投递一条
  for (const m of pending) {
    try {
      if (fired.has(m.taskId) || cooling(m.taskId, at.getTime())) continue;
      const t = (await db.select().from(tasks).where(eq(tasks.id, m.taskId))).at(0) ?? null;
      const verdict = deliveryVerdict(m, t, at);
      if (verdict.action === "wait") continue;
      if (verdict.action === "cancel") {
        await cancelPendingMessage(m, verdict.reason);
        continue;
      }
      if (!(await claim(m.id))) continue; // 另一个触发源刚抢走
      fired.add(m.taskId);
      lastFiredAt.set(m.taskId, Date.now());
      const options = deliveryOptions(m);
      if (t!.mode === "team") {
        try {
          await continueTask(m.taskId, m.text, { ...options, throwOnTeamUnavailable: true });
        } catch (reason) {
          const detail = reason instanceof Error ? reason.message : String(reason);
          await cancelPendingMessage(m, `调度台不可用：${detail}`);
        }
      } else {
        void continueTask(m.taskId, m.text, options);
      }
    } catch {
      /* 一条投递失败不影响其它任务,下一轮再来 */
    }
  }
}

// 任务刚落到「不在跑」的状态时叫一次(status.ts 的钩子)。排队消息靠它做到
// 「上一轮一结束就发出去」,而不是干等下一次 30s tick。
export function flushPendingForTask(taskId: string): void {
  void deliverPendingMessages(taskId).catch((err) =>
    console.error(`[harness] deliverPendingMessages(${taskId}) failed:`, err),
  );
}
