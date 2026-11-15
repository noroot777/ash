// 「派出的任务」格头那一对键：全部停下 / 接着跑。只管这一条名下（dispatched_by 整棵往下）的任务，
// 派活的那条自己不停（它有自己的停止键），同组里别处来的任务一条不碰。
//
// 停着这件事是一个持久事实，记在派活的那条任务上（tasks.dispatch_hold_at）；名下哪一条被按住、被谁
// 按住，各处的闸都问同一个判定（task-hold.ts）。所以停着期间新派出去的任务建得出来，但哪条路都起
// 不了它；刷新、重启之后还是停着。
//
// **停的手法照抄分组暂停**（scheduler.ts pauseGroup，审查打磨过的那一套），不另起一套：
//   ① 先把「停着」落库，再清点、扫成员 —— 起跑前最后一道闸（turn-freeze.ts）读的是持久事实，清点
//      之后才派出、才起跑的那些在闸上被拦住；
//   ② 在跑的杀掉、**结算成 paused**（不是 canceled：canceled 会被串行队列透明跳过、起下一条，
//      也接不回原会话）；排着的 queued 退回 backlog；回合已占位、进程还没起来的补一个起跑冻结
//      标记，由最后一道闸消费；
//   ③ 名下成员身上已经落库的队列推进请求一并作废（同 pauseGroup），重放不会把它们拉起来。
//
// **「接着跑」只兑现这次欠下的**：被上面那几步停掉的、以及停着期间轮到它却被闸拦下的（队列推进、
// 分组运行、起跑前那道闸、智能体调 run_task），各在任务上记一笔「欠一次起跑」（tasks.hold_owed_by，
// dispatch-hold-owed.ts）。接着跑时清掉停着的标记，把欠账逐条兑现：在队列里的推一下那条队列（按原
// 顺序从队首续），不在队列里的照分组运行拉起成员的做法从原会话续。账在真起跑或落终态时才销，此刻
// 起不来的由状态落位的监听与 tick 巡检接着兑现。到点启动退避的那一班不记账（责任在班次上，dispatch-hold-owed.ts）。
// 没欠账的一条不碰 —— 停之前就在等答复、等哨兵、被用户单独停掉、已经取消或失败的，接着跑之后还是原样。分组暂停和它互不相干：
// 兑现时分组还停着，起跑那道闸照样拦（分组恢复时由分组那边拉起）。
//
// 派活的那条被删掉：停着的标记跟着那一行没了，名下的任务不再被按住；欠账一并清掉、原地留着
// （已暂停 / 排着），不替用户把它们跑起来 —— 删一条任务不等于要它名下的活接着干。
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { hasCliGoalHold } from "@ash/shared/cli-commands";
import { bus } from "./bus.js";
import { db, dbClient } from "./db/index.js";
import { queueItems, tasks } from "./db/schema.js";
import { freezeStartingTurn, isRunning, isTurnClaimed, stopTask, type TurnIdentity } from "./runs.js";
import { setTaskStatus } from "./status.js";
import { notePauseOfTasks } from "./pause-generation.js";
import { forgetHeldStart, oweHeldStart, shiftAdmissionPending } from "./dispatch-hold-owed.js";
import { taskHoldOf } from "./task-hold.js";
import { publishTaskUpdated } from "./task-store.js";
import { republishWaitsOf } from "./pending-wait.js";
import { heldByMonitors } from "./queue-monitor-hold.js";
import { preparePendingCheckpointStart } from "./pending-checkpoint-recovery.js";
import { waitForStartReceipt } from "./task-start-receipt.js";
import { resumeOrRunTask } from "./task-resume.js";
import { now } from "./util.js";
import { startMember } from "./member-start.js";

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

/**
 * 全部停下。已经停着再按一次 = 再扫一遍（新派出去、刚被别处拉起来的也停下），标记的时刻不变。
 *
 * **先落「停着」、再清点名下**：清点之后才派出、才起跑的那一位，起跑之前一定读得到这个事实（自动
 * 起跑都过 turn-freeze.ts 的持久复查，智能体的 run_task 也是），清点之前就在跑的一定在名单里 ——
 * 不会有落在两边之外的。反过来（先清点再落标记）的话，清点途中新派出、落标记前已经起跑的那一位
 * 两头都够不着。
 *
 * **「停着」和「停完了」是两件事**：标记跟「还没停完」（dispatch_hold_pending_at）一起落，清点、逐条
 * 停掉都做完才清后者。中途哪一笔读写失败，路由报错，后者留着 —— 页面说「正在停下」、给「再停一次」，
 * 调度 tick 也会接着把没停完的停完（sweepPendingHolds）；不会出现「格头说已全部停下、底下还在跑、
 * 键却成了接着跑」（第 1 轮复审 F1）。
 */
export async function holdDispatched(holderId: string): Promise<HoldResult> {
  const pendingAt = now();
  await db.update(tasks).set({ dispatchHoldAt: sql`coalesce(${tasks.dispatchHoldAt}, ${pendingAt})`, dispatchHoldPendingAt: pendingAt })
    .where(eq(tasks.id, holderId));
  try {
    return await settleHold(holderId, pendingAt);
  } catch (error) {
    // 已经落下的「停着 / 还没停完」要让别的窗口也看见（它们据此说正在停下）。
    await publishTaskUpdated(holderId).catch(() => undefined);
    throw error;
  }
}

/** 清点名下、逐条停掉；全做完了才清「还没停完」（只清自己那一次落的：期间又按了一次的那一笔归它自己）。 */
async function settleHold(holderId: string, pendingAt: string): Promise<HoldResult> {
  const tree = await dispatchTree(holderId);
  if (tree.length) {
    await db.transaction(async (transaction) => {
      // 推进请求落了库、还没起跑的那一位：请求作废（同 pauseGroup），但它本来就该起跑 —— 记欠账。
      await transaction.update(tasks).set({ holdOwedBy: holderId })
        .where(and(inArray(tasks.id, tree), isNotNull(tasks.queueAdvanceRequest)));
      await transaction.update(tasks).set({ queueAdvanceRequest: null }).where(inArray(tasks.id, tree));
    }, { behavior: "immediate" });
  }
  notePauseOfTasks(tree, holderId);
  const holder = (await db.select({ title: tasks.title, holdAt: tasks.dispatchHoldAt }).from(tasks)
    .where(eq(tasks.id, holderId))).at(0);
  const hold = { byTaskId: holderId, byTitle: holder?.title ?? "" };
  for (const taskId of tree) {
    const row = (await db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, taskId))).at(0);
    if (!row) continue;
    const live = isRunning(taskId) || isTurnClaimed(taskId) || row.status === "running" || row.status === "queued";
    if (!live) continue;
    // 账先记、再停：停下这一刻起它就欠着，记不进去就别停（抛出去，「还没停完」留着，下一趟再来）。
    // 占着回合的是一班还没放行的到点启动：起跑的责任在班次上，只打撤回标记、不记账（dispatch-hold-owed.ts）。
    const shift = shiftAdmissionPending(taskId);
    if (!shift) await oweHeldStart(taskId, holderId);
    // 次序同 pauseGroup:status 可能在队列推进/续聊交错时短暂失真,有活 handle 就先杀。
    let stopped = stopTask(taskId, "paused");
    if (!stopped && row.status === "queued") {
      await setTaskStatus(taskId, "backlog");
      stopped = true;
    }
    if (!stopped) stopped = freezeStartingTurn(taskId, "paused", hold);
    // 到头来什么都没停到（刚好跑完、占着的不是回合）：它不欠这一次。
    if (!stopped && !shift) await forgetHeldStart(taskId, holderId);
  }
  await db.update(tasks).set({ dispatchHoldPendingAt: null })
    .where(and(eq(tasks.id, holderId), eq(tasks.dispatchHoldPendingAt, pendingAt)));
  await settleAnnouncements(holderId, tree);
  return { holdAt: holder?.holdAt ?? null, tree };
}

/** 调度 tick 的兜底：按了停、没停完的（中途出错、服务正好重启），接着停完。 */
export async function sweepPendingHolds(): Promise<void> {
  if (dbClient.closed) return;
  const pending = await db.select({ id: tasks.id, pendingAt: tasks.dispatchHoldPendingAt }).from(tasks)
    .where(and(isNotNull(tasks.dispatchHoldPendingAt), isNotNull(tasks.dispatchHoldAt)));
  for (const { id, pendingAt } of pending) {
    try {
      await settleHold(id, pendingAt!);
    } catch (error) {
      console.error(`[ash] 没停完的「全部停下」补停失败 holder=${id}(下一次 tick 再来):`, error);
    }
  }
}

/**
 * 接着跑。只清停着的标记，**不销账**：欠账逐条去兑现，此刻起不来的（还在退出、回合锁被占、起跑抛错）
 * 账还在，由状态落位的监听与调度 tick 的巡检接着兑现（dispatch-hold-owed.ts 文件头）。
 * 没停着就只是再兑现一遍（两个窗口各按一次，第二次不多起任何东西：起跑那道锁只认一个）。
 */
export async function releaseDispatched(holderId: string): Promise<HoldResult> {
  await db.update(tasks).set({ dispatchHoldAt: null, dispatchHoldPendingAt: null })
    .where(and(eq(tasks.id, holderId), isNotNull(tasks.dispatchHoldAt)));
  const tree = await dispatchTree(holderId);
  await settleAnnouncements(holderId, tree);
  const owed = await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.holdOwedBy, holderId));
  for (const { id } of owed) await honorOwedStart(id);
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
 * 兑现一笔欠账：按住它的那条已经不停着、它此刻接得上，就去起它。起不来就留着账，下一次再来 ——
 * 销账只在它真起跑或落终态那一刻（status.ts 经 holdOwedPatch）。
 *
 * 接得上 = 没归档、普通任务、停在 paused（不是在等答复、等 CLI 目标、等哨兵）或 backlog，也没被
 * 别处按住（分组暂停 / 另一条派活的按着：那边放开时由那边起它）。在队列里的，只在轮到它时推那条
 * 队列（原顺序不乱）；不在的照分组运行拉起成员的做法从原会话续。
 */
export async function honorOwedStart(taskId: string): Promise<void> {
  const row = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!row || !(await owedAndFree(row))) return;
  const item = (await db.select({ queueId: queueItems.queueId }).from(queueItems).where(eq(queueItems.taskId, taskId))).at(0);
  if (item) return honorInQueue(item.queueId, taskId);
  if (starting.has(taskId)) return;
  starting.add(taskId);
  // 组里的成员占分组的并发名额起（同分组运行），不然一组被按住的全部同时开跑；轮到之后在哪、
  // 起没起过由 member-start.ts 重读 —— 等名额期间进了队列的交回队列，换了组的按新组排。
  void startMember(row.groupId, taskId, {
    prepare: () => preparePendingCheckpointStart(taskId),
    eligible: owedAndFree,
    queued: (queueId) => honorInQueue(queueId, taskId),
    start: ({ owner }) => startOwed(taskId, owner),
  }).catch((error) => console.error(`[ash] 接着跑没能拉起 task=${taskId}(账还在，tick 会再试):`, error))
    .finally(() => starting.delete(taskId));
}

/** 账还挂着（没被别处的起跑销掉）、按住它的那条已经放开、它此刻接得上、也没被别处按住。 */
async function owedAndFree(row: TaskRow): Promise<boolean> {
  if (!row.holdOwedBy) return false;
  const holder = (await db.select({ holdAt: tasks.dispatchHoldAt }).from(tasks).where(eq(tasks.id, row.holdOwedBy))).at(0);
  return !holder?.holdAt && await canResume(row) && !(await taskHoldOf(row));
}

/** 在队列里的：只在轮到它时推那条队列（原顺序不乱），没轮到就等前面的做完、由队列推进起它。 */
async function honorInQueue(queueId: string, taskId: string): Promise<void> {
  const { advanceQueue, pickNextLaunchable } = await import("./scheduler.js");
  if ((await pickNextLaunchable(queueId))?.id === taskId) await advanceQueue(queueId);
}

/** 这一刻正在由本进程拉起的那几位：监听、巡检、接着跑同时来时只起一次。 */
const starting = new Set<string>();

/** 调度 tick 的兜底：按住它的已经放开、账还挂着的，再兑现一次（重启之后同样由它接上）。 */
export async function sweepOwedStarts(): Promise<void> {
  if (dbClient.closed) return;
  const owed = await db.select({ id: tasks.id }).from(tasks).where(isNotNull(tasks.holdOwedBy));
  for (const { id } of owed) {
    try {
      await honorOwedStart(id);
    } catch (error) {
      console.error(`[ash] 欠着的起跑兑现失败 task=${id}(下一次 tick 再来):`, error);
    }
  }
}

async function canResume(row: TaskRow): Promise<boolean> {
  if (row.archived || row.mode !== "single") return false;
  if (row.status === "backlog") return true;
  if (row.status !== "paused" || row.question || hasCliGoalHold(row.cliState)) return false;
  return !(await heldByMonitors(row.id));
}

/** 不在队列里的那一位，占好位之后：照分组运行拉起成员的做法从原会话续（scheduler.ts runParallel）。 */
async function startOwed(taskId: string, owner: TurnIdentity): Promise<void> {
  let run!: Promise<void>;
  await waitForStartReceipt(taskId, () => {
    run = resumeOrRunTask(taskId, { origin: "auto", reason: "hold", turnHeld: owner });
    run.catch(() => {});
    return run;
  });
  await run;
}

// 被停下的那一位真正落到 paused / backlog 的那一刻（停止请求返回时它多半还在退出），按住它的那条
// 可能已经放开了：当场兑现，不等下一次 tick。**加载本模块就装上**（路由与删除都静态依赖它）。
bus.subscribe((event) => {
  if (event.type !== "task.status" || (event.status !== "paused" && event.status !== "backlog")) return;
  void honorOwedStart(event.taskId).catch((error) => console.error(`[ash] 欠着的起跑兑现失败 task=${event.taskId}:`, error));
});
