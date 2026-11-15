// 「派出的任务」格头那一对键：全部停下 / 接着跑。只管这一条名下（dispatched_by 整棵往下）的任务，
// 派活的那条自己不停（它有自己的停止键），同组里别处来的任务一条不碰。
//
// 停着这件事是一个持久事实，记在派活的那条任务上（tasks.dispatch_hold_at）；名下哪一条被按住、被谁
// 按住，各处的闸都问同一个判定（task-hold.ts）。所以停着期间新派出去的任务建得出来，但哪条路都起
// 不了它；刷新、重启之后还是停着。
//
// **停的手法照抄分组暂停**（scheduler.ts pauseGroup，审查打磨过的那一套），不另起一套：
//   ① 先把「停着」落库，再扫成员 —— 起跑前最后一道闸（turn-freeze.ts）读的是持久事实，扫描之后
//      才起跑的那些在闸上被拦住；
//   ② 在跑的杀掉、**结算成 paused**（不是 canceled：canceled 会被串行队列透明跳过、起下一条，
//      也接不回原会话）；排着的 queued 退回 backlog；回合已占位、进程还没起来的补一个起跑冻结
//      标记，由最后一道闸消费；
//   ③ 名下成员身上已经落库的队列推进请求一并作废（同 pauseGroup），重放不会把它们拉起来。
//
// **「接着跑」只兑现这次欠下的**：被上面那几步停掉的、以及停着期间轮到它却被闸拦下的（队列推进、
// 分组运行、起跑前那道闸、智能体调 run_task），各在任务上记一笔「欠一次起跑」（tasks.hold_owed_by，
// dispatch-hold-owed.ts）。接着跑时清掉停着的标记，把欠账逐条兑现：在队列里的推一下那条队列（按原
// 顺序从队首续），不在队列里的照分组运行拉起成员的做法从原会话续。没欠账的一条不碰 —— 停之前就在
// 等答复、等哨兵、被用户单独停掉、已经取消或失败的，接着跑之后还是原样。分组暂停和它互不相干：
// 兑现时分组还停着，起跑那道闸照样拦（分组恢复时由分组那边拉起）。
//
// 派活的那条被删掉：停着的标记跟着那一行没了，名下的任务不再被按住；欠账一并清掉、原地留着
// （已暂停 / 排着），不替用户把它们跑起来 —— 删一条任务不等于要它名下的活接着干。
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { hasCliGoalHold } from "@ash/shared/cli-commands";
import { db } from "./db/index.js";
import { queueItems, tasks } from "./db/schema.js";
import { claimOwnTurn, freezeStartingTurn, releaseTurn, stopTask } from "./runs.js";
import { setTaskStatus } from "./status.js";
import { notePauseOfTasks } from "./pause-generation.js";
import { oweHeldStart } from "./dispatch-hold-owed.js";
import { publishTaskUpdated } from "./task-store.js";
import { republishWaitsOf } from "./pending-wait.js";
import { heldByMonitors } from "./queue-monitor-hold.js";
import { preparePendingCheckpointStart } from "./pending-checkpoint-recovery.js";
import { reserveQueuedTask, restoreQueuedTask, taskQueueReservation } from "./task-queue-reservation.js";
import { waitForStartReceipt } from "./task-start-receipt.js";
import { resumeOrRunTask } from "./task-resume.js";
import { now } from "./util.js";

type TaskRow = typeof tasks.$inferSelect;

/** 名下整棵往下（不含自己），按层。和侧栏那个数同一个口径：顺着 dispatched_by 走，归档的照样走得过去。 */
export async function dispatchTree(holderId: string): Promise<string[]> {
  const seen = new Set([holderId]);
  const result: string[] = [];
  let level = [holderId];
  while (level.length) {
    const rows = await db.select({ id: tasks.id }).from(tasks)
      .where(and(inArray(tasks.dispatchedBy, level), isNull(tasks.parentId)));
    level = rows.map((row) => row.id).filter((id) => !seen.has(id));
    for (const id of level) {
      seen.add(id);
      result.push(id);
    }
  }
  return result;
}

export type HoldResult = { holdAt: string | null; tree: string[] };

/** 全部停下。已经停着再按一次 = 再扫一遍（新派出去、刚被别处拉起来的也停下），标记的时刻不变。 */
export async function holdDispatched(holderId: string): Promise<HoldResult> {
  const tree = await dispatchTree(holderId);
  const holdAt = now();
  await db.transaction(async (transaction) => {
    await transaction.update(tasks).set({ dispatchHoldAt: holdAt })
      .where(and(eq(tasks.id, holderId), isNull(tasks.dispatchHoldAt)));
    if (!tree.length) return;
    // 推进请求落了库、还没起跑的那一位：请求作废（同 pauseGroup），但它本来就该起跑 —— 记欠账。
    await transaction.update(tasks).set({ holdOwedBy: holderId })
      .where(and(inArray(tasks.id, tree), isNotNull(tasks.queueAdvanceRequest)));
    await transaction.update(tasks).set({ queueAdvanceRequest: null }).where(inArray(tasks.id, tree));
  }, { behavior: "immediate" });
  notePauseOfTasks(tree);
  const holder = (await db.select({ title: tasks.title, holdAt: tasks.dispatchHoldAt }).from(tasks)
    .where(eq(tasks.id, holderId))).at(0);
  const hold = { byTaskId: holderId, byTitle: holder?.title ?? "" };
  for (const taskId of tree) {
    const row = (await db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, taskId))).at(0);
    if (!row) continue;
    // 次序同 pauseGroup:status 可能在队列推进/续聊交错时短暂失真,有活 handle 就先杀。
    let stopped = stopTask(taskId, "paused");
    if (!stopped && row.status === "queued") {
      await setTaskStatus(taskId, "backlog");
      stopped = true;
    }
    if (!stopped) stopped = freezeStartingTurn(taskId, "paused", hold);
    if (stopped) await oweHeldStart(taskId, holderId);
  }
  await settleAnnouncements(holderId, tree);
  return { holdAt: holder?.holdAt ?? null, tree };
}

/** 接着跑。没停着就什么都不做（两个窗口各按一次，第二次是空操作）。 */
export async function releaseDispatched(holderId: string): Promise<HoldResult> {
  const owed = await db.transaction(async (transaction) => {
    const cleared = await transaction.update(tasks).set({ dispatchHoldAt: null })
      .where(and(eq(tasks.id, holderId), isNotNull(tasks.dispatchHoldAt))).returning({ id: tasks.id });
    if (!cleared.length) return null;
    const rows = await transaction.select().from(tasks).where(eq(tasks.holdOwedBy, holderId));
    await transaction.update(tasks).set({ holdOwedBy: null }).where(eq(tasks.holdOwedBy, holderId));
    return rows;
  }, { behavior: "immediate" });
  const tree = await dispatchTree(holderId);
  if (owed === null) return { holdAt: null, tree };
  await settleAnnouncements(holderId, tree);
  await honorOwedStarts(owed);
  // 停着期间排下的执行型消息（停下之前在跑时用户排的话、答复）照常送：投递那边自己判轮没轮到。
  void import("./pending-messages.js").then(({ deliverPendingMessages }) =>
    Promise.all(tree.map((taskId) => deliverPendingMessages(taskId).catch(() => undefined))));
  return { holdAt: null, tree };
}

/** 停 / 续之后，别的窗口要跟着变：派活那条的标记、名下各条托盘上的等待说法。 */
async function settleAnnouncements(holderId: string, tree: readonly string[]): Promise<void> {
  await publishTaskUpdated(holderId).catch((error) => console.error(`[ash] 广播停 / 续失败 task=${holderId}:`, error));
  await republishWaitsOf(tree).catch((error) => console.error(`[ash] 托盘等待说法刷新失败 holder=${holderId}:`, error));
}

/**
 * 欠账兑现。还能接着跑的：没归档、普通任务、停在 paused（不是在等答复、等 CLI 目标、等哨兵）或
 * backlog。在队列里的推那条队列（队首是谁由队列自己挑，原顺序不乱）；不在的从原会话续。
 */
async function honorOwedStarts(owed: readonly TaskRow[]): Promise<void> {
  const { advanceQueueInBackground } = await import("./scheduler.js");
  const queues = new Set<string>();
  for (const row of owed) {
    if (!(await canResume(row))) continue;
    const item = (await db.select({ queueId: queueItems.queueId }).from(queueItems).where(eq(queueItems.taskId, row.id))).at(0);
    if (item) queues.add(item.queueId);
    else void startOwed(row.id);
  }
  for (const queueId of queues) advanceQueueInBackground(queueId);
}

async function canResume(row: TaskRow): Promise<boolean> {
  if (row.archived || row.mode !== "single") return false;
  if (row.status === "backlog") return true;
  if (row.status !== "paused" || row.question || hasCliGoalHold(row.cliState)) return false;
  return !(await heldByMonitors(row.id));
}

/** 不在队列里的那一位：照分组运行拉起成员的做法（scheduler.ts runParallel 的 launch）。 */
async function startOwed(taskId: string): Promise<void> {
  try {
    if (await preparePendingCheckpointStart(taskId)) return;
    const before = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
    if (!before || !(await canResume(before))) return;
    const owner = claimOwnTurn(taskId);
    if (!owner) return;
    const reservation = taskQueueReservation(before);
    try {
      await reserveQueuedTask(reservation);
      let run!: Promise<void>;
      await waitForStartReceipt(taskId, () => {
        run = resumeOrRunTask(taskId, { reason: "hold", turnHeld: owner });
        run.catch(() => {});
        return run;
      });
      await run;
    } finally {
      releaseTurn(taskId, owner);
      await restoreQueuedTask(reservation);
    }
  } catch (error) {
    console.error(`[ash] 接着跑没能拉起 task=${taskId}:`, error);
  }
}
