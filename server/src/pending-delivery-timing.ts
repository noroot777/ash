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
