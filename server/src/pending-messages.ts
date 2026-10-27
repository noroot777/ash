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
import { and, eq, inArray, isNotNull, isNull, ne, or } from "drizzle-orm";
import type { AgentType, ScheduledMessageMode } from "@ash/shared";
import { bus } from "./bus.js";
import { db, dbClient } from "./db/index.js";
import { scheduledMessages, tasks, groups } from "./db/schema.js";
import { continueTask } from "./orchestrator.js";
import { queueBlockers } from "./queues.js";
import { claimQueueSeat, type QueueSeat } from "./queue-seat.js";
import { taskStartStatus } from "./task-start-status.js";
import { releaseTurn, turnSourceReview, whenTurnIdle } from "./runs.js";
import type { TurnSource } from "./runs.js";
import { forgetTiming, markDue, noteBusyAgain, noteDeliveryTiming, settleBusyAgain } from "./pending-delivery-timing.js";
import { forgetRedelivery, retryBlocked, scheduleRedelivery } from "./pending-redelivery.js";
import { monitorIdFromOrigin } from "@ash/shared/monitor";
import { monitorEventSourceState } from "./monitor-session.js";
import type { MonitorWakeData } from "@ash/shared/monitor-wake";
import { deliveryOptions, deliveryVerdict, isDueForDelivery, pendingExecutionIntent } from "./pending-verdict.js";
import { reviewDeliveryBlocked, reviewDeliveryFrom } from "./review-ownership.js";
import { appendTaskTimeline } from "./task-timeline.js";
import { bindUploadsToTask } from "./uploads.js";
import { dispatchPendingMessage } from "./pending-dispatch.js";
import { pendingMessageOrder } from "./pending-monitor-batch.js";
import { hasPendingDeliveryRecovery } from "./pending-delivery-recovery.js";
import { CHECKPOINT_RUN_ORIGIN, recoverPendingCheckpoints, preparePendingCheckpointStart } from "./pending-checkpoint-recovery.js";
import { id, now } from "./util.js";
import type { ConclusionTransaction } from "./regression-conclusion-commit.js";

// 判定与投递参数的无状态部分拆在 pending-verdict.ts(本文件顶过 700 行上限);
// 外部引用保持原路径不动。
export {
  deliveryOptions,
  deliveryVerdict,
  isDueForDelivery,
  monitorWakeGuard,
  type DeliveryMessageView,
  type DeliveryTaskView,
  type DeliveryVerdict,
} from "./pending-verdict.js";

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
  /**
   * 投递这条消息时要恢复的**回合身份**(见 runs.ts 的 `TurnSource`):角色 + 为哪一次审查的
   * 哪一轮。两样一起落库(`session_role` + `review_run`/`review_round`),所以投递那一刻不必
   * 现查「现在是哪一次审查」—— 那条现查会把旧请求绑到新审查上(第 10 轮审查 F1),而只带角色
   * 不带代次则会让续起来的审查者挂不上哨兵(本轮审查 F2)。
   */
  turnSource?: TurnSource | null;
  /** 谁发的这条(多人模式);投递时按它解析执行器与 CLI 环境。 */
  ownerUserId?: string | null;
  /** 不是真人写的那种消息的来源标记(`monitor:<id>`)。null = 用户自己发的。 */
  origin?: string | null;
  monitorWake?: MonitorWakeData | null;
  mode?: ScheduledMessageMode;
  /** 执行意图:排队等轮次时暂存的回复(投递 = 任务的执行回合,见 schema 注释)。 */
  execution?: boolean;
  // 排队消息不看钟点,sendAt 只用来排先后,所以默认取此刻。
  sendAt?: Date;
  /** 这条消息承载的那一笔结果交接的身份(见 schema 的 `handoff_token`);普通消息不填。 */
  handoffToken?: string | null;
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
    sessionRole: input.turnSource ? input.turnSource.role : null,
    reviewRun: turnSourceReview(input.turnSource)?.run ?? null,
    reviewRound: turnSourceReview(input.turnSource)?.round ?? null,
    ownerUserId: input.ownerUserId ?? null,
    origin: input.origin ?? null,
    monitorWake: input.monitorWake ?? null,
    mode: input.mode ?? ("queued" satisfies ScheduledMessageMode),
    execution: input.execution ?? false,
    sendAt: (input.sendAt ?? new Date()).toISOString(),
    status: "pending" as const,
    createdAt: now(),
    sentAt: null,
    deliveringSince: null,
    // 新消息没接走任何交代（接走发生在投递那一刻，见 monitorWakeCheckpoint）。
    checkpointTaken: null,
    handoffToken: input.handoffToken ?? null,
    // 普通消息不承载续跑交代,所以凭证两列一起空着(账本在 monitor-session.ts 里才写)。
    checkpointAuto: null,
    checkpointGeneration: null,
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

// 判定所需的任务/消息形状与三档判定(deliveryVerdict)、到期判据(isDueForDelivery)
// 都住在 pending-verdict.ts —— 纯函数,无账本。

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

// 挡回之后的主动重投(退避账本)住在 pending-redelivery.ts:挡回的每一条出口调
// `scheduleRedelivery` 记账并自排重投;所有扫描触发源进场先问 `retryBlocked`。
// 消息送达/取消时把两本账(重投 + 计时)一起清掉。
function forgetDeliveryBookkeeping(messageId: string): void {
  forgetRedelivery(messageId);
  forgetTiming(messageId);
}

// 抢下之后最终没能送出去:把租约还回去(托盘里它压根没消失过),下一次触发再送。
// **宁可晚发,不能不发。**
export async function abortDelivery(message: Row | Row[]): Promise<void> {
  const messages = Array.isArray(message) ? message : [message];
  if (!messages.length) return;
  lastFiredAt.delete(messages[0]!.taskId);
  await db
    .update(scheduledMessages)
    .set({ deliveringSince: null })
    .where(and(inArray(scheduledMessages.id, messages.map((current) => current.id)), eq(scheduledMessages.status, "pending")));
}

export async function cancelPendingMessage(message: Row, reason: string): Promise<void> {
  forgetDeliveryBookkeeping(message.id);
  await db
    .update(scheduledMessages)
    .set({ status: "canceled", sentAt: null, deliveringSince: null })
    .where(eq(scheduledMessages.id, message.id));
  publishPendingMessages(message.taskId);
  await recoverPendingCheckpoints(message.taskId);
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
// **返回的是抢下那一刻的那一行,不是调用方手里的快照。** 待发送的正文是会变的:哨兵事件
// 直接往同一行后面追加(monitors.ts `pushToTask`,合并才能让几十条事件只唤醒任务一次),
// 而投递方从「选中这一条」到真正送出去中间要等当前回合退干净 —— 那段时间里追加进去的
// 内容,按旧快照发就等于没发,行却被标成 sent,于是它永远不会再补发(第 2 轮审查实测:
// 会话里只有 FIRST,sent 的正文里 FIRST+SECOND 都在,读取位置也已经越过去了)。
// 租约一旦落下,追加端的 CAS 条件(租约为空)就不再成立,所以「抢租约 → 重读正文」之后
// 这一行的内容不会再变。
//
// 导出是给崩溃测试用的:`test-scheduled-messages.ts` 的子进程拿它抢下租约后立刻 SIGKILL
// 自己,好让「另一个进程死在投递中途」这个现场由**真实路径本身**造出来,而不是测试手写
// 一行假状态。投递逻辑之外不要调它。
export async function beginDelivery(messageId: string): Promise<Row | null> {
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
    .returning();
  return claimed.at(0) ?? null;
}

// 原话已经进会话了,这才落 sent。用 status='pending' 兜一道:等待期间用户手动取消过的
// 消息不该被这一步复活。
export async function markSent(message: Row | Row[], transaction?: ConclusionTransaction): Promise<void> {
  const messages = Array.isArray(message) ? message : [message];
  if (!messages.length) return;
  await (transaction ?? db)
    .update(scheduledMessages)
    .set({ status: "sent", sentAt: now(), deliveringSince: null })
    .where(and(
      inArray(scheduledMessages.id, messages.map((current) => current.id)),
      or(
        eq(scheduledMessages.status, "pending"),
        and(
          eq(scheduledMessages.origin, CHECKPOINT_RUN_ORIGIN), eq(scheduledMessages.status, "canceled"),
          isNotNull(scheduledMessages.deliveringSince), isNotNull(scheduledMessages.checkpointTaken),
        ),
      ),
    ));
  if (!transaction) {
    for (const current of messages) forgetDeliveryBookkeeping(current.id);
    publishPendingMessages(messages[0]!.taskId);
  }
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
    .where(and(ne(scheduledMessages.status, "sent"), isNotNull(scheduledMessages.deliveringSince)))
    .returning({ id: scheduledMessages.id });
  if (reclaimed.length) console.log(`[ash] 回收 ${reclaimed.length} 条中断的待发送消息投递`);
  await recoverPendingCheckpoints();
  return reclaimed.length;
}

// 投递参数拼装(deliveryOptions)与哨兵唤醒的最后一道闸(monitorWakeGuard)也在
// pending-verdict.ts。

// 投递一批待发送消息。taskId 非空 = 只看这个任务(终态钩子用);为空 = 全表扫一遍
// (tick 用)。同任务每次只起一轮；兼容且连续的哨兵结果一起交付，其它消息继续排队。
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
  const checkpointFailures = await recoverPendingCheckpoints(taskId);
  const at = new Date();
  // 带租约的行 = 本进程另一条路径正在送它,跳过(开机时 reclaimStaleDeliveries 已经把
  // 上一个进程留下的租约全清了,所以这里看到的租约一定是活的)。
  const all = await db
    .select()
    .from(scheduledMessages)
    .where(and(eq(scheduledMessages.status, "pending"), isNull(scheduledMessages.deliveringSince)));
  const pending = (taskId ? all.filter((m) => m.taskId === taskId) : all)
    .sort(pendingMessageOrder);
  const fired = new Set<string>();
  for (const m of pending) {
    try {
      if (checkpointFailures.has(m.taskId) || fired.has(m.taskId) || inFlight.has(m.taskId) || hasPendingDeliveryRecovery(m.taskId)
        || cooling(m.taskId, at.getTime())) continue;
      // 下一次允许重试的时刻没到就不碰:退避只写在重投定时器上管不住别的触发源 ——
      // 失败结算钩子、队列唤醒触发的扫描会绕过它,形成「失败→结算唤醒→再失败」的
      // 自激循环(第 6 轮审查:目录不修复时 2 秒 24 次失败)。
      if (retryBlocked(m.id, at.getTime())) continue;
      const t = (await db.select().from(tasks).where(eq(tasks.id, m.taskId))).at(0) ?? null;
      const execution = pendingExecutionIntent(m, t);
      if (execution !== m.execution) {
        await db.update(scheduledMessages).set({ execution }).where(and(eq(scheduledMessages.id, m.id), eq(scheduledMessages.status, "pending")));
        m.execution = execution;
      }
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
      const queueBlocked = needQueueCheck ? (await queueBlockers(m.taskId)).length > 0 : false;
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
      // 两个时间点,别合并:
      //   dueAt    = 这条消息**第一次**被判定该发的那一刻(markDue 只记第一次)。被挡回、
      //              几秒后重投、甚至被 30s 兜底扫描捡走,起点都还是它 —— 这才是用户
      //              盯着托盘干等的那段时间。
      //   queuedAt = 这一次投递尝试开始的时刻。两者之差 = 之前被挡回空等了多久。
      const queuedAt = Date.now();
      const dueAt = markDue(m.id, queuedAt);
      const busyMs = settleBusyAgain(m.id, queuedAt);
      if (t!.mode === "team") {
        await dispatchPendingMessage(m, {
          spans: { dueAt, busyMs, queuedAt }, team: true,
          onClaim: () => {
            fired.add(m.taskId);
            lastFiredAt.set(m.taskId, Date.now());
          },
        });
      } else {
        // 单任务必须等它**当前这一轮退干净**再送。两个触发源里的终态钩子
        // (setTaskStatus → flushPendingForTask)是在 run loop 的 try 里调的,那一刻
        // 单飞锁还锁着;直接 continueTask 会被静默挡回,消息就此蒸发。`whenTurnIdle`
        // 由 releaseTurn 同一处排空,是结算钩子里给同一个任务续跑的唯一安全写法。
        //
        // 开启执行回合的投递(执行型消息,或 paused/backlog 任务的排队回复 —— 即
        // needQueueCheck 那一类)先认领队列执行占位(claimQueueSeat):「整队无人在跑」
        // 的检查与落 queued 在同一个临界区里,且与手动运行、/fire、失败重试、重跑上一
        // 回合、队列推进共用同一条链。只靠本模块自己串行是不够的 —— 重跑上一回合在
        // 异步读旧记录期间只占任务级回合锁、状态还停在终态,扫描按 DB 状态判定「整队
        // 空闲」照样穿透(第 7 轮审查:普通 HTTP 并发 10/10 双跑)。被挡回按「等」记账,
        // 下一次触发再试;终态续聊(非执行型、任务已终态)不占位,豁免保留。
        // 占位的回收:投递成功/失败都由 continueTask 的结算覆盖 status;唯一落空口
        // (租约被抢/消息已取消)由 pending-dispatch 的收尾按 seat.release() 回滚。
        let seat: QueueSeat | undefined;
        if (needQueueCheck) {
          const claim = await claimQueueSeat(m.taskId);
          if (!claim.ok) {
            noteBusyAgain(m.id, at.getTime());
            continue;
          }
          seat = claim.seat ?? undefined;
        }
        fired.add(m.taskId);
        inFlight.add(m.taskId);
        whenTurnIdle(m.taskId, () => void dispatchPendingMessage(m, {
          spans: { dueAt, busyMs, queuedAt }, seat,
          onClaim: () => { lastFiredAt.set(m.taskId, Date.now()); },
          onSettled: () => { inFlight.delete(m.taskId); },
        }));
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
// 队列占位不在这里认领:调用链的上游已经持有 —— 队列推进/分组启动在拉起前 setQueued,
// 手动运行//fire//retry/重跑上一回合在路由里 claimQueueSeat(queue-seat.ts),这里再占
// 一次反而会被自己的 queued 挡住。
// 返回 true = 这次启动已由消息交接接管(含「另一路已在送」与「挡回后已排重投」),
// 调用方不要再开别的回合;false = 没有可交接的消息,照常走默认输入。
export async function handDuePendingMessageToRun(
  taskId: string,
  opts: { turnHeld?: boolean; freezeGuard?: boolean; actingUserId?: string | null } = {},
): Promise<boolean> {
  if (dbClient.closed) return false;
  const checkpointBlocked = await preparePendingCheckpointStart(taskId);
  if (checkpointBlocked) {
    if (opts.turnHeld) releaseTurn(taskId);
    throw new Error(checkpointBlocked);
  }
  const checkpoint = await db.select({ prompt: tasks.resumePrompt }).from(tasks)
    .where(eq(tasks.id, taskId)).then((rows) => rows.at(0)?.prompt).catch((error) => {
      if (opts.turnHeld) releaseTurn(taskId);
      throw error;
    });
  if (checkpoint) {
    if (opts.turnHeld) releaseTurn(taskId);
    throw new Error("任务仍有续跑交代，先交付检查点再交接普通输入");
  }
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
    // 哨兵事件(origin 非空)不参与让位交接:它不是用户的执行指令,拿来当首轮输入会被
    // 升级成执行意图、还绕开唤醒闸(monitorWakeGuard)与终态取消;留给扫描按哨兵语义送。
    .filter((m) => !m.origin && isDueForDelivery(m, at))
    .sort(pendingMessageOrder)
    .at(0);
  if (!due) return false;
  const claimed = await beginDelivery(due.id);
  if (!claimed) return true; // 另一个触发源刚抢走:由它开回合
  inFlight.add(taskId);
  lastFiredAt.set(taskId, Date.now());
  const queuedAt = Date.now();
  const dueAt = markDue(due.id, queuedAt);
  const busyMs = settleBusyAgain(due.id, queuedAt);
  let delivered = false;
  let handedOff = false;
  try {
    const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0) ?? null;
    const execution = pendingExecutionIntent({ ...due, execution: true }, task && { ...task, status: taskStartStatus(task) });
    if (due.execution !== execution) {
      await db.update(scheduledMessages).set({ execution }).where(eq(scheduledMessages.id, due.id));
      due.execution = execution;
    }
    handedOff = true;
    const started = await continueTask(taskId, due.text, {
      // 消息登记的执行器配置与发送者身份优先(与扫描投递同口径);消息没登记归属时
      // 才算到这次启动的发起人头上。
      actingUserId: opts.actingUserId ?? undefined,
      ...deliveryOptions(due),
      // 执行意图与输入来源分开表示(第 4 轮审查):这一回合是任务的执行(终态重试
      // 不走续聊语义),但输入是真实用户回复 —— 原文/附件照常进会话记录与后续追问,
      // 不能带 system 标记把它记成一句「〔系统〕继续」。
      executionTurn: execution,
      // 冻结核查:启动来源与回合所有权分开看(第 6 轮审查:队列推进带 turnHeld 后,
      // 这里把 turnHeld 误当「手动运行」,自动交接穿透了分组暂停)。调用方(task-resume)
      // 按来源显式给 freezeGuard;没给的旧调用按原判据降级 —— 手动运行/重试(turnHeld)
      // 是用户显式动作,不加闸,与隔壁 RESUME/fresh 路径保持一致。
      freezeGuard: opts.freezeGuard ?? !opts.turnHeld,
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
    if (!handedOff && opts.turnHeld) releaseTurn(taskId);
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
