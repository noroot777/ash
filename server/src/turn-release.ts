// 回合锁放开那一刻固定发生的两件事:兑现这个任务欠下的队列推进、扫一遍它的待发送。
//
// 为什么挂在放锁上、而不是落状态那一刻:一个回合的状态是**持锁**写库的(收流结束 →
// settleTaskStatus → afterSettlement → 回合尾 → orchestrator 注销句柄、放锁)。在那段时间里触发的
// 扫描看不到结算钩子之后才入队的消息(审查修复指令、撞上收尾窗口的回复/答复),推进也认领不到
// 这把锁 —— 于是入队方、结算钩子各自去登记「放开了再来一次」,漏挂一处就只剩 30 秒兜底 tick
// (587e94b9、a3cd3ce4 补的都是这种漏挂)。放锁才是回合真正结束的那一刻,两件事收在这里,谁都
// 不必记得去挂。
//
// 落状态那一笔(status.ts)只交代「这一笔该不该推进队列、该不该扫」:锁空着就当场做,锁占着
// 就记一笔欠账,放锁时兑现。扫描每次放锁都做:它只读、幂等,判定与去重都在 pending-messages.ts。
// 30 秒兜底 tick(schedules.ts)不归这里:定时消息到期靠它,它也是最后一道保险。
import { isTurnClaimed, onTurnReleased } from "./turn-lock.js";

/**
 * 占着锁时欠下的队列推进:任务 → 推哪一条队列(null = 按任务此刻所在的队列找)。
 *
 * 只记在内存里够不够:推进本身在 `advanceQueue` 入口先把意图落库(queue_advance_intents),
 * 这里欠的只是「什么时候去推」。进程在放锁之前没了,重启对账会把这一轮重新结算、再落一次状态。
 */
const owedAdvance = new Map<string, string | null>();

export type StatusFollowUps = { advance: boolean; flush: boolean };

/** status.ts 落完一笔状态之后调:锁空着当场做,回合还占着就留到放锁那一刻。 */
export function afterStatusLanded(taskId: string, effects: StatusFollowUps): void {
  if (effects.advance) oweQueueAdvance(taskId, null);
  else if (effects.flush && !isTurnClaimed(taskId)) flushPending(taskId);
}

/**
 * 让这个任务的下一次放锁推一次 `queueId`(null = 它此刻所在的队列);锁空着就当场推、顺带扫一遍。
 * 指定队列的那一笔(旁路回合欠下的让位,queue-seat.ts)不会被后来的「按所在队列找」盖掉。
 */
export function oweQueueAdvance(taskId: string, queueId: string | null): void {
  owedAdvance.set(taskId, queueId ?? owedAdvance.get(taskId) ?? null);
  if (!isTurnClaimed(taskId)) settle(taskId);
}

function settle(taskId: string): void {
  if (owedAdvance.has(taskId)) {
    const queueId = owedAdvance.get(taskId)!;
    owedAdvance.delete(taskId);
    // 动态 import:scheduler / pending-messages 都静态依赖 status.ts,而 status.ts 依赖本文件。
    // void 不 await:放锁可能发生在推进的认领临界区里,推进排到链尾即可,await 会死等自己。
    void import("./scheduler.js").then(({ advanceQueue, advanceQueueFromTask }) =>
      queueId ? advanceQueue(queueId) : advanceQueueFromTask(taskId))
      .catch((error) => console.error(`[ash] 放锁后的队列推进失败 task=${taskId}:`, error));
  }
  flushPending(taskId);
}

function flushPending(taskId: string): void {
  void import("./pending-messages.js").then(({ flushPendingForTask }) => flushPendingForTask(taskId))
    .catch((error) => console.error(`[ash] 放锁后的待发送扫描失败 task=${taskId}:`, error));
}

onTurnReleased(settle);
