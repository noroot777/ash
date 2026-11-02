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
import { and, eq, isNull } from "drizzle-orm";
import { db } from "./db/index.js";
import { queueAdvanceIntents, tasks } from "./db/schema.js";
import { freshRunFailureTarget, reportTurnFailure } from "./turn-failure.js";
import { id, now } from "./util.js";

/**
 * 记下「这条队列该推进」,并**领走这一次接受的代次**。返回的代次就是这一趟的凭据;
 * 返回 null = 这一次推进**没有**可恢复的凭据。
 *
 * 为什么是 upsert、而不是「已经有行就不动」(第 1 轮自由审查 F2 跨进程实测):一条队列同时
 * 只有一行意图,可**先后被接受的两趟推进不是同一份责任**。旧口径下后来那一趟只是借到了旧
 * 那行,于是旧那趟一做完就按 queueId 把它裸删 —— 删掉的是别人的恢复责任,重启后没人补办
 * (实测里新队首既无意图也无单任务请求,那条链永久停住)。
 *
 * 改成「最后一次接受拥有这一行」之后,了结只认自己那一代:旧那趟的删除落到 0 行。多留一行
 * 意图的代价只是重启后多推一次(推进幂等),比把别人的责任抹掉轻得多。
 */
export async function recordQueueAdvanceIntent(queueId: string): Promise<string | null> {
  const generation = id();
  try {
    const acceptedAt = now();
    await db.insert(queueAdvanceIntents).values({ queueId, acceptedAt, generation })
      .onConflictDoUpdate({ target: queueAdvanceIntents.queueId, set: { acceptedAt, generation } });
    return generation;
  } catch (error) {
    console.error(`[ash] 队列推进意图落库失败 queue=${queueId}:`, error);
    return null;
  }
}

/**
 * 这一趟自己走完了,**自己那一代**的凭据到此了结 —— 留着它只会让下一次重启平白再推一遍。
 *
 * `generation` 必须是调用方实际承担、或者实际观察到的那一代:只清自己那一行是这条协议的
 * 全部重点(见 recordQueueAdvanceIntent)。老库开出来的行没有代次,传 null 按「代次为 NULL」
 * 清 —— 它同样只会命中观察者看见的那一行,不会误删后来某次接受。
 *
 * 清理自己失败**不拦路**:多留一行意图的代价是重启后多推一次(推进幂等),比把一趟已经
 * 做完的推进说成失败轻得多。
 */
export async function clearQueueAdvanceIntent(queueId: string, generation: string | null): Promise<void> {
  await db.delete(queueAdvanceIntents).where(and(
    eq(queueAdvanceIntents.queueId, queueId),
    generation === null
      ? isNull(queueAdvanceIntents.generation)
      : eq(queueAdvanceIntents.generation, generation),
  )).catch((error) => console.error(`[ash] 队列推进意图清理失败 queue=${queueId}:`, error));
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
