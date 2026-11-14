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
// 就记一笔欠账(推进意图当场落库,见 `owedAdvance`),放锁时兑现。扫描每次放锁都做:它只读、幂等,判定与去重都在 pending-messages.ts。
// 30 秒兜底 tick(schedules.ts)不归这里:定时消息到期靠它,它也是最后一道保险。
import { isTurnClaimed, onTurnReleased } from "./turn-lock.js";

/**
 * 占着锁时欠下的队列推进:任务 → 「推哪一条队列」(null = 它不在任何队列里)。
 *
 * **内存里只记「什么时候推」,责任本身当场落库**:锁占着时这一笔先写 `queue_advance_intents`
 * (`recordQueueAdvanceIntent`,和 `advanceQueue` 入口领的是同一种凭据)。状态已经落库、锁还没放
 * 的那段时间里进程没了,重启恢复(scheduler.ts `recoverQueueAdvances`)按这一行补推 —— 早先的
 * 写法是落状态当场 `advanceQueue`,意图在那一刻就落了库;推进挪到放锁之后,凭据不能跟着挪
 * (第 1 轮审查:paused 的队首在收尾时重启,整条队列从此停住)。
 * 放锁时 `advanceQueue` 再领一代凭据、做完只清自己那一代,先落的这一行被它覆盖,不会留下多余的一行;
 * 所以放锁一侧要先等这一笔写完再推,两笔次序反了就会剩一行,下次重启平白多推一次。
 */
const owedAdvance = new Map<string, Promise<string | null>>();

export type StatusFollowUps = { advance: boolean; flush: boolean };

/** status.ts 落完一笔状态之后调:锁空着当场做,回合还占着就留到放锁那一刻。 */
export function afterStatusLanded(taskId: string, effects: StatusFollowUps): void {
  if (effects.advance) oweQueueAdvance(taskId, null);
  else if (effects.flush && !isTurnClaimed(taskId)) flushPending(taskId);
}

/**
 * 让这个任务的下一次放锁推一次 `queueId`(null = 它此刻所在的队列);锁空着就当场推、顺带扫一遍。
 * 同一次放锁之前欠的几笔是同一条队列(指定的那条就是它所在的队列),记一笔就够。
 */
export function oweQueueAdvance(taskId: string, queueId: string | null): void {
  const held = isTurnClaimed(taskId);
  if (!owedAdvance.has(taskId)) owedAdvance.set(taskId, owedQueue(taskId, queueId, held));
  if (!held) settle(taskId);
}

/** 解出要推的队列;锁占着(`durable`)就先把推进意图落库。锁空着当场推,`advanceQueue` 入口自己会落。 */
async function owedQueue(taskId: string, queueId: string | null, durable: boolean): Promise<string | null> {
  try {
    if (!queueId) {
      const [{ db }, { queueItems }, { eq }] = await Promise.all([
        import("./db/index.js"), import("./db/schema.js"), import("drizzle-orm"),
      ]);
      queueId = (await db.select().from(queueItems).where(eq(queueItems.taskId, taskId))).at(0)?.queueId ?? null;
    }
    if (queueId && durable) await (await import("./queue-advance-admission.js")).recordQueueAdvanceIntent(queueId);
  } catch (error) {
    // 查不到队列 = 这一笔推不了;意图没落成 = 只剩放锁这一次机会(`recordQueueAdvanceIntent` 自己会记日志)。
    console.error(`[ash] 欠下的队列推进没能落库 task=${taskId}:`, error);
  }
  return queueId;
}

function settle(taskId: string): void {
  const owed = owedAdvance.get(taskId);
  if (owed) {
    owedAdvance.delete(taskId);
    // 动态 import:scheduler / pending-messages 都静态依赖 status.ts,而 status.ts 依赖本文件。
    // void 不 await:放锁可能发生在推进的认领临界区里,推进排到链尾即可,await 会死等自己。
    void owed.then(async (queueId) => {
      if (queueId) await (await import("./scheduler.js")).advanceQueue(queueId);
    }).catch((error) => console.error(`[ash] 放锁后的队列推进失败 task=${taskId}:`, error));
  }
  flushPending(taskId);
}

function flushPending(taskId: string): void {
  void import("./pending-messages.js").then(({ flushPendingForTask }) => flushPendingForTask(taskId))
    .catch((error) => console.error(`[ash] 放锁后的待发送扫描失败 task=${taskId}:`, error));
}

onTurnReleased(settle);
