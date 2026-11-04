// 投递链路的计时账本(从 pending-messages.ts 按职责拆出,那边顶到 700 行上限)。
// 只管「一条消息等了多久、慢在哪一段」,不碰投递决策与状态迁移。
//
// 计时起点是**这条消息第一次被判定「该发了」**的那一刻,按 message.id 记住,跨触发源、
// 跨重试都不重置。老实现每次扫描都把起点刷新成「此刻」,于是一条被挡回、十几秒后才由
// 兜底 tick 捡走的消息,账面上只有最后那一秒 —— 真正的等待永远算不进来。
//
// 用户排队那几十分钟(等 agent 这一轮说完)不在这本账里:那是排队语义本身,不是投递
// 链路的账。所以起点是「判定该发」,不是「用户按下发送」。
const dueSince = new Map<string, number>();

// 判定该发**之后**任务又忙起来了(别的回合抢先跑、用户手点运行、重试撞上新一轮):那一段
// 是「等 agent 这一轮说完」,跟用户排队时等的是同一件事,不是投递链路的账。单独记下来,
// 否则它会整段混进「挡回后空等」里,把一段完全正常的运行读成「任务空闲却没投递」——
// 排查时正好指向错误的方向(第 1 轮审查指出)。
const busyAgain = new Map<string, { since: number | null; total: number }>();

export const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

/** 三种待发送消息在时间线/日志里的叫法。 */
export function pendingMessageLabel(mode: string): string {
  return mode === "queued" ? "排队消息" : mode === "after" ? "等前置任务的消息" : "定时消息";
}

export function markDue(messageId: string, at: number): number {
  const first = dueSince.get(messageId);
  if (first != null) return first;
  dueSince.set(messageId, at);
  return at;
}

/** 已经判定过该发、这一轮又变回「等」:开始计这一段忙碌(已经在计就不动)。 */
export function noteBusyAgain(messageId: string, at: number): void {
  if (!dueSince.has(messageId)) return; // 还没到「该发」,这段等待属于排队语义本身
  const entry = busyAgain.get(messageId);
  if (!entry) busyAgain.set(messageId, { since: at, total: 0 });
  else if (entry.since == null) entry.since = at;
}

/** 又轮到它发了:收口当前这段忙碌,返回累计时长。 */
export function settleBusyAgain(messageId: string, at: number): number {
  const entry = busyAgain.get(messageId);
  if (!entry) return 0;
  if (entry.since != null) {
    entry.total += at - entry.since;
    entry.since = null;
  }
  return entry.total;
}

export function waitedFor(messageId: string, at = Date.now()): number {
  return at - (dueSince.get(messageId) ?? at);
}

/** 这条消息送达/取消了,把它的计时账一并清掉(pending-messages 的 forget 流程调)。 */
export function forgetTiming(messageId: string): void {
  dueSince.delete(messageId);
  busyAgain.delete(messageId);
}

// 一条排队消息从「该发了」到「原话进会话」之间只有两段路,分段计时是因为它们的病因
// 完全不同,合成一个总耗时就分不出该去查谁:
//   等回合退干净 = 上一轮结算还没跑完(钩子在 run loop 的 try 里就调了,releaseTurn 在更后面)
//   拉起回合     = prepareWorktree + 工作目录快照 + spawn 执行器
// 阈值以上才出声:典型值是 1.5~2.6 秒,偶发十几秒时用户看到的是「任务都显示完成了,
// 我那句话还挂在托盘里」(2026-09-29 实测一次 13.1 秒,当时无埋点、事后无从归因)。
const SLOW_DELIVERY_MS = 3_000;

export function noteDeliveryTiming(
  taskId: string,
  spans: { dueAt: number; busyMs: number; queuedAt: number; idleAt: number; at: number },
): void {
  const { dueAt, busyMs, queuedAt, idleAt, at } = spans;
  if (at - dueAt < SLOW_DELIVERY_MS) return;
  // 「挡回后空等」要把任务重新忙起来的那几段扣掉,否则它读起来像「明明空闲却没人送」,
  // 而真相可能只是别的回合在正常跑。
  const idle = Math.max(0, queuedAt - dueAt - busyMs);
  console.warn(
    `[ash] 排队消息投递偏慢 task=${taskId} 共 ${secs(at - dueAt)}`
    + `（任务又忙起来 ${secs(busyMs)}`
    + ` + 挡回后空等 ${secs(idle)}`
    + ` + 等回合退干净 ${secs(idleAt - queuedAt)}`
    + ` + 拉起回合 ${secs(at - idleAt)}）`,
  );
}

// ── 久久发不出去的那一条:出声 + 留痕 ─────────────────────────────────────────
// 上面那套计时只在**送成之后**结算,所以「一直没送成」正好落在它的盲区里:2026-10-26
// 一条排队消息在托盘里躺了 70 多分钟,日志从头到尾一声不吭,界面上也只是「待发送」——
// 用户无从知道它卡住了,更无从知道卡在什么上。(根因是一把无主的回合锁把任务钉在 queued,
// 投递判定于是永远是「等它空下来」;那条链已经由 turn-lock-reclaim.ts 兜住,但「卡住了
// 要说出来」本身是独立的一条:兜底修好之后仍会有别的理由让一条消息久久发不出去。)
//
// 判据刻意用**消息自己的年龄**,不是上面的 `dueSince`:判了「等」的消息压根没有 dueSince,
// 而那正是这里要抓的形态。定时消息从 `sendAt` 起算 —— 它在那之前「没发出去」是本意,
// 不是卡住。
const STALLED_MS = 600_000;

/** 已经出过声的,不再刷屏(时间线那条另有 eventKey 兜持久幂等)。 */
const stalledTold = new Set<string>();
const stalledWriting = new Set<string>();

export function forgetStalled(messageId: string): void {
  stalledTold.delete(messageId);
}

/**
 * 一条还没送出去的消息,如果已经躺了够久,出一声并往任务时间线写一条。
 *
 * 在投递扫描判「这一轮还不能发」的那个分支上调(pending-messages)。`why` 是这一轮的
 * 判定理由 —— 它就是用户想知道的那句话,所以照原样带进时间线。
 */
export async function noteStalledPending(
  message: { id: string; taskId: string; mode: string; createdAt: string; sendAt: string | null },
  why: string,
  at = Date.now(),
): Promise<void> {
  // 「本该发出去的那一刻」:排队消息是它被排下的时候,定时消息是 sendAt(两者取晚的那个 ——
  // 一条排在未来的定时消息,创建得再早也不算等待)。
  const createdAt = new Date(message.createdAt).getTime();
  const sendAt = message.sendAt ? new Date(message.sendAt).getTime() : NaN;
  const dueFrom = message.mode === "queued" || !Number.isFinite(sendAt)
    ? createdAt
    : Math.max(createdAt, sendAt);
  const age = at - dueFrom;
  if (!Number.isFinite(age) || age < STALLED_MS) return;
  if (stalledTold.has(message.id) || stalledWriting.has(message.id)) return;
  stalledWriting.add(message.id);
  const label = pendingMessageLabel(message.mode);
  const waited = `${Math.round(age / 60_000)} 分钟`;
  console.warn(
    `[ash] ${label}等了 ${waited} 还没送出去 task=${message.taskId} message=${message.id}`
    + `（这一轮的判定：${why}）—— 原话仍在托盘里,不会丢`,
  );
  // 持久可见:用户刷新页面后也要能看出「我那句话还没送到、卡在什么上」。eventKey 让它
  // 每条消息最多写一次,重启后重扫也不会写出第二条。
  try {
    const { noteSystemNotice } = await import("./user-action-rejection.js");
    const persisted = await noteSystemNotice(
      message.taskId,
      `stalled-message:${message.id}`,
      `${label}滞留`,
      `你的${label}已经等了约 ${waited} 还没发出去：${why}。`
      + "原话仍在待发送托盘里（不会丢），任务恢复空闲后会自动送出；也可以在托盘里取消它。",
    );
    if (persisted) stalledTold.add(message.id);
  } catch (error) {
    console.warn(`[ash] 滞留消息留痕失败 task=${message.taskId} message=${message.id}:`, error);
  } finally {
    stalledWriting.delete(message.id);
  }
}
