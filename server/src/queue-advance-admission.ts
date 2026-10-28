// 「这一次队列推进到底**被接受了没有**」—— 准入这一问收在这个文件里。
//
// 推进本身是个后台动作:十来个入口(终态钩子、建队/插入/重排/移除、恢复分组、重启恢复、
// 让位补办)都是 `advanceQueue(queueId)` 丢出去就不管了。所以「接受」必须有凭据,而唯一
// 能活过进程的凭据就是 `queue_advance_intents` 那一行:它说的正是「有一次推进被接受过、
// 却没有哪一趟把它做完」,重启恢复按它补办(scheduler.ts 的 recoverQueueAdvances)。
//
// 第 1 轮审查 F2 实测:这一笔以前是尽力而为(记不下就算了,照旧往下推),于是「同一个库
// 两笔持久写入一起失败」时 —— 意图写不进去、推进请求也写不进去 —— 函数正常返回,而补办
// 责任只剩进程内存里的一个 `deferQueueAdvance` 闭包;进程一消失就彻底蒸发,而只有队首的
// 队列连「前驱已落终态」这条存量兜底都不成立,那条链从此永久停住。跨进程复现脚本在那一轮
// 的审查目录(queue-smoke.mjs)。
//
// 所以口径是:**拿不出可恢复的凭据、这一趟又没当场做完,就不许按「已接受」收场**。报给
// 发起者(抛),同时在候选任务上留一条持久可见的交代 —— 后台动作没人在等返回值,日志一行
// 对用户等于没发生过(根 AGENTS.md:停止/暂停必须留下持久可见的状态,同一个道理)。
import { eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { queueAdvanceIntents, tasks } from "./db/schema.js";
import { freshRunFailureTarget, reportTurnFailure } from "./turn-failure.js";
import { now } from "./util.js";

/** 记下「这条队列该推进」。返回 false = 这一次推进**没有**可恢复的凭据。 */
export async function recordQueueAdvanceIntent(queueId: string): Promise<boolean> {
  try {
    await db.insert(queueAdvanceIntents).values({ queueId, acceptedAt: now() }).onConflictDoNothing();
    return true;
  } catch (error) {
    console.error(`[ash] 队列推进意图落库失败 queue=${queueId}:`, error);
    return false;
  }
}

/**
 * 这一趟自己走完了,凭据到此了结 —— 留着它只会让下一次重启平白再推一遍。
 *
 * 清理自己失败**不拦路**:多留一行意图的代价是重启后多推一次(推进幂等),比把一趟已经
 * 做完的推进说成失败轻得多。
 */
export async function clearQueueAdvanceIntent(queueId: string): Promise<void> {
  await db.delete(queueAdvanceIntents).where(eq(queueAdvanceIntents.queueId, queueId))
    .catch((error) => console.error(`[ash] 队列推进意图清理失败 queue=${queueId}:`, error));
}

/**
 * 这次推进没被接受。写下持久交代并**造出要抛的那个错**(由调用方抛,保持栈在它那边)。
 *
 * 交代只写给**这一次该起跑的那一位**:它是「谁在等这个结果」的那一位。候选都没挑出来
 * (失败发生在读成员那几步)就只剩日志与抛出 —— 那时连该告诉谁都还不知道,凭 queueId
 * 给全队每人塞一条「没能起跑」是另一种谎报(group-start-failure.ts 的同一条教训)。
 *
 * 写交代本身也可能失败(库不可写正是这条路的典型成因):吞掉它,抛出去那一份才是主报告。
 */
export async function refuseQueueAdvance(
  queueId: string, taskId: string | null, cause: unknown,
): Promise<Error> {
  const why = cause instanceof Error ? cause.message : String(cause);
  const message = `队列推进未接受：推进责任没能落库，这一次没有任何人能在重启后补办（${why}）`;
  console.error(`[ash] ${message} queue=${queueId}${taskId ? ` task=${taskId}` : ""}`, cause);
  if (taskId) {
    try {
      const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
      if (task && !task.archived) {
        await reportTurnFailure({
          taskId, message, role: "single", target: await freshRunFailureTarget(task, null),
        });
      }
    } catch (error) {
      console.error(`[ash] 队列推进未接受的交代写入失败 task=${taskId}:`, error);
    }
  }
  return new Error(message);
}
