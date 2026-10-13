// ── 挡回之后的主动重投(从 pending-messages.ts 按职责拆出,那边顶到 700 行上限)──────
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
//
// 这本账只管「什么时候允许/安排下一次尝试」,不碰租约与状态迁移;重投本身回调
// pending-messages 的扫描(动态 import,避免两个模块互相顶着加载)。
import { dbClient } from "./db/index.js";
import { secs, waitedFor } from "./pending-delivery-timing.js";

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

export function retryBlocked(messageId: string, at: number): boolean {
  return (nextRetryAt.get(messageId) ?? 0) > at;
}

/** 消息送达/取消了,把重投的账一并清掉(pending-messages 的 forget 流程调)。 */
export function forgetRedelivery(messageId: string): void {
  redeliveryAttempts.delete(messageId);
  nextRetryAt.delete(messageId);
  const timer = redeliveryTimers.get(messageId);
  if (timer) {
    clearTimeout(timer);
    redeliveryTimers.delete(messageId);
  }
}

// 挡回一次 = 记一笔账 + 排一次重投。`why` 写进日志,是这条链路上唯一能事后归因的东西。
export function scheduleRedelivery(message: { id: string; taskId: string }, why: string): void {
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
    void import("./pending-messages.js").then(({ deliverPendingMessages }) =>
      deliverPendingMessages(message.taskId).catch((err) => {
        if (dbClient.closed) return; // 进程收尾时被掐,不是投递故障
        console.error(`[ash] 排队消息重投失败 task=${message.taskId}:`, err);
      }));
  }, delay);
  timer.unref?.();
  redeliveryTimers.set(message.id, timer);
}
