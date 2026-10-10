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
// **②被挡回时不许退回去等①。** 投递有一串「一个字都没送出去」的出口(回合被抢占、
// 验收互斥、调度台拒收),它们原本既不出声也不重排,结果就是消息静静躺在托盘里等那个
// 30 秒 tick —— 用户看到的是「任务都跑完了,我那句话还挂着」,日志里却什么都没有。
// 现在这些出口一律 `scheduleRedelivery`:记一条带原因的 warn,并按 200ms/1s/3s 退避
// 自己重投,试完才把兜底交还给 tick;验收锁这类「明确知道什么时候放开」的占用,则在放开
// 时直接推一把(acceptance-lock.ts)。计时同理从**第一次判定该发**起算(`dueSince`),
// 并把「任务又忙起来」的那几段单独扣出来(`busyAgain`)——否则被挡回的十几秒永远算不进
// 任何一段,而一段正常运行又会被读成「空闲却没投递」。
//
// **一条铁律:`sent` 只在原话真的进了会话之后才写。** 反过来说,库里还是 pending 的消息
// 一定还在托盘里等着 —— 无论是被锁挡着、还是进程刚被重启掐掉。它同时从托盘和时间线上
// 消失 = 用户那句话凭空蒸发,连「我发过」都无从证明(2026-08-07 事故,见
// docs/incidents.md「排队消息凭空消失」)。做法是把「有人正在送」拆成一个**独立的租约字段**
// (`delivering_since`,行本身仍是 pending),而不是提前把状态改成 sent。
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import type { AgentType, ScheduledMessageMode } from "@ash/shared";
import { bus } from "./bus.js";
import { db, dbClient } from "./db/index.js";
import { scheduledMessages, tasks, groups, queueItems } from "./db/schema.js";
import { setTaskStatus } from "./status.js";
import { continueTask } from "./orchestrator.js";
import { queueBlockers } from "./queues.js";
import { isTurnClaimed, whenTurnIdle } from "./runs.js";
import { forgetTiming, markDue, noteBusyAgain, noteDeliveryTiming, secs, settleBusyAgain, waitedFor } from "./pending-delivery-timing.js";
import { appendTaskTimeline } from "./task-timeline.js";
import { bindUploadsToTask } from "./uploads.js";
import { id, now } from "./util.js";

type Row = typeof scheduledMessages.$inferSelect;

// 托盘变了就吱一声(入队 / 真的发出去 / 取消)。**每一处改动 status 的地方都得叫它**:
// 前端托盘不该再从任务状态跃迁里反推自己该不该少一行 —— 排队消息发出去的那一瞬间
// 任务立刻又回到 running,那个空档前端常常一次都观察不到,托盘就会挂着一条早已进了
// 会话的「排队中」。租约变化(deliveringSince)不用发:行还是 pending,托盘不变。
export function publishPendingMessages(taskId: string): void {
  bus.publish({ type: "task.pendingMessages", taskId });
}

// 落一条待发送消息(排队/定时同一张表,见文件头)。**入队的单点**:`/reply` 的正常
// 排队路径、以及「立刻发却被单飞锁挡回」的兜底都走它,免得两处各拼一份 row。
export function pendingMessageRow(input: {
  taskId: string;
  text: string;
  attachments?: string[];
  agent?: AgentType | null;
  executorId?: string | null;
  model?: string | null;
  reasoningEffort?: string | null;
  sessionRole?: string | null;
  /** 谁发的这条(多人模式);投递时按它解析执行器与 CLI 环境。 */
  ownerUserId?: string | null;
  mode?: ScheduledMessageMode;
  /** 执行意图:排队等轮次时暂存的回复(投递 = 任务的执行回合,见 schema 注释)。 */
  execution?: boolean;
  // 排队消息不看钟点,sendAt 只用来排先后,所以默认取此刻。
  sendAt?: Date;
}): Row {
  return {
    id: id(),
    taskId: input.taskId,
    text: input.text,
    attachments: JSON.stringify(input.attachments ?? []),
    agent: input.agent ?? null,
    executorId: input.executorId ?? null,
    model: input.model ?? null,
    reasoningEffort: input.reasoningEffort ?? null,
    sessionRole: input.sessionRole ?? null,
    ownerUserId: input.ownerUserId ?? null,
    mode: input.mode ?? ("queued" satisfies ScheduledMessageMode),
    execution: input.execution ?? false,
    sendAt: (input.sendAt ?? new Date()).toISOString(),
    status: "pending" as const,
    createdAt: now(),
    sentAt: null,
    deliveringSince: null,
  };
}

export async function enqueueMessage(input: Parameters<typeof pendingMessageRow>[0]): Promise<Row> {
  const row = pendingMessageRow(input);
  await db.insert(scheduledMessages).values(row);
  // 附件在**入队这一刻**挂到任务上(uploads.ts):这里才知道是谁发的,投递时那条路
  // 是后端触发的、没有发起人,认不出「这个文件本来就是我的」。
  await bindUploadsToTask(input.attachments, row.taskId, row.ownerUserId);
  publishPendingMessages(row.taskId);
  return row;
}

// 判定所需的最小任务形状,写成结构类型,单测就能直接喂字面量。
// queueBlocked = 这个任务在队列里且还没轮到(queueBlockers 非空)。只对 paused/
// backlog 生效:对它们投递 = 开启真实执行回合,必须守「同队至多一个在跑」;终态
// 任务的投递是续聊旁路(followUpFrom),队列按原终态看待,不受队列挡(审查:
// 「保留已完成任务正常续聊的语义」)。
export type DeliveryTaskView = {
  mode: string | null;
  status: string;
  archived: boolean;
  queueBlocked?: boolean;
  /** 所在分组已被用户暂停(groups.paused,持久事实)。 */
  groupPaused?: boolean;
};
export type DeliveryMessageView = { mode: string; sendAt: string; execution?: boolean };
export type DeliveryVerdict =
  | { action: "deliver" }
  | { action: "wait" }
  | { action: "cancel"; reason: string };

// 「这条消息到点了没」的单点判据:定时消息看钟点,排队消息压根不看(它要的就是
// 「一空闲就发」)。抽出来是因为结算那边也要问同一句话(hasDeliverablePendingMessages),
// 各写一份迟早漂移——真漂了的后果是一条定在明天的消息把预约审查挡一整天。
export function isDueForDelivery(message: DeliveryMessageView, at: Date): boolean {
  return message.mode === "queued" || new Date(message.sendAt) <= at;
}

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
  if (!isDueForDelivery(message, at)) return { action: "wait" };
  // 常驻调度台(team)正在说话时也接得住,所以只有单任务需要等它闲下来。
  if (task.mode === "single" && (task.status === "running" || task.status === "queued"))
    return { action: "wait" };
  // 排队没轮到的 paused/backlog:投递会 continueTask 开真实执行回合,等让位
  // (第 xNb655YqYzcA 链第 2 轮:reply 只在入口暂存不够,30s tick 会从这里穿透)。
  if (
    task.mode === "single" &&
    (task.status === "paused" || task.status === "backlog") &&
    task.queueBlocked
  )
    return { action: "wait" };
  // 执行型消息(排队等轮次时暂存的回复,execution=1):它的投递**就是任务的执行回合**,
  // 不论任务此刻处于什么状态都要守两件事 —— 整队至多一个在跑、分组暂停。关键是失败
  // 重试:起跑失败后任务落 failed,上面按状态的检查管不到它,丢了这条就会借终态续聊
  // 的豁免并行执行 / 穿透暂停(第 5 轮审查两条拦验收)。真正的终态续聊(execution=0)
  // 不受影响。
  if (task.mode === "single" && message.execution && (task.queueBlocked || task.groupPaused))
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

// ── 挡回之后的主动重投 ───────────────────────────────────────────────────────
// 一次投递可能**一个字都没送出去就被挡回**:`continueTask` 抢不到单飞锁(排空的
// 一瞬间被队列推进/审查/用户手点抢了回合)、或撞上验收互斥,一律返回 false。老实现
// 到这里只是 `abortDelivery` 把消息放回托盘,**不留任何痕迹、也不安排下一次** ——
// 于是它只能等 scheduler 那个 30 秒 tick 来捡。用户看到的是「任务都显示跑完了,我
// 那句话还挂在托盘里」干等十几秒,而日志一声不吭:2026-09-29 那版分段计时挂在
// `onDelivered` 上,只有**送成功**才计时,这条失败分支天生在它的盲区里
// (2026-09-30 现场:回合 12:57:26.503 结束、消息 12:57:43.162 才进会话,共 16.7 秒,
// 而「投递偏慢」一条都没打 —— 因为送成的那一次确实只花了 1 秒出头,前面 16 秒是
// 挡回之后的空等)。
//
// 所以挡回后按退避自己再试几次,试完才把兜底交还给 tick。重试延迟要短:挡回的
// 典型病因是「释放点上的一瞬间竞争」,对方那一轮往往几百毫秒就交接完了。
const REDELIVERY_DELAYS_MS = [200, 1_000, 3_000];
// 退避用完之后交给 30s 兜底扫描 —— 这个「30s」必须自己记账:失败结算钩子、队列唤醒、
// 终态 flush 都会再触发扫描,不记下一次允许重试的时刻,它们就会绕过退避,形成
// 「失败→结算唤醒→再失败」的自激循环(第 6 轮审查:目录不修复时 2 秒 24 次失败)。
const RETRY_BACKSTOP_MS = 30_000;
const redeliveryAttempts = new Map<string, number>();
const redeliveryTimers = new Map<string, NodeJS.Timeout>();
// 这条消息下一次允许真实投递的时刻。**所有触发源**(tick、结算钩子、队列唤醒、重投
// 定时器唤起的扫描)统一在扫描循环里查它;只有用户显式动作(手动运行/重试走
// handDuePendingMessageToRun)不受约束 —— 人按下按钮就是「现在再试一次」。
const nextRetryAt = new Map<string, number>();

function retryBlocked(messageId: string, at: number): boolean {
  return (nextRetryAt.get(messageId) ?? 0) > at;
}

function forgetDeliveryBookkeeping(messageId: string): void {
  redeliveryAttempts.delete(messageId);
  forgetTiming(messageId);
  nextRetryAt.delete(messageId);
  const timer = redeliveryTimers.get(messageId);
  if (timer) {
    clearTimeout(timer);
    redeliveryTimers.delete(messageId);
  }
}

// 挡回一次 = 记一笔账 + 排一次重投。`why` 写进日志,是这条链路上唯一能事后归因的东西。
function scheduleRedelivery(message: Row, why: string): void {
  const waited = waitedFor(message.id);
  const attempt = redeliveryAttempts.get(message.id) ?? 0;
  if (attempt >= REDELIVERY_DELAYS_MS.length) {
    // 退避用完也要把「下一次」写下来,否则这句「交给 30s 兜底」只是日志修辞:
    // 结算钩子触发的扫描照样立刻取走它再撞一次。
    nextRetryAt.set(message.id, Date.now() + RETRY_BACKSTOP_MS);
    console.warn(
      `[ash] 排队消息连挡 ${attempt} 次仍没送成 task=${message.taskId} message=${message.id}`
      + `（${why};已等 ${secs(waited)}）—— 交给 30s 兜底扫描`,
    );
    return;
  }
  const delay = REDELIVERY_DELAYS_MS[attempt]!;
  redeliveryAttempts.set(message.id, attempt + 1);
  nextRetryAt.set(message.id, Date.now() + delay);
  console.warn(
    `[ash] 排队消息这一次没送成 task=${message.taskId} message=${message.id}`
    + `（${why};已等 ${secs(waited)}）—— ${delay}ms 后重投（第 ${attempt + 1} 次）`,
  );
  const prev = redeliveryTimers.get(message.id);
  if (prev) clearTimeout(prev);
  const timer = setTimeout(() => {
    redeliveryTimers.delete(message.id);
    void deliverPendingMessages(message.taskId).catch((err) => {
      if (dbClient.closed) return; // 同上:进程收尾时被掐,不是投递故障
      console.error(`[ash] 排队消息重投失败 task=${message.taskId}:`, err);
    });
  }, delay);
  timer.unref?.();
  redeliveryTimers.set(message.id, timer);
}

// 抢下之后最终没能送出去:把租约还回去(托盘里它压根没消失过),下一次触发再送。
// **宁可晚发,不能不发。**
export async function abortDelivery(message: Row): Promise<void> {
  lastFiredAt.delete(message.taskId);
  await db
    .update(scheduledMessages)
    .set({ deliveringSince: null })
    .where(and(eq(scheduledMessages.id, message.id), eq(scheduledMessages.status, "pending")));
}

export async function cancelPendingMessage(message: Row, reason: string): Promise<void> {
  forgetDeliveryBookkeeping(message.id);
  await db
    .update(scheduledMessages)
    .set({ status: "canceled", sentAt: null, deliveringSince: null })
    .where(eq(scheduledMessages.id, message.id));
  publishPendingMessages(message.taskId);
  const label = message.mode === "queued" ? "排队消息" : "定时消息";
  const when = message.mode === "queued" ? "" : `（原定 ${message.sendAt}）`;
  // 原文必须一起留下:这条消息取消之后就从托盘里消失了,不把用户打的字抄进时间线,
  // 他就只能凭记忆重打一遍。截断只为不撑爆时间线,够认出是哪句话即可。
  const text = message.text.trim();
  const quoted = text ? `\n原文：${text.length > 500 ? `${text.slice(0, 500)}…` : text}` : "";
  const note = `〔系统〕${label}未发送，已取消${when}：${reason}${quoted}`;
  if (!(await appendTaskTimeline(message.taskId, note))) {
    console.warn(`[ash] ${note} task=${message.taskId} message=${message.id}`);
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
export async function markSent(message: Row): Promise<void> {
  forgetDeliveryBookkeeping(message.id);
  await db
    .update(scheduledMessages)
    .set({ status: "sent", sentAt: now(), deliveringSince: null })
    .where(and(eq(scheduledMessages.id, message.id), eq(scheduledMessages.status, "pending")));
  publishPendingMessages(message.taskId);
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
  if (reclaimed.length) console.log(`[ash] 回收 ${reclaimed.length} 条中断的待发送消息投递`);
  return reclaimed.length;
}

export function deliveryOptions(m: Row) {
  return {
    attachments: JSON.parse(m.attachments) as string[],
    agent: (m.agent as AgentType) ?? undefined,
    // 要跑的还是用户当时选的那一套执行器/模型/思考强度（没选就是 null=按默认解析）。
    executorId: m.executorId ?? null,
    model: m.model ?? null,
    reasoningEffort: m.reasoningEffort ?? null,
    ...(m.sessionRole ? { sessionRole: m.sessionRole as "single" | "reviewer" } : {}),
    // 排队/定时消息落地时,烧的仍是**当时排队那个人**的 key,不退回任务归属人。
    ...(m.ownerUserId ? { actingUserId: m.ownerUserId } : {}),
    // 执行型消息的意图跟着行走,重投也不丢(第 5 轮审查:首次交接传了 executionTurn,
    // 失败后经扫描重投却按终态续聊启动,绕过整队守卫)。freezeGuard 让 spawn 前再核一次
    // 分组暂停/删除归档的持久事实 —— 自动投递离 spawn 很远,中途用户可能刚按下暂停。
    ...(m.execution ? { executionTurn: true, freezeGuard: true } : {}),
  };
}

// 单任务的实际投递:在**当前这一轮退干净之后**才跑(由 whenTurnIdle 排空)。
//
// 三个状态迁移各自对应一件真事,别再合并:
//   beginDelivery  = 我来送这条(行仍是 pending,重启/崩溃后开机自动回收重投)
//   onDelivered    = 原话进会话了 → markSent(唯一写 sent 的地方)
//   落空 / 出错     = abortDelivery 把租约还回去,消息留在托盘里等下一次
//
// **每一条不是「送成了」的出口都要出声**(scheduleRedelivery / console.warn):它们
// 原本一个字都不记,于是「消息在托盘里多挂了十几秒」这件事在日志里根本不存在。
async function deliverWhenIdle(
  message: Row,
  options: ReturnType<typeof deliveryOptions>,
  spans: { dueAt: number; busyMs: number; queuedAt: number },
  // 扫描侧为执行型消息落下的 queued 占位。正常路径由 continueTask 的结算覆盖;
  // 这里只负责「一个字都没送出去就散伙」的早退口。
  seat?: { prevStatus: string },
): Promise<void> {
  let delivered = false;
  const idleAt = Date.now();
  try {
    // 等待期间它还是 pending,所以用户可能已经手动取消、另一个触发源也可能抢先
    // 送掉了。抢不到租约就什么都不做 —— 送它的那一位会自己记账。
    if (!(await beginDelivery(message.id))) {
      // 占位是为这条消息落的;消息已经没了(取消/已送)就得把 status 退回去,否则
      // 任务永远卡在 queued。租约被**别的投递路径**抢走则交给 finally 的同一判据:
      // 那一位马上会开回合,running 自然覆盖占位;真没人接手才回滚。
      return;
    }
    lastFiredAt.set(message.taskId, Date.now());
    // 排空的一瞬间被别的路径抢走了回合(队列推进、用户手点运行):这一句一个字都
    // 没送出去,退回队列等下一次触发。
    const started = await continueTask(message.taskId, message.text, {
      ...options,
      onDelivered: async () => {
        delivered = true;
        const at = Date.now();
        await markSent(message);
        noteDeliveryTiming(message.taskId, { ...spans, idleAt, at });
      },
    });
    // started=true 也可能一个字没送出去:continueTask 把起跑异常(workspace/执行器
    // 解析)吸收在内部,结算 failed 后返回 true ——「已接管回合」≠「已送达」。唯一可信
    // 的送达信号是 onDelivered;没响就把租约还回去,原文留在托盘等重投(第 4 轮审查
    // 实测:项目目录暂不可用时起跑失败,租约滞留,恢复后重试/扫描全绕开这条消息)。
    if (!delivered) {
      await abortDelivery(message);
      scheduleRedelivery(message, started ? "回合起跑失败，原文退回待发送" : "回合被其它执行抢占或工作区正被验收占用");
    }
  } catch (error) {
    // 已经送进会话之后才炸的(agent 半路挂了),那是这一轮运行的事故,不是消息没送到:
    // 消息保持 sent,绝不能再把原文抄进时间线冒充「未发送」。
    if (delivered) return;
    const detail = error instanceof Error ? error.message : String(error);
    await cancelPendingMessage(message, `续跑失败：${detail}`).catch(() => {});
  } finally {
    inFlight.delete(message.taskId);
    // 占位落空的兜底:这一次没送达(租约被抢、消息被取消、回合被验收互斥挡回而
    // continueTask 没有结算)时,任务可能还停在扫描侧落的 queued 上。回合锁还被人
    // 占着(手动运行刚抢走这次启动)就不动 —— 那一位的结算会覆盖;锁空着才查状态
    // 回滚,否则把别人正要跑的任务翻回 failed,结算钩子会放行下一个成员,反而造出
    // 双跑。起跑失败/冻结撤回则由 continueTask 自己的结算覆盖,这里查到的已不是
    // queued,不动。
    if (seat && !delivered && !isTurnClaimed(message.taskId)) {
      try {
        const cur = (await db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, message.taskId))).at(0);
        if (cur?.status === "queued") await setTaskStatus(message.taskId, seat.prevStatus as Parameters<typeof setTaskStatus>[1]);
      } catch { /* 回滚失败只能留给重启 reconcile */ }
    }
  }
}

// 投递一批待发送消息。taskId 非空 = 只看这个任务(终态钩子用);为空 = 全表扫一遍
// (tick 用)。同一个任务一次只发一条——发完它就又在跑了,剩下的继续排着。
//
// **扫描串行化**:两次并发扫描各自读「整队无人在跑」再各自安排投递,就是第 6 轮审查
// 的双跑现场(两个失败成员恢复后一起执行)。决策与占位必须在同一条链上依次发生,
// 后一次扫描才能看见前一次刚落库的 queued 占位。链上任何一次失败都不许断链。
let scanChain: Promise<void> = Promise.resolve();
export function deliverPendingMessages(taskId?: string): Promise<void> {
  const next = scanChain.then(() => scanPendingMessages(taskId));
  scanChain = next.catch(() => undefined);
  return next;
}

async function scanPendingMessages(taskId?: string): Promise<void> {
  // 进程正在收尾(测试关库、server 退出)时直接收手。这条链路有好几个 fire-and-forget
  // 的触发源(验收锁放开那一推、重投定时器),关库之后它们照样会醒一次,然后刷一串
  // 「database is not open」的 stack trace —— 读到的人只会以为验收自己炸了。
  if (dbClient.closed) return;
  const at = new Date();
  // 带租约的行 = 本进程另一条路径正在送它,跳过(开机时 reclaimStaleDeliveries 已经把
  // 上一个进程留下的租约全清了,所以这里看到的租约一定是活的)。
  const all = await db
    .select()
    .from(scheduledMessages)
    .where(and(eq(scheduledMessages.status, "pending"), isNull(scheduledMessages.deliveringSince)));
  const pending = (taskId ? all.filter((m) => m.taskId === taskId) : all)
    .sort((a, b) => a.sendAt.localeCompare(b.sendAt)
      || a.createdAt.localeCompare(b.createdAt)
      || a.id.localeCompare(b.id));
  const fired = new Set<string>(); // 每个任务每轮至多投递一条
  for (const m of pending) {
    try {
      if (fired.has(m.taskId) || inFlight.has(m.taskId) || cooling(m.taskId, at.getTime())) continue;
      // 下一次允许重试的时刻没到就不碰:退避只写在重投定时器上管不住别的触发源 ——
      // 失败结算钩子、队列唤醒触发的扫描会绕过它,形成「失败→结算唤醒→再失败」的
      // 自激循环(第 6 轮审查:目录不修复时 2 秒 24 次失败)。
      if (retryBlocked(m.id, at.getTime())) continue;
      const t = (await db.select().from(tasks).where(eq(tasks.id, m.taskId))).at(0) ?? null;
      // paused/backlog 的单任务、以及执行型消息(不论任务状态)才需要问队列;执行型
      // 还要问分组暂停。其余状态别白查几张表。
      const needQueueCheck =
        t != null && t.mode === "single"
        && (m.execution || t.status === "paused" || t.status === "backlog");
      const queueBlocked = needQueueCheck ? (await queueBlockers(m.taskId)).length > 0 : false;
      const groupPaused =
        t != null && t.mode === "single" && m.execution && t.groupId
          ? !!(await db.select().from(groups).where(eq(groups.id, t.groupId))).at(0)?.paused
          : false;
      const verdict = deliveryVerdict(m, t ? { ...t, queueBlocked, groupPaused } : null, at);
      if (verdict.action === "wait") {
        // 已经判定过该发、这一轮又变回「等」= 任务重新忙起来了。计这一段,好把它从
        // 「挡回后空等」里扣掉(见 noteBusyAgain)。
        noteBusyAgain(m.id, at.getTime());
        continue;
      }
      if (verdict.action === "cancel") {
        await cancelPendingMessage(m, verdict.reason);
        continue;
      }
      const options = deliveryOptions(m);
      // 两个时间点,别合并:
      //   dueAt    = 这条消息**第一次**被判定该发的那一刻(markDue 只记第一次)。被挡回、
      //              几秒后重投、甚至被 30s 兜底扫描捡走,起点都还是它 —— 这才是用户
      //              盯着托盘干等的那段时间。
      //   queuedAt = 这一次投递尝试开始的时刻。两者之差 = 之前被挡回空等了多久。
      const queuedAt = Date.now();
      const dueAt = markDue(m.id, queuedAt);
      const busyMs = settleBusyAgain(m.id, queuedAt);
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
              const at = Date.now();
              await markSent(m);
              // 调度台是常驻的,没有「等回合退干净」这一段,所以两个时间点同一个值。
              noteDeliveryTiming(m.taskId, { dueAt, busyMs, queuedAt, idleAt: queuedAt, at });
            },
          });
          // 调度台明确拒收:清租约、保持 pending,下一台接手时补送。同样要出声并自己重投,
          // 否则一次拒收就要干等一整个 30s tick。
          if (!started) {
            await abortDelivery(m);
            scheduleRedelivery(m, "调度台此刻收不下（正在收尾或已离线）");
          }
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
        //
        // 执行型消息在安排投递前**先落 queued 占位**(与让位 setQueued、手动运行
        // claimQueuedPlacement 同一道占位边界):本轮扫描串行,后面的成员在各自的
        // queueBlockers 查询里立刻看见这个 queued,整队仍是「至多一个在跑」;不占位
        // 的话,两条失败成员的消息各自读到「无人在跑」就会并行启动(第 6 轮审查)。
        // 占位的回收路径:投递成功/失败都由 continueTask 的结算覆盖 status;唯一
        // 落空口(租约被抢/消息已取消)由 deliverWhenIdle 的早退分支按 seat 回滚。
        let seat: { prevStatus: string } | undefined;
        if (m.execution && (await db.select().from(queueItems).where(eq(queueItems.taskId, m.taskId))).length) {
          seat = { prevStatus: t!.status };
          await setTaskStatus(m.taskId, "queued");
        }
        fired.add(m.taskId);
        inFlight.add(m.taskId);
        whenTurnIdle(m.taskId, () => void deliverWhenIdle(m, options, { dueAt, busyMs, queuedAt }, seat));
      }
    } catch (error) {
      // 一条投递失败不影响其它任务,下一轮再来 —— 但**必须留下痕迹**:这里原来是空的
      // catch,于是「消息没送出去」和「根本没发生过」在日志里长得一模一样。
      if (!dbClient.closed) console.error(`[ash] 待发送消息投递出错 task=${m.taskId} message=${m.id}:`, error);
    }
  }
}

// 任务刚落到「不在跑」的状态时叫一次(status.ts 的钩子)。排队消息靠它做到
// 「上一轮一结束就发出去」,而不是干等下一次 30s tick。
export function flushPendingForTask(taskId: string): void {
  void deliverPendingMessages(taskId).catch((err) => {
    // 查到一半库被关了(进程收尾)不是故障:开头那道守卫挡不住这个竞态,而一串
    // 「database is not open」的 stack trace 会让人以为刚做完的那件事自己炸了。
    if (dbClient.closed) return;
    console.error(`[ash] deliverPendingMessages(${taskId}) failed:`, err);
  });
}

// 让位交接(第 xNb655YqYzcA 链第 3 轮):队列推进 / 手动运行 / 重试要拉起一个任务时,
// 如果它托盘里已有**到期**的待发送回复,这一回合的输入就该是那条回复本身 —— 先跑一轮
// 空泛「继续」,任务会按旧方向干完,回合结束后的补送替代不了启动前的交接(审查实测:
// P 排在 B 后、排队期间收到修改要求,B 让位后 P 被 RESUME_PROMPT 拉起,修改要求迟到
// 一整轮)。调用方(task-resume.ts)在选默认 RESUME_PROMPT / fresh 之前先问这里。
//
// 记账走投递链路同一套:beginDelivery 租约 → onDelivered 落 sent → 挡回 abort + 重投,
// 所以 tick / 终态钩子 / 重投定时器靠租约与 inFlight 去重,同一条不会发两遍。
// 返回 true = 这次启动已由消息交接接管(含「另一路已在送」与「挡回后已排重投」),
// 调用方不要再开别的回合;false = 没有可交接的消息,照常走默认输入。
export async function handDuePendingMessageToRun(
  taskId: string,
  opts: { turnHeld?: boolean; actingUserId?: string | null } = {},
): Promise<boolean> {
  if (dbClient.closed) return false;
  // 已有投递在途:它自己会开回合,这里再开默认「继续」就是同一任务两路起跑。
  if (inFlight.has(taskId)) return true;
  const at = new Date();
  const due = (await db
    .select()
    .from(scheduledMessages)
    .where(and(
      eq(scheduledMessages.taskId, taskId),
      eq(scheduledMessages.status, "pending"),
      isNull(scheduledMessages.deliveringSince),
    )))
    .filter((m) => isDueForDelivery(m, at))
    .sort((a, b) => a.sendAt.localeCompare(b.sendAt)
      || a.createdAt.localeCompare(b.createdAt)
      || a.id.localeCompare(b.id))
    .at(0);
  if (!due) return false;
  if (!(await beginDelivery(due.id))) return true; // 另一个触发源刚抢走:由它开回合
  // 一旦被交接认领为**任务执行输入**,这个转换就要在启动前持久化(第 6 轮审查:
  // 运行中暂存的追问 execution=0,轮到时经这里交接,起跑失败后重投仍按首次发送时的
  // 终态续聊分类放行,与同队在跑成员并行执行)。失败与重启后的重试都沿用这个意图;
  // 真正的终态续聊从不经过本函数,不受影响。
  if (!due.execution) {
    await db.update(scheduledMessages).set({ execution: true }).where(eq(scheduledMessages.id, due.id));
    due.execution = true;
  }
  inFlight.add(taskId);
  lastFiredAt.set(taskId, Date.now());
  const queuedAt = Date.now();
  const dueAt = markDue(due.id, queuedAt);
  const busyMs = settleBusyAgain(due.id, queuedAt);
  let delivered = false;
  try {
    const started = await continueTask(taskId, due.text, {
      // 消息登记的执行器配置与发送者身份优先(与扫描投递同口径);消息没登记归属时
      // 才算到这次启动的发起人头上。
      actingUserId: opts.actingUserId ?? undefined,
      ...deliveryOptions(due),
      // 执行意图与输入来源分开表示(第 4 轮审查):这一回合是任务的执行(终态重试
      // 不走续聊语义),但输入是真实用户回复 —— 原文/附件照常进会话记录与后续追问,
      // 不能带 system 标记把它记成一句「〔系统〕继续」。
      executionTurn: true,
      // 冻结核查只给无人值守的启动压上:队列推进(无 turnHeld)从 isPaused 预检查到
      // spawn 隔着不少 await,中途用户可能刚按下暂停;手动运行/重试(turnHeld)是用户
      // 显式动作,语义与隔壁 RESUME/fresh 路径保持一致,不额外加闸。
      freezeGuard: !opts.turnHeld,
      turnHeld: opts.turnHeld,
      onDelivered: async () => {
        delivered = true;
        const sentAt = Date.now();
        await markSent(due);
        // 这条路由调用方在回合空着时拉起,没有「等回合退干净」一段,两个时间点同值。
        noteDeliveryTiming(taskId, { dueAt, busyMs, queuedAt, idleAt: queuedAt, at: sentAt });
      },
    });
    if (!delivered) {
      // 同 deliverWhenIdle:「已接管回合」≠「已送达」,唯一可信的送达信号是 onDelivered。
      // 起跑异常被 continueTask 内部吸收(结算 failed 后返回 true)时必须归还租约,
      // 否则恢复后的重试与扫描(都只看无租约的 pending 行)永远绕开这条消息。
      await abortDelivery(due);
      scheduleRedelivery(due, started ? "回合起跑失败，原文退回待发送" : "回合被其它执行抢占或工作区正被验收占用");
    }
    return true;
  } catch (error) {
    if (delivered) return true; // 已进会话之后才炸的是运行事故,不是未送达
    const detail = error instanceof Error ? error.message : String(error);
    await cancelPendingMessage(due, `续跑失败：${detail}`).catch(() => {});
    return true;
  } finally {
    inFlight.delete(taskId);
  }
}

/**
 * 托盘里还有没有「此刻就该送进会话」的消息。给结算那边让路用(见 free-workflow.ts
 * `handleFreeWorkflowSettlement` 的让路一节)。
 *
 * 不算数的三类,判据与投递路径同源,免得两边对「还有消息等着」的理解分家:
 * - 还没到钟点的定时消息(`isDueForDelivery`):它不是「这一轮的追问」,让它挡住审查等于
 *   把一条定在明天的消息变成审查的开关;
 * - 归档任务 / 不支持回复的任务类型:这些消息下一次投递就会被 `deliveryVerdict` 取消掉,
 *   挡不住谁,却会让预约永远等一个不会发生的回合;
 * - 已被别的路径抢走租约(`deliveringSince` 非空)的除外——它仍在送,仍然算数。
 */
export async function hasDeliverablePendingMessages(taskId: string, at = new Date()): Promise<boolean> {
  const task = (await db
    .select({ mode: tasks.mode, archived: tasks.archived })
    .from(tasks)
    .where(eq(tasks.id, taskId))).at(0);
  if (!task || task.archived) return false;
  if (task.mode !== "single" && task.mode !== "team") return false;
  const rows = await db
    .select({ mode: scheduledMessages.mode, sendAt: scheduledMessages.sendAt })
    .from(scheduledMessages)
    .where(and(eq(scheduledMessages.taskId, taskId), eq(scheduledMessages.status, "pending")));
  return rows.some((m) => isDueForDelivery(m, at));
}
