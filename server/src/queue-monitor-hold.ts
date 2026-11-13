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
// 暂停,得有人再推一次队列,否则队列永远停在它身上。
//
// 「还欠着这一次推进」不单独记账,从库里已有的两样事实现推(`owedAdvance`):这一位**最近一个
// 执行回合开始之后**,它名下有哨兵了结过(结束、被放弃、重启后落 lost 都会写下时刻)。哨兵出了
// 结果、把它叫醒的那一路会开一个更晚的回合,这个判据随之失效,所以不会两边各起一个回合;一个
// 静止的检查点(旁路回合结算后 quiet 落回 paused,托盘来消息也不该把它续跑起来,见 queue-seat.ts
// 里「第 2 轮语义保留」那一段)的哨兵早在它最后一个回合之前就了结了,判据不成立。
//
// 早先这笔账记在推进意图行上,于是每一条失败路径(意图写失败、开机补办读失败、重试撞上已经
// 了结的哨兵…)都得单独想办法把它保住,三轮审查各找到一处漏的。现推的判据不经过任何一次写:
// 中途哪一步失败,下一次再看,事实都还在原地。
//
// 谁来看:哨兵每一次了结都发 `task.monitors`、结果进出托盘都发 `task.pendingMessages`,下面的
// 监听当场复查;最后一个哨兵了结后不保证还有下一条事件、复查也可能撞上读失败,所以 30 秒的
// 调度 tick 再扫一遍所有暂停的队列成员(`sweepReleasedQueueMembers`),重启之后同样由它接上。
// 只对「此刻轮到它」的那一位推:排在别人后面的,前面那位结算时自会推到它。
import { and, eq, ne } from "drizzle-orm";
import { bus } from "./bus.js";
import { db, dbClient } from "./db/index.js";
import { groups, monitors, queueItems, sessions, tasks } from "./db/schema.js";

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

/** 最近一个执行回合开始之后,名下有哨兵了结过吗(判据的来由见文件头)。 */
async function owedAdvance(taskId: string): Promise<boolean> {
  const turns = await db.select({ turnStartedAt: sessions.turnStartedAt, startedAt: sessions.startedAt })
    .from(sessions)
    .where(and(eq(sessions.taskId, taskId), eq(sessions.sideTurn, false), ne(sessions.role, "reviewer")));
  const lastTurn = Math.max(...turns.map((t) => Date.parse(t.turnStartedAt ?? t.startedAt)).filter(Number.isFinite));
  if (!Number.isFinite(lastTurn)) return false;
  const settled = await db.select({ endedAt: monitors.endedAt, abandonedAt: monitors.resultsAbandonedAt })
    .from(monitors).where(eq(monitors.taskId, taskId));
  return settled.some((m) => [m.endedAt, m.abandonedAt].some((at) => !!at && Date.parse(at) > lastTurn));
}

/** 这一位在队列里等过哨兵、现在放开了、又正好轮到它 ⇒ 推一次。 */
async function releaseIfOwed(taskId: string, queueId: string): Promise<void> {
  const task = (await db.select({ status: tasks.status, archived: tasks.archived, groupId: tasks.groupId })
    .from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (task?.status !== "paused" || task.archived) return;
  if (task.groupId) {
    const group = (await db.select({ paused: groups.paused }).from(groups).where(eq(groups.id, task.groupId))).at(0);
    if (group?.paused) return;
  }
  if (await heldByMonitors(taskId) || !await owedAdvance(taskId)) return;
  const { advanceQueue, pickNextLaunchable } = await import("./scheduler.js");
  if ((await pickNextLaunchable(queueId))?.id !== taskId) return;
  await advanceQueue(queueId);
}

/** 调度 tick 的兜底:扫所有暂停的队列成员,放开了却没人推的,补推一次。 */
export async function sweepReleasedQueueMembers(): Promise<void> {
  if (dbClient.closed) return;
  const paused = await db.select({ taskId: queueItems.taskId, queueId: queueItems.queueId })
    .from(queueItems).innerJoin(tasks, eq(tasks.id, queueItems.taskId))
    .where(eq(tasks.status, "paused"));
  for (const { taskId, queueId } of paused) {
    try {
      await releaseIfOwed(taskId, queueId);
    } catch (error) {
      console.error(`[ash] 等过哨兵的队列成员补推失败 task=${taskId}(下一次 tick 再来):`, error);
    }
  }
}

async function recheck(taskId: string): Promise<void> {
  if (dbClient.closed) return;
  const item = (await db.select({ queueId: queueItems.queueId }).from(queueItems)
    .where(eq(queueItems.taskId, taskId))).at(0);
  if (item) await releaseIfOwed(taskId, item.queueId);
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
      console.error(`[ash] 等哨兵的队列成员复查失败 task=${taskId}(调度 tick 会再扫到它):`, error);
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
