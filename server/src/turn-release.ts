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
//
// **推进的责任不住在内存里**。内存只记「什么时候推」,「该推」这件事在欠下的那一刻就已经是库里
// `queue_advance_intents` 的一行(和 `advanceQueue` 入口领的是同一种凭据,开机由 scheduler.ts
// `recoverQueueAdvances` 补推)。状态那一笔更进一步:意图与状态**同一个事务**提交
// (`stageQueueAdvance`),于是「状态已落库」就蕴含「推进凭据已落库」,中间没有能崩进去的缝;
// 查队列、写意图任何一步失败,状态那一笔一起回滚,不会出现「查失败被当成不在队列」的账
// (第 1、2 轮审查:收尾中途重启 / 查一次失败,paused 的队首从此没人叫醒)。
// 放锁时 `advanceQueue` 再领一代凭据、做完只清自己那一代;先落的那一行被它的 upsert 覆盖,不留多余。
import { eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { queueAdvanceIntents, queueItems } from "./db/schema.js";
import { isTurnClaimed, onTurnReleased } from "./turn-lock.js";
import { id, now } from "./util.js";

/** 欠着、等放锁兑现的推进:任务 → 队列 + 那一行意图写完没有(放锁一侧先等它,次序反了会剩一行)。 */
const owedAdvance = new Map<string, { queueId: string; staged: Promise<unknown> }>();

type Writer = Pick<typeof db, "select" | "insert">;

function upsertIntent(writer: Writer, queueId: string) {
  const acceptedAt = now();
  const generation = id();
  return writer.insert(queueAdvanceIntents).values({ queueId, acceptedAt, generation })
    .onConflictDoUpdate({ target: queueAdvanceIntents.queueId, set: { acceptedAt, generation } });
}

/**
 * 在**状态那一笔的事务里**记下「这个任务所在的队列该推进」。返回那条队列;null = 确定不在任何队列。
 * 抛错就让整笔回滚 —— 拿不出凭据的状态变化不许单独落库。
 */
export async function stageQueueAdvance(tx: Writer, taskId: string): Promise<string | null> {
  const queueId = (await tx.select({ queueId: queueItems.queueId }).from(queueItems)
    .where(eq(queueItems.taskId, taskId))).at(0)?.queueId ?? null;
  if (queueId) await upsertIntent(tx, queueId);
  return queueId;
}

export type StatusFollowUps = {
  /** 这一笔要推进的队列,凭据已随状态同一个事务落库;null = 不推进(或不在队列)。 */
  advanceQueueId: string | null;
  flush: boolean;
};

/** status.ts 落完一笔状态之后调:锁空着当场做,回合还占着就留到放锁那一刻。 */
export function afterStatusLanded(taskId: string, effects: StatusFollowUps): void {
  if (effects.advanceQueueId) owe(taskId, effects.advanceQueueId, Promise.resolve());
  else if (effects.flush && !isTurnClaimed(taskId)) flushPending(taskId);
}

/**
 * 不随状态落库的那一种欠账(旁路回合吞掉的让位,queue-seat.ts):锁占着就当场写一行意图,放锁时推;
 * 锁空着就当场推(`advanceQueue` 入口自己落凭据)。写意图失败只剩放锁这一次机会,出声。
 */
export function oweQueueAdvance(taskId: string, queueId: string): void {
  const staged = isTurnClaimed(taskId)
    ? Promise.resolve(upsertIntent(db, queueId)).catch((error) =>
      console.error(`[ash] 欠下的队列推进没能落库 task=${taskId} queue=${queueId}:`, error))
    : Promise.resolve();
  owe(taskId, queueId, staged);
}

// 同一次放锁之前欠的几笔是同一条队列(指定的那条就是它所在的队列),记最后一笔就够;
// 前一笔还没写完的意图跟着串上,放锁一侧等的是全部。
function owe(taskId: string, queueId: string, staged: Promise<unknown>): void {
  const prior = owedAdvance.get(taskId)?.staged;
  owedAdvance.set(taskId, { queueId, staged: prior ? Promise.all([prior, staged]) : staged });
  if (!isTurnClaimed(taskId)) settle(taskId);
}

function settle(taskId: string): void {
  const owed = owedAdvance.get(taskId);
  if (owed) {
    owedAdvance.delete(taskId);
    // 动态 import:scheduler / pending-messages 都静态依赖 status.ts,而 status.ts 依赖本文件。
    // void 不 await:放锁可能发生在推进的认领临界区里,推进排到链尾即可,await 会死等自己。
    void owed.staged.then(async () => (await import("./scheduler.js")).advanceQueue(owed.queueId))
      .catch((error) => console.error(`[ash] 放锁后的队列推进失败 task=${taskId}:`, error));
  }
  flushPending(taskId);
}

function flushPending(taskId: string): void {
  void import("./pending-messages.js").then(({ flushPendingForTask }) => flushPendingForTask(taskId))
    .catch((error) => console.error(`[ash] 放锁后的待发送扫描失败 task=${taskId}:`, error));
}

onTurnReleased(settle);
