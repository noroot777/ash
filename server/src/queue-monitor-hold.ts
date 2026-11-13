// 队列眼里的「等哨兵的暂停」。
//
// 现场(2026-11-13,任务 aY1GMs-EHxqf):队列成员挂上回归哨兵、用 pause_task 收尾等结果。落 paused
// 那一刻状态钩子推进队列,而 paused 在 selectNextInQueue 里算「可以续跑」—— 挑中的正是刚暂停的
// 这一位,0.1 秒后新回合开始;智能体发现哨兵还在跑只能再暂停,队列再叫,一直到哨兵跑完。全库
// 16 次、全是队列成员,合计 27.5 分钟白跑的回合。
//
// 判据:paused 且名下还有没了结的哨兵(跟完成闸同一个集合,task-complete-monitors.ts 的
// `hasUnsettledMonitors`)⇒ 在等,跟等答复的暂停同一种对待:不续跑它,也不越过它。叫醒它的只有
// 哨兵结果那一路(待发送投递),所以不会出现两边各起一个回合。
//
// 反方向:名下的哨兵都了结了、却没有结果要送(被放弃、重启后丢失),这一位就退回普通的检查点
// 暂停,得有人再推一次队列,否则队列永远停在它身上。「停在这儿等过哨兵」记在推进意图上:等哨兵的
// 那一趟推进不了结自己的意图(scheduler.ts 的 `retryableQueueAdvance`),所以意图行在 ⇔ 有一次被
// 接受的推进还欠着。下面的监听只在意图还在、这一位已经不再被哨兵拖住时补推一次;意图落了库,
// 重启之后(开机补办先读意图,哨兵随后才落 lost)同一条路照样接得上。
//
// 事件只是快的那一路,不是唯一的那一路:最后一个哨兵了结后不保证还有下一条事件,这一趟复查
// 要是撞上一次读失败,欠账就没人管了(第 1 轮审查发现 1)。所以 30 秒的调度 tick 也扫一遍意图行
// (`sweepOwedQueueAdvances`),停在等哨兵的成员上的跳过,其余的补推 —— 推进幂等,多推一次的
// 代价只是一次空转判定。
//
// 为什么非看意图不可:一个静止的检查点(旁路回合结算后 quiet 落回 paused)没有欠着的推进,
// 托盘里来一条消息就把它续跑起来是另一个 bug(queue-seat.ts 里「第 2 轮语义保留」那一段)。
import { eq } from "drizzle-orm";
import { bus } from "./bus.js";
import { db, dbClient } from "./db/index.js";
import { queueAdvanceIntents, queueItems, tasks } from "./db/schema.js";

type TaskRow = typeof tasks.$inferSelect;
export type QueueRow = TaskRow & { monitorHold: boolean };

/** 名下还有没了结的哨兵吗(判据本体见 task-complete-monitors.ts 的 `hasUnsettledMonitors`)。 */
export async function heldByMonitors(taskId: string): Promise<boolean> {
  // 动态 import:task-complete-monitors 拖着整套哨兵模块,scheduler 静态加载它会绕成环。
  const { hasUnsettledMonitors } = await import("./task-complete-monitors.js");
  return hasUnsettledMonitors(taskId);
}

/**
 * 给成员标上「在等哨兵」。只有 paused 的才问 —— 别的状态另有说法。队列推进与分组运行都从这里
 * 读,自动续跑的入口用的是同一份判据。
 */
export async function withMonitorHolds(rows: TaskRow[]): Promise<QueueRow[]> {
  const out: QueueRow[] = [];
  for (const row of rows) {
    out.push({ ...row, monitorHold: row.status === "paused" && !row.archived && await heldByMonitors(row.id) });
  }
  return out;
}

/** 调度 tick 的兜底:还欠着推进、又不再停在等哨兵的成员上的队列,补推一次。 */
export async function sweepOwedQueueAdvances(): Promise<void> {
  if (dbClient.closed) return;
  const { advanceQueue, queueMembers, scanQueue } = await import("./scheduler.js");
  for (const { queueId } of await db.select({ queueId: queueAdvanceIntents.queueId }).from(queueAdvanceIntents)) {
    try {
      if (scanQueue(await queueMembers(queueId)).monitorHold) continue;
      await advanceQueue(queueId);
    } catch (error) {
      console.error(`[ash] 欠着的队列推进补推失败 queue=${queueId}(下一次 tick 再来):`, error);
    }
  }
}

async function recheck(taskId: string): Promise<void> {
  if (dbClient.closed) return;
  const item = (await db.select({ queueId: queueItems.queueId }).from(queueItems)
    .where(eq(queueItems.taskId, taskId))).at(0);
  if (!item) return;
  const owed = (await db.select({ queueId: queueAdvanceIntents.queueId }).from(queueAdvanceIntents)
    .where(eq(queueAdvanceIntents.queueId, item.queueId))).at(0);
  if (!owed) return;
  const task = (await db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (task?.status !== "paused") return;
  if (await heldByMonitors(taskId)) return;
  const { advanceQueueInBackground } = await import("./scheduler.js");
  advanceQueueInBackground(item.queueId);
}

// taskId → 这一趟检查期间又来过事件没有。一行输出一条事件,同一个任务的检查排成一趟、最后补一趟,
// 不为每一行各查一遍库。
const checking = new Map<string, boolean>();

function onMonitorChange(taskId: string): void {
  if (checking.has(taskId)) { checking.set(taskId, true); return; }
  checking.set(taskId, false);
  void (async () => {
    try {
      do {
        checking.set(taskId, false);
        await recheck(taskId);
      } while (checking.get(taskId));
    } catch (error) {
      console.error(`[ash] 等哨兵的队列成员复查失败 task=${taskId}(调度 tick 会再扫到这笔欠账):`, error);
    } finally {
      checking.delete(taskId);
    }
  })();
}

// **加载本模块就装上**(scheduler 静态依赖它):显式装配只在一条启动路径上成立。哨兵的每一次
// 了结(结束、放弃、重启后丢失)都会发 `task.monitors`,结果进出托盘都会发 `task.pendingMessages`。
bus.subscribe((event) => {
  if (event.type === "task.monitors" || event.type === "task.pendingMessages") onMonitorChange(event.taskId);
});
