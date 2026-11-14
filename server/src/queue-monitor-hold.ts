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
// 「这一段暂停确实等过哨兵」记在任务那一行的 `monitor_hold_at` 上,**跟状态同一条 UPDATE 写、
// 同一条 UPDATE 消费**(`monitorHoldPatch`,由 status.ts 每一笔状态写入调用):
//   · 落检查点(非 quiet 的 paused):此刻在等哨兵就盖上,不在等就清掉;
//   · 旁路回合起跑、旁路回合结束 quiet 落回 paused:「回到原样」,已有的不动 —— 压缩一次上下文
//     不该把「在等」抹掉(第 4 轮审查 1A:早先按会话行的起点推断,旁路回合会覆写那一行);
//   · 执行回合起跑(哨兵结果叫醒、队列续跑、手点运行)、落终态:清掉 —— 这一段暂停到此为止。
// 它只由「此刻在等」盖上,而「在等」用的是完成闸那一个集合:不挡执行的审查哨兵、被动投影都不在
// 里面,停掉它们不会凭空让一个静止的检查点欠出一次推进(第 4 轮审查 1B)。不比任何时间先后。
//
// 补推:`monitor_hold_at` 还在、此刻已经不在等、它又正好轮到 ⇒ 推一次;推进起跑的那个执行回合
// 把它清掉,所以只兑现一次。哨兵每一次了结都发 `task.monitors`、结果进出托盘都发
// `task.pendingMessages`,下面的监听当场复查;最后一个哨兵了结后不保证还有下一条事件、复查也可能
// 撞上读失败,所以 30 秒的调度 tick 再扫一遍所有暂停的队列成员(`sweepReleasedQueueMembers`),
// 重启之后同样由它接上。
//
// 存量:升级前就停在那儿等哨兵的行没有这一笔。队列每次读成员看到「在等、却没盖」就补盖上
// (`withMonitorHolds`,条件写在同一段暂停上:状态仍是 paused、方向世代没变),开机补办与每一次
// tick 都会读到它。
import { and, eq, isNull } from "drizzle-orm";
import type { TaskStatus } from "@ash/shared";
import { bus } from "./bus.js";
import { db, dbClient } from "./db/index.js";
import { groups, queueItems, tasks } from "./db/schema.js";
import { now } from "./util.js";

type TaskRow = typeof tasks.$inferSelect;
export type QueueRow = TaskRow & { monitorHold: boolean };

/** 名下还有没了结的哨兵吗(判据本体见 task-complete-monitors.ts 的 `hasUnsettledMonitors`)。 */
export async function heldByMonitors(taskId: string): Promise<boolean> {
  // 动态 import:task-complete-monitors 拖着整套哨兵模块,scheduler 静态加载它会绕成环。
  const { hasUnsettledMonitors } = await import("./task-complete-monitors.js");
  return hasUnsettledMonitors(taskId);
}

/** 读不出来就返回 null,由调用方按自己那一档决定保守方向。 */
async function heldOrUnknown(taskId: string): Promise<boolean | null> {
  try {
    return await heldByMonitors(taskId);
  } catch (error) {
    console.error(`[ash] 读哨兵责任失败 task=${taskId}:`, error);
    return null;
  }
}

/** 跟这一笔状态写入同一条 UPDATE 落下的 `monitor_hold_at`(规则见文件头)。空对象 = 不动它。 */
export async function monitorHoldPatch(
  taskId: string, cur: TaskRow | undefined, status: TaskStatus, opts: { quiet: boolean; sideTurn: boolean },
): Promise<{ monitorHoldAt?: string | null }> {
  if (status === "done" || status === "failed" || status === "canceled") return { monitorHoldAt: null };
  if (status === "running" && !opts.sideTurn) return { monitorHoldAt: null };
  if (status === "paused" && !opts.quiet) {
    // 读不出来就当在等:多盖一笔的代价是一次幂等的推进(没在等的检查点本来就被状态钩子续跑),
    // 少盖一笔就是队列停死。
    return { monitorHoldAt: await heldOrUnknown(taskId) === false ? null : now() };
  }
  if (status === "running" || status === "paused") {
    // 旁路回合进出:回到原样。已经盖了的不动;没盖、此刻却在等的(存量)顺手补上。
    if (cur?.monitorHoldAt) return {};
    return await heldOrUnknown(taskId) ? { monitorHoldAt: now() } : {};
  }
  return {};
}

/**
 * 给成员标上「在等哨兵」。只有 paused 的才问 —— 别的状态另有说法。队列推进与分组运行都从这里
 * 读,自动续跑的入口用的是同一份判据。在等却还没盖 `monitor_hold_at` 的(存量)顺手补上。
 */
export async function withMonitorHolds(rows: TaskRow[]): Promise<QueueRow[]> {
  const out: QueueRow[] = [];
  for (const row of rows) {
    const monitorHold = row.status === "paused" && !row.archived && await heldByMonitors(row.id);
    if (monitorHold && !row.monitorHoldAt) await stampHold(row);
    out.push({ ...row, monitorHold });
  }
  return out;
}

async function stampHold(row: TaskRow): Promise<void> {
  try {
    await db.update(tasks).set({ monitorHoldAt: now() }).where(and(
      eq(tasks.id, row.id), eq(tasks.status, "paused"), eq(tasks.directionEpoch, row.directionEpoch),
      isNull(tasks.monitorHoldAt),
    ));
  } catch (error) {
    console.error(`[ash] 补记「在等哨兵」失败 task=${row.id}(下一次读到再补):`, error);
  }
}

/** 这一位等过哨兵、现在放开了、又正好轮到它 ⇒ 推一次。 */
async function releaseIfOwed(taskId: string, queueId: string): Promise<void> {
  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (task?.status !== "paused" || task.archived) return;
  if (await heldByMonitors(taskId)) {
    if (!task.monitorHoldAt) await stampHold(task);
    return;
  }
  if (!task.monitorHoldAt) return;
  if (task.groupId) {
    const group = (await db.select({ paused: groups.paused }).from(groups).where(eq(groups.id, task.groupId))).at(0);
    if (group?.paused) return;
  }
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
