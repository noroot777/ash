// 有前置的任务怎么起跑：被要求起跑而前置没站齐时记下「等齐就起」，前置全部站稳的那一刻自动起跑，
// 起点按起跑那一刻全部前置的代码定（prerequisite-start-point.ts）。
//
// 起跑前那一问（`holdForPrerequisites`）住在 prerequisite-gate.ts：它回 null 就照原路起跑；回一个原因就不起，
// 而且这一次「被要求起跑」已经持久地记下了（`task_prerequisite_launches.requested_at`）。队列和前置
// 两边都放行才起：队列不放行时根本走不到闸上；走到闸上而前置没齐，队首就停着等。这份文件管的是「等齐之后」。
//
// 闸只管**第一次开工**：起点一旦按前置定下来（`launched_at`），之后的运行、续聊、重试都不再看前置 ——
// 代码已经在它手里了，前置后来再动也不打断它（页面上会说「开工后又有新提交」）。
//
// ## 「站稳了」的统一出口
//
// `notePrerequisiteProgress(前置 id)` 是唯一的出口：执行结算、审查结算（通过 / 轮数用尽）、用户裁定、
// 验收、删除都调它，事件总线上这条前置的状态 / 审查一变也调它。它做两件事：下游页面上那一格重发；
// 挂着「等齐就起」的下游重判一遍，齐了就起。判定本身幂等，多调几次不会多起一次（真正起跑还要过回合锁
// 与队列占位）。
//
// 重启之后：记账是持久的，开机补办扫一遍全部挂着的请求（重启期间站稳的就在这一趟起跑），之后每分钟
// 再扫一遍兜底 —— 哪个出口漏调了，最多晚一分钟。
//
// ## 起跑这一侧的规矩
//
// 前置失败、取消了：它不站稳，下游一直等，**不跳过**（跟队列透明跳过 failed 相反：下游要的是它的代码）。
// 分组暂停着的不起。同时在跑的名额跟分组运行共用一份（launch-slots.ts），名额满了就等有人跑完再补放。
// 下游自己被移进队列的，交给队列推进。
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { db, dbClient } from "./db/index.js";
import { groups, queueItems, scheduledMessages, taskPrerequisiteLaunches, tasks } from "./db/schema.js";
import { bus } from "./bus.js";
import { prerequisiteStandings } from "./prerequisite-standing.js";
import { dependentEdges, launchRecord, prerequisiteEdges } from "./prerequisite-store.js";
import { holdForPrerequisitesLocked, withPrerequisiteLock } from "./prerequisite-gate.js";
import { appendTaskTimeline, receiptLine } from "./task-timeline.js";
import { forgetStanding, isRepublishingView, republishPrerequisiteView } from "./prerequisite-view.js";
import { freeSlot, onSlotFreed, takeSlot } from "./launch-slots.js";

export { holdForPrerequisites, type LaunchSource, type PrerequisiteHold } from "./prerequisite-gate.js";

// ── 放行 ─────────────────────────────────────────────────────────────────────

const pending = new Map<string, NodeJS.Timeout>();

/**
 * 「这条前置可能变了」的统一出口（见文件头）。短暂合并一下：一次结算往往连着发好几个事件。
 * 前置被删时调用方自己带上下游名单（删完就查不到谁建在它上面了）。
 */
export function notePrerequisiteProgress(prerequisiteId: string, dependents?: string[]): void {
  forgetStanding(prerequisiteId);
  const key = dependents ? `${prerequisiteId}:${dependents.join(",")}` : prerequisiteId;
  if (pending.has(key)) return;
  pending.set(key, setTimeout(() => {
    pending.delete(key);
    void progress(prerequisiteId, dependents).catch((error) => console.error(`[ash] 前置 ${prerequisiteId} 推进下游失败:`, error));
  }, 150).unref());
}

async function progress(prerequisiteId: string, known?: string[]): Promise<void> {
  const dependents = known ?? (await dependentEdges(prerequisiteId)).map((edge) => edge.taskId);
  if (!dependents.length) return;
  await republishPrerequisiteView(dependents);
  for (const taskId of dependents) await releaseOne(taskId);
}

/** 一条挂着「等齐就起」的下游：齐了就起。不齐、分组暂停、名额满了、已经起过的都原样留着。 */
async function releaseOne(taskId: string): Promise<void> {
  const launch = await launchRecord(taskId);
  if (!launch?.requestedAt) return;
  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!task || task.archived || task.status !== "backlog") {
    // 已经从别处起跑了（或者没了）：这笔请求了结。
    await db.update(taskPrerequisiteLaunches).set({ requestedAt: null }).where(eq(taskPrerequisiteLaunches.taskId, taskId));
    if (task) await republishPrerequisiteView([taskId]);
    return;
  }
  if (task.groupId && (await db.select({ paused: groups.paused }).from(groups).where(eq(groups.id, task.groupId))).at(0)?.paused) return;
  const edges = await prerequisiteEdges(taskId);
  if (edges.length && !launch.launchedAt) {
    const standings = await prerequisiteStandings(edges.map((edge) => edge.prerequisiteId));
    if (edges.some((edge) => standings.get(edge.prerequisiteId)?.standing.step !== "settled")) return;
  }
  const queue = (await db.select().from(queueItems).where(eq(queueItems.taskId, taskId))).at(0);
  if (queue) {
    const { advanceQueueInBackground } = await import("./scheduler.js");
    advanceQueueInBackground(queue.queueId);
    return;
  }
  // 名额先占后做事：查和占之间没有 await，几路同时放行也不会一起越过上限（launch-slots.ts）。
  if (!takeSlot(task.groupId, taskId)) return;
  let handed = false;
  try {
    const { claimOwnTurn, releaseTurn } = await import("./runs.js");
    const { isAcceptingTask } = await import("./acceptance-lock.js");
    // 「请求还在 → 认领回合 → 定起点」在同一把锁里做完，跟停止键（withdrawPrerequisiteRequest）排成先后：
    // 锁外读到的那份请求可能已经被撤回了，锁里重读一遍才算数；认领之后再来的停止，冻住的是这一次起跑。
    const claimed = await withPrerequisiteLock(taskId, async () => {
      const current = await launchRecord(taskId);
      if (!current?.requestedAt) return null;
      const turn = claimOwnTurn(taskId, "single");
      if (!turn) return null;
      if (isAcceptingTask(taskId) || await holdForPrerequisitesLocked(taskId, { source: "release", actingUserId: current.actingUserId })) {
        releaseTurn(taskId, turn);
        return null;
      }
      return { turn, actingUserId: current.actingUserId };
    });
    if (!claimed) return;
    const { seatThenStart } = await import("./queue-seat.js");
    const { resumeOrRunTask } = await import("./task-resume.js");
    let run: Promise<void> | null = null;
    const started = await seatThenStart(taskId, claimed.turn, () => {
      run = resumeOrRunTask(taskId, { reason: "wake", turnHeld: claimed.turn, actingUserId: claimed.actingUserId });
      return run;
    });
    if (!started.ok) return;
    await db.update(taskPrerequisiteLaunches).set({ requestedAt: null }).where(eq(taskPrerequisiteLaunches.taskId, taskId));
    handed = true;
    const settle = () => freeSlot(task.groupId, taskId);
    if (run) void (run as Promise<void>).then(settle, settle);
    else settle();
  } finally {
    if (!handed) freeSlot(task.groupId, taskId);
  }
}

/**
 * 停止键撤回「等齐就起」：还没起跑（backlog）、挂着请求的才撤。留一行记录、页面上的「在等」随之消失，
 * 刷新之后也看得出停过 —— 从没跑过的任务没有会话可写时间线，记成任务历史里的一条。
 *
 * 放行那一路已经认领了回合、正要起跑的（锁里认领，见 releaseOne），把那一次起跑冻住：它在拉起执行器
 * 之前的最后一道闸上撤回（turn-lock.ts `freezeStartingTurn`）。返回 `starting`，由调用方照「停一个正在
 * 起跑的回合」那一套收尾；撤了、没在起跑返回 `withdrawn`；没有可撤的返回 null。
 */
export async function withdrawPrerequisiteRequest(taskId: string): Promise<"withdrawn" | "starting" | null> {
  return withPrerequisiteLock(taskId, async () => {
    const task = (await db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, taskId))).at(0);
    const record = await launchRecord(taskId);
    if (task?.status !== "backlog" || !record?.requestedAt) return null;
    const { freezeStartingTurn, isTurnClaimed } = await import("./runs.js");
    const starting = isTurnClaimed(taskId) && freezeStartingTurn(taskId, "canceled");
    await db.update(taskPrerequisiteLaunches).set({ requestedAt: null, blocked: null }).where(eq(taskPrerequisiteLaunches.taskId, taskId));
    // 等着跟它一起开工的回复（执行型待发送）一并撤掉，否则下一次投递扫描又把请求挂回去；原文照抄进时间线。
    const { cancelPendingMessage } = await import("./pending-messages.js");
    const stashed = await db.select().from(scheduledMessages).where(and(eq(scheduledMessages.taskId, taskId),
      eq(scheduledMessages.status, "pending"), eq(scheduledMessages.execution, true), isNull(scheduledMessages.deliveringSince)));
    for (const message of stashed) await cancelPendingMessage(message, "停止了「前置站齐就开工」");
    const text = "已停止：不再等前置站齐自动开工。要开工再点运行。";
    if (!await appendTaskTimeline(taskId, receiptLine(text))) {
      const { noteSystemNotice } = await import("./user-action-rejection.js");
      await noteSystemNotice(taskId, `prerequisite-withdrawn:${record.requestedAt}`, "停止", text);
    }
    await republishPrerequisiteView([taskId]);
    return starting ? "starting" : "withdrawn";
  });
}

/** 全部挂着的请求扫一遍：开机补办、定时兜底、有一条放出来的跑完腾出位置时都走这里。 */
export async function sweepPrerequisiteLaunches(): Promise<void> {
  if (dbClient.closed) return; // 进程收尾（测试关库、server 退出）时迟到的那一扫
  const rows = await db.select({ taskId: taskPrerequisiteLaunches.taskId }).from(taskPrerequisiteLaunches)
    .where(isNotNull(taskPrerequisiteLaunches.requestedAt));
  for (const { taskId } of rows) {
    await releaseOne(taskId).catch((error) => { if (!dbClient.closed) console.error(`[ash] 等齐就起补办失败 task=${taskId}:`, error); });
  }
}

let sweepTimer: NodeJS.Timeout | null = null;
function sweepSoon(): void {
  if (sweepTimer) return;
  sweepTimer = setTimeout(() => {
    sweepTimer = null;
    void sweepPrerequisiteLaunches().catch((error) => console.error("[ash] 等齐就起扫描失败:", error));
  }, 500);
  sweepTimer.unref();
}

let started = false;
/** 开机调一次：补办重启期间站稳的、挂上事件总线、每分钟兜底扫一遍。 */
export async function startPrerequisiteLaunches(intervalMs = 60_000): Promise<void> {
  if (started) return;
  started = true;
  bus.subscribe((event) => {
    if (event.type === "task.status" || event.type === "task.review") notePrerequisiteProgress(event.taskId);
    else if (event.type === "task.updated" && !isRepublishingView(event.task.id)) notePrerequisiteProgress(event.task.id);
  });
  // 名额空出来（不论是放行的还是分组运行的那一位跑完）就补放被名额挡住的。
  onSlotFreed(sweepSoon);
  await sweepPrerequisiteLaunches();
  setInterval(() => void sweepPrerequisiteLaunches().catch((error) => console.error("[ash] 等齐就起扫描失败:", error)), intervalMs).unref();
}
