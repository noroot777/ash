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
//
// **一条铁律:`sent` 只在原话真的进了会话之后才写。** 反过来说,库里还是 pending 的消息
// 一定还在托盘里等着 —— 无论是被锁挡着、还是进程刚被重启掐掉。它同时从托盘和时间线上
// 消失 = 用户那句话凭空蒸发,连「我发过」都无从证明(2026-08-07 事故,见
// docs/incidents.md「排队消息凭空消失」)。做法是把「有人正在送」拆成一个**独立的租约字段**
// (`delivering_since`,行本身仍是 pending),而不是提前把状态改成 sent。
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import type { AgentType, ScheduledMessageMode } from "@harness/shared";
import { db } from "./db/index.js";
import { scheduledMessages, tasks } from "./db/schema.js";
import { continueTask } from "./orchestrator.js";
import { whenTurnIdle } from "./runs.js";
import { appendTaskTimeline } from "./task-timeline.js";
import { id, now } from "./util.js";

type Row = typeof scheduledMessages.$inferSelect;

// 落一条待发送消息(排队/定时同一张表,见文件头)。**入队的单点**:`/reply` 的正常
// 排队路径、以及「立刻发却被单飞锁挡回」的兜底都走它,免得两处各拼一份 row。
export async function enqueueMessage(input: {
  taskId: string;
  text: string;
  attachments?: string[];
  agent?: AgentType | null;
  executorId?: string | null;
  model?: string | null;
  reasoningEffort?: string | null;
  mode?: ScheduledMessageMode;
  // 排队消息不看钟点,sendAt 只用来排先后,所以默认取此刻。
  sendAt?: Date;
}): Promise<Row> {
  const row = {
    id: id(),
    taskId: input.taskId,
    text: input.text,
    attachments: JSON.stringify(input.attachments ?? []),
    agent: input.agent ?? null,
    executorId: input.executorId ?? null,
    model: input.model ?? null,
    reasoningEffort: input.reasoningEffort ?? null,
    mode: input.mode ?? ("queued" satisfies ScheduledMessageMode),
    sendAt: (input.sendAt ?? new Date()).toISOString(),
    status: "pending" as const,
    createdAt: now(),
    sentAt: null,
    deliveringSince: null,
  };
  await db.insert(scheduledMessages).values(row);
  return row;
}

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

// 已经排上、正在等这个任务当前那一轮退干净的投递。冷却窗口(5s)只够盖住
// continueTask 内部那道缝,盖不住「等一轮跑完」。这段时间里同一任务的第二条消息
// 绝不能也被排上,否则两条会挤在一起争同一个回合。
//
// 注意它只是**同进程内的去重**,不是「已认领」的标记 —— 等待期间那一行必须仍是
// pending(见 deliverWhenIdle):进程随时可能被重启掐掉,内存里的等待回调会一起
// 消失,行要是那时已经是 sent 就再也没人管它了。
const inFlight = new Set<string>();

// 抢下之后最终没能送出去:把租约还回去(托盘里它压根没消失过),下一次触发再送。
// **宁可晚发,不能不发。**
async function abortDelivery(message: Row): Promise<void> {
  lastFiredAt.delete(message.taskId);
  await db
    .update(scheduledMessages)
    .set({ deliveringSince: null })
    .where(and(eq(scheduledMessages.id, message.id), eq(scheduledMessages.status, "pending")));
}

export async function cancelPendingMessage(message: Row, reason: string): Promise<void> {
  await db
    .update(scheduledMessages)
    .set({ status: "canceled", sentAt: null, deliveringSince: null })
    .where(eq(scheduledMessages.id, message.id));
  const label = message.mode === "queued" ? "排队消息" : "定时消息";
  const when = message.mode === "queued" ? "" : `（原定 ${message.sendAt}）`;
  // 原文必须一起留下:这条消息取消之后就从托盘里消失了,不把用户打的字抄进时间线,
  // 他就只能凭记忆重打一遍。截断只为不撑爆时间线,够认出是哪句话即可。
  const text = message.text.trim();
  const quoted = text ? `\n原文：${text.length > 500 ? `${text.slice(0, 500)}…` : text}` : "";
  const note = `〔系统〕${label}未发送，已取消${when}：${reason}${quoted}`;
  if (!(await appendTaskTimeline(message.taskId, note))) {
    console.warn(`[harness] ${note} task=${message.taskId} message=${message.id}`);
  }
}

// ── 投递租约 ──────────────────────────────────────────────────────────────────
// 「抢下这条消息」和「这条消息已经送到」是**两件事**,必须分开记:
//   beginDelivery: pending 且没人占 → 打上租约(行还是 pending,托盘照常显示)
//   markSent:      原话真的落进会话之后才写 sent —— 这是唯一写 sent 的地方
//   abortDelivery: 没送成,把租约还回去,行原样留在 pending
// 原来这两件事合成一步(直接 pending → sent),于是「已认领、还没送到」这个当口就是
// 一个消息会凭空消失的窗口:锁挡回、进程被重启掐掉,行都已经是 sent 了,补发扫描
// (只查 pending)再也看不见它。

// 抢占一条消息必须是原子的,否则两个触发源会把同一条发两遍(WHERE 里带 status='pending'
// 且租约为空,谁的 UPDATE 真改到行谁就赢)。
//
// 导出是给崩溃测试用的:`test-scheduled-messages.ts` 的子进程拿它抢下租约后立刻 SIGKILL
// 自己,好让「另一个进程死在投递中途」这个现场由**真实路径本身**造出来,而不是测试手写
// 一行假状态。投递逻辑之外不要调它。
export async function beginDelivery(messageId: string): Promise<boolean> {
  const claimed = await db
    .update(scheduledMessages)
    .set({ deliveringSince: now() })
    .where(
      and(
        eq(scheduledMessages.id, messageId),
        eq(scheduledMessages.status, "pending"),
        isNull(scheduledMessages.deliveringSince),
      ),
    )
    .returning({ id: scheduledMessages.id });
  return claimed.length > 0;
}

// 原话已经进会话了,这才落 sent。用 status='pending' 兜一道:等待期间用户手动取消过的
// 消息不该被这一步复活。
async function markSent(messageId: string): Promise<void> {
  await db
    .update(scheduledMessages)
    .set({ status: "sent", sentAt: now(), deliveringSince: null })
    .where(and(eq(scheduledMessages.id, messageId), eq(scheduledMessages.status, "pending")));
}

// 开机时清空所有租约(startScheduler 在第一次 tick 之前调)。**不需要超时启发式**:
// 租约是内存态的持久投影,进程一换,上一轮所有「正在送」的回调就都不存在了 ——
// 按定义此刻没有任何投递在进行中,全清即可,那些消息回到待发送、这一次 tick 就补上。
// 唯一的代价方向是安全的那一边:万一进程死在「原话已落盘、sent 还没写」的毫秒缝里,
// 结果是**重发一次**,而不是丢一句话。
export async function reclaimStaleDeliveries(): Promise<number> {
  const reclaimed = await db
    .update(scheduledMessages)
    .set({ deliveringSince: null })
    .where(and(eq(scheduledMessages.status, "pending"), isNotNull(scheduledMessages.deliveringSince)))
    .returning({ id: scheduledMessages.id });
  if (reclaimed.length) console.log(`[harness] 回收 ${reclaimed.length} 条中断的待发送消息投递`);
  return reclaimed.length;
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

// 单任务的实际投递:在**当前这一轮退干净之后**才跑(由 whenTurnIdle 排空)。
//
// 三个状态迁移各自对应一件真事,别再合并:
//   beginDelivery  = 我来送这条(行仍是 pending,重启/崩溃后开机自动回收重投)
//   onDelivered    = 原话进会话了 → markSent(唯一写 sent 的地方)
//   落空 / 出错     = abortDelivery 把租约还回去,消息留在托盘里等下一次
async function deliverWhenIdle(message: Row, options: ReturnType<typeof deliveryOptions>): Promise<void> {
  let delivered = false;
  try {
    // 等待期间它还是 pending,所以用户可能已经手动取消、另一个触发源也可能抢先
    // 送掉了。抢不到租约就什么都不做。
    if (!(await beginDelivery(message.id))) return;
    lastFiredAt.set(message.taskId, Date.now());
    // 排空的一瞬间被别的路径抢走了回合(队列推进、用户手点运行):这一句一个字都
    // 没送出去,退回队列等下一次触发。
    const started = await continueTask(message.taskId, message.text, {
      ...options,
      onDelivered: async () => {
        delivered = true;
        await markSent(message.id);
      },
    });
    if (!started) await abortDelivery(message);
  } catch (error) {
    // 已经送进会话之后才炸的(agent 半路挂了),那是这一轮运行的事故,不是消息没送到:
    // 消息保持 sent,绝不能再把原文抄进时间线冒充「未发送」。
    if (delivered) return;
    const detail = error instanceof Error ? error.message : String(error);
    await cancelPendingMessage(message, `续跑失败：${detail}`).catch(() => {});
  } finally {
    inFlight.delete(message.taskId);
  }
}

// 投递一批待发送消息。taskId 非空 = 只看这个任务(终态钩子用);为空 = 全表扫一遍
// (tick 用)。同一个任务一次只发一条——发完它就又在跑了,剩下的继续排着。
export async function deliverPendingMessages(taskId?: string): Promise<void> {
  const at = new Date();
  // 带租约的行 = 本进程另一条路径正在送它,跳过(开机时 reclaimStaleDeliveries 已经把
  // 上一个进程留下的租约全清了,所以这里看到的租约一定是活的)。
  const all = await db
    .select()
    .from(scheduledMessages)
    .where(and(eq(scheduledMessages.status, "pending"), isNull(scheduledMessages.deliveringSince)));
  const pending = (taskId ? all.filter((m) => m.taskId === taskId) : all)
    .sort((a, b) => a.sendAt.localeCompare(b.sendAt)); // 排队消息的 sendAt=入队时刻,天然是先来后到
  const fired = new Set<string>(); // 每个任务每轮至多投递一条
  for (const m of pending) {
    try {
      if (fired.has(m.taskId) || inFlight.has(m.taskId) || cooling(m.taskId, at.getTime())) continue;
      const t = (await db.select().from(tasks).where(eq(tasks.id, m.taskId))).at(0) ?? null;
      const verdict = deliveryVerdict(m, t, at);
      if (verdict.action === "wait") continue;
      if (verdict.action === "cancel") {
        await cancelPendingMessage(m, verdict.reason);
        continue;
      }
      const options = deliveryOptions(m);
      if (t!.mode === "team") {
        if (!(await beginDelivery(m.id))) continue; // 另一个触发源刚抢走
        fired.add(m.taskId);
        lastFiredAt.set(m.taskId, Date.now());
        let delivered = false;
        try {
          const started = await continueTask(m.taskId, m.text, {
            ...options,
            throwOnTeamUnavailable: true,
            onDelivered: async () => {
              delivered = true;
              await markSent(m.id);
            },
          });
          if (!started) await abortDelivery(m); // 理论上团队路径不会被挡回,租约也不留悬
        } catch (reason) {
          if (delivered) throw reason; // 已经进调度台了,不是「未发送」,交给外层日志
          const detail = reason instanceof Error ? reason.message : String(reason);
          await cancelPendingMessage(m, `调度台不可用：${detail}`);
        }
      } else {
        // 单任务必须等它**当前这一轮退干净**再送。两个触发源里的终态钩子
        // (setTaskStatus → flushPendingForTask)是在 run loop 的 try 里调的,那一刻
        // 单飞锁还锁着;直接 continueTask 会被静默挡回,消息就此蒸发。`whenTurnIdle`
        // 由 releaseTurn 同一处排空,是结算钩子里给同一个任务续跑的唯一安全写法。
        fired.add(m.taskId);
        inFlight.add(m.taskId);
        whenTurnIdle(m.taskId, () => void deliverWhenIdle(m, options));
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
