// 自动开工只有这一条路、这一份账：一条任务被要求「轮到了就开工」时，在它身上挂一笔持久的开工请求
// （task_prerequisite_launches.requested_at），由这里唯一的放行口（`releaseLaunch`）判、起。
//
// 挂请求的来路：
//   · 前置没站齐时被要求起跑（点运行、队列 / 分组轮到它、底层起跑闸，prerequisite-gate.ts `recordRequest`）；
//   · 「运行分组」：这一刻该起的成员各挂一笔（scheduler.ts runGroup）—— 团队派执行者、恢复分组都走它；
//   · 派活单派出：跟建任务同一笔事务挂上（dispatch-plan-launch.ts）；
//   · 「接着跑」兑现不在队列里的欠账（dispatch-hold.ts）。
// 队列推进不走这里：它按位置一个接一个起，不占名额，自己有一份持久的推进意图（scheduler.ts advanceQueue）。
//
// 放行（`releaseLaunch`，幂等，多调几次不会多起一次）：请求还在 → 任务还该被自动起（backlog；或者是被打断、
// 没留下续跑交代的 paused）→ 没被按住（分组暂停 / 名下全部停下：请求原样留着，放开时照请求起）→ 前置都站稳
// → 不在队列里（在的交给队列）→ 同组名额没满（launch-capacity.ts：数的是此刻占着执行回合的条数，数完当场
// 认领）。认领之后在前置锁里重读一遍请求和任务（停止键排在同一把锁上；这期间别处起过、跑完的这里看得见），
// 定起点，交给 seatThenStart。只认真实启动回执：没起来的退避再试，连着起不来到顶就撤掉请求、留一句交代。
//
// 什么时候判：开机补办扫一遍；任何一把回合锁放开时（名额可能空出来了，turn-release.ts）；前置有进展时
// （prerequisite-launch.ts）；分组恢复 / 名下放开时；每分钟兜底扫一遍。进程内的定时器只决定「什么时候再看
// 一眼」，「该不该起」永远读库里的请求。
import { and, asc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { hasCliGoalHold } from "@ash/shared/cli-commands";
import { db, dbClient } from "./db/index.js";
import { queueItems, scheduledMessages, taskPrerequisiteLaunches, tasks } from "./db/schema.js";
import { prerequisiteStandings } from "./prerequisite-standing.js";
import { launchRecord, prerequisiteEdges } from "./prerequisite-store.js";
import { holdForPrerequisitesLocked, withPrerequisiteLock, type LaunchSource } from "./prerequisite-gate.js";
import { appendTaskTimeline, receiptLine } from "./task-timeline.js";
import { republishPrerequisiteView } from "./prerequisite-view.js";
import { claimLaunchTurn, PARALLEL_LIMIT, runningInGroup } from "./launch-capacity.js";
import { taskHoldOf } from "./task-hold.js";
import { heldByMonitors } from "./queue-monitor-hold.js";
import type { TurnIdentity } from "./turn-lock.js";
import { onTurnReleasedAlso } from "./turn-release.js";
import { now } from "./util.js";

type TaskRow = typeof tasks.$inferSelect;
type Writer = Pick<typeof db, "insert">;

/** 连着起不来几次就不再自动试：撤掉请求、留一句交代，等人处理后再点运行。 */
export const MAX_START_ATTEMPTS = 3;
/** 第 n 次起不来之后隔多久再试：30 秒、2 分钟。 */
let retryBaseMs = 30_000;
const retryDelay = (failures: number) => retryBaseMs * 4 ** (failures - 1);
/** 回归用例把退避缩短到毫秒级（不然一条「连着起不来」要等两分半）。 */
export function setLaunchRetryBase(ms: number): void {
  retryBaseMs = ms;
}

// ── 挂请求 ───────────────────────────────────────────────────────────────────

/**
 * 给这几条任务挂上开工请求（已经挂着的不动它的时刻和来由）。重新被要求一次就清掉上一轮「起不来」的退避，
 * 当成新的一次请求。`writer` 传事务就跟调用方那一笔一起提交（派活单、接着跑）。
 */
export async function requestLaunch(taskIds: string[], request: { source: LaunchSource | "hold"; actingUserId?: string | null }, writer: Writer = db): Promise<void> {
  if (!taskIds.length) return;
  const at = now();
  await writer.insert(taskPrerequisiteLaunches)
    .values(taskIds.map((taskId) => ({ taskId, requestedAt: at, source: request.source, actingUserId: request.actingUserId ?? null })))
    .onConflictDoUpdate({
      target: taskPrerequisiteLaunches.taskId,
      set: {
        source: sql`CASE WHEN ${taskPrerequisiteLaunches.requestedAt} IS NULL THEN excluded.source ELSE ${taskPrerequisiteLaunches.source} END`,
        actingUserId: sql`CASE WHEN ${taskPrerequisiteLaunches.requestedAt} IS NULL THEN excluded.acting_user_id ELSE ${taskPrerequisiteLaunches.actingUserId} END`,
        requestedAt: sql`COALESCE(${taskPrerequisiteLaunches.requestedAt}, excluded.requested_at)`,
        startFailures: 0,
        retryAt: null,
      },
    });
}

/** 这笔请求了结（起了，或者它已经不该被自动起了）。 */
async function settleRequest(taskId: string): Promise<void> {
  await db.update(taskPrerequisiteLaunches).set({ requestedAt: null, startFailures: 0, retryAt: null })
    .where(eq(taskPrerequisiteLaunches.taskId, taskId));
}

// ── 放行 ─────────────────────────────────────────────────────────────────────

/**
 * 它此刻还该被自动起吗。backlog 一律该；paused 只认「被打断、会自己接着跑」的那种：在等答复、等 CLI 目标、
 * 等哨兵的由叫醒它的那件事起；带着续跑交代的检查点暂停只有「接着跑」兑现时才起（那一笔就是停下时欠的）。
 */
async function awaitsLaunch(task: TaskRow, source: string | null): Promise<boolean> {
  if (task.archived || task.mode === "team") return false;
  if (task.status === "backlog") return true;
  if (task.status !== "paused" || task.question || hasCliGoalHold(task.cliState)) return false;
  if (task.resumePrompt && source !== "hold") return false;
  return !(await heldByMonitors(task.id));
}

const readTask = async (taskId: string) => (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0) ?? null;

/** 一条挂着请求的任务：该起、能起就起。不该起了的了结请求；该起而此刻起不了的原样留着。 */
export async function releaseLaunch(taskId: string): Promise<void> {
  if (booting) return; // 开机还没接回在跑的回合：此刻数名额会少数，等 startLaunchRequests 那一扫
  const launch = await launchRecord(taskId);
  if (!launch?.requestedAt) return;
  if (launch.retryAt && launch.retryAt > now()) return retryAt(taskId, launch.retryAt);
  const task = await readTask(taskId);
  if (!task || !(await awaitsLaunch(task, launch.source))) {
    // 已经从别处起跑了、跑完了、没了：这笔请求了结。
    await settleRequest(taskId);
    if (task) await republishPrerequisiteView([taskId]);
    return;
  }
  if (await taskHoldOf(task)) return noteHoldup(taskId, "held");
  const edges = await prerequisiteEdges(taskId);
  if (edges.length && !launch.launchedAt) {
    const standings = await prerequisiteStandings(edges.map((edge) => edge.prerequisiteId));
    if (edges.some((edge) => standings.get(edge.prerequisiteId)?.standing.step !== "settled")) return;
  }
  const queue = (await db.select().from(queueItems).where(eq(queueItems.taskId, taskId))).at(0);
  if (queue) {
    const { advanceQueueInBackground } = await import("./scheduler.js");
    advanceQueueInBackground(queue.queueId);
    return noteHoldup(taskId, "queue");
  }
  // 名额明摆着满的先不往下走（下面那一问要对一遍续跑交代的账，每放一次锁都扫一遍就太重）。这只是省事的预判：
  // 占不占得到以认领那一下当场数的为准。
  if (await runningInGroup(task.groupId ?? null) >= PARALLEL_LIMIT) return noteHoldup(taskId, "full");
  const { preparePendingCheckpointStart } = await import("./pending-checkpoint-recovery.js");
  // 续跑交代的交接还没理清：这一次不起，请求留着（交接理清之后下一次再来）。
  if (await preparePendingCheckpointStart(taskId)) return;

  const { releaseTurn } = await import("./runs.js");
  const { isAcceptingTask } = await import("./acceptance-lock.js");
  // 「请求还在 → 占名额认领回合 → 重读任务 → 定起点」在同一把锁里做完，跟停止键（withdrawLaunchRequest）排成
  // 先后：锁外读到的那份请求可能已经被撤回了。认领之后再来的停止，冻住的是这一次起跑。
  //
  // 回合从认领到交给 seatThenStart（之后由它负责还，queue-seat.ts）之间归这里：没交出去就退出 —— 不论正常返回
  // 还是抛错（定起点要写 git、读写库）—— 一律按认领时的那一代身份还回去，否则这条任务谁都起不了。
  let owned: TurnIdentity | null = null;
  let outcome: { turn: TurnIdentity; actingUserId: string | null; source: string | null } | "full" | "churn" | "settle" | "regrouped" | null = null;
  try {
    outcome = await withPrerequisiteLock(taskId, async () => {
      const current = await launchRecord(taskId);
      if (!current?.requestedAt) return null;
      const seat = await claimLaunchTurn(taskId, task.groupId ?? null);
      if (!seat.ok) return seat.why === "busy" ? null : seat.why;
      owned = seat.turn;
      // 占着回合重读：回合结算是持锁写状态的，所以这期间别处起过、跑完的，这里一定看得见。
      const row = await readTask(taskId);
      if (!row || !(await awaitsLaunch(row, current.source))) return "settle";
      if ((row.groupId ?? null) !== (task.groupId ?? null)) return "regrouped";
      if (await taskHoldOf(row)) return null;
      if (isAcceptingTask(taskId) || await holdForPrerequisitesLocked(taskId, { source: "release", actingUserId: current.actingUserId })) return null;
      return { turn: owned, actingUserId: current.actingUserId, source: current.source };
    });
  } finally {
    if (owned && (!outcome || typeof outcome === "string")) releaseTurn(taskId, owned);
  }
  if (outcome === "full") return noteHoldup(taskId, "full");
  if (outcome === "settle") {
    await settleRequest(taskId);
    return republishPrerequisiteView([taskId]);
  }
  if (outcome === "regrouped" || outcome === "churn") return sweepSoon();
  if (!outcome) return;
  noteHoldup(taskId, null);
  const { turn, actingUserId, source } = outcome;
  const { seatThenStart } = await import("./queue-seat.js");
  const { resumeOrRunTask } = await import("./task-resume.js");
  const reason = source === "group" ? "group" : source === "hold" ? "hold" : "wake";
  let failure: string | null = null;
  // 名额是按锁外读到的分组数的：认领那一步在队列认领链上再认一次分组，中途换了组就不起 —— 回合还掉，
  // 那一放锁的一扫就按新组重排（queue-seat.ts `slotGroup`）。
  const started = await seatThenStart(taskId, turn, () =>
    // 不是用户当场那一下运行了：按自动起跑认（停着照样拦，turn-freeze.ts）。
    resumeOrRunTask(taskId, { origin: "auto", reason, turnHeld: turn, actingUserId }),
  { slotGroup: task.groupId ?? null, onStartError: (error) => { failure = error instanceof Error ? error.message : String(error); } });
  if (started.ok) {
    await settleRequest(taskId);
    return republishPrerequisiteView([taskId]);
  }
  if (started.regrouped) return sweepSoon();
  await noteStartFailure(taskId, failure ?? started.blockers.join("；"));
}

/**
 * 轮到它了却没起来。先确认真是「起不来」：这期间状态变了、被按住了、请求被撤了的不算（下一次判定会各自了结）。
 * 退避再试，连着到 MAX_START_ATTEMPTS 次就撤掉请求、留一句交代 —— 不是每扫一次就重试一次、刷一串失败。
 */
async function noteStartFailure(taskId: string, reason: string): Promise<void> {
  const current = await launchRecord(taskId);
  const row = await readTask(taskId);
  if (!current?.requestedAt || !row || !(await awaitsLaunch(row, current.source)) || await taskHoldOf(row)) return;
  const failures = current.startFailures + 1;
  if (failures >= MAX_START_ATTEMPTS) {
    await settleRequest(taskId);
    const { reportLaunchGiveUp } = await import("./group-start-failure.js");
    await reportLaunchGiveUp(row, `连着 ${failures} 次没能自动开工（${reason}），不再自动重试。处理好之后点运行。`);
    await republishPrerequisiteView([taskId]);
    return;
  }
  const at = new Date(Date.now() + retryDelay(failures)).toISOString();
  await db.update(taskPrerequisiteLaunches).set({ startFailures: failures, retryAt: at })
    .where(and(eq(taskPrerequisiteLaunches.taskId, taskId), isNotNull(taskPrerequisiteLaunches.requestedAt)));
  console.warn(`[ash] 自动开工没起来 task=${taskId}（第 ${failures} 次，${at} 再试）：${reason}`);
  await republishPrerequisiteView([taskId]);
  retryAt(taskId, at);
}

const retryTimers = new Map<string, NodeJS.Timeout>();
function retryAt(taskId: string, at: string): void {
  if (retryTimers.has(taskId)) return;
  const timer = setTimeout(() => {
    retryTimers.delete(taskId);
    void releaseLaunch(taskId).catch((error) => console.error(`[ash] 自动开工重试失败 task=${taskId}:`, error));
  }, Math.max(0, new Date(at).getTime() - Date.now()) + 50);
  timer.unref();
  retryTimers.set(taskId, timer);
}

/**
 * 页面上「在等什么」那一句跟着放行口的判断走（launch-holdup.ts 算字）：判断换了才重发快照，名额一直满着时
 * 每放一次锁扫一遍也不会刷屏。只是「什么时候重发」的记忆，丢了（重启）最多多发一次。
 */
const lastHoldup = new Map<string, string | null>();
function noteHoldup(taskId: string, holdup: "held" | "queue" | "full" | null): void {
  if ((lastHoldup.get(taskId) ?? null) === holdup) return;
  if (holdup) lastHoldup.set(taskId, holdup); else lastHoldup.delete(taskId);
  void republishPrerequisiteView([taskId]).catch((error) => console.error(`[ash] 开工等待说明重发失败 task=${taskId}:`, error));
}

// ── 停止 ─────────────────────────────────────────────────────────────────────

export type WithdrawnLaunch = { kind: "withdrawn" | "starting"; what: string };

/**
 * 停止键撤回开工请求：还没开工（backlog，或被打断的 paused）、挂着请求的才撤。留一行记录、页面上的「在等」随之
 * 消失，刷新之后也看得出停过 —— 从没跑过的任务没有会话可写时间线，记成任务历史里的一条。撤了之后腾出名额、
 * 定时那一扫、重启都不会再起它（库里没有请求了）。
 *
 * 放行那一路已经认领了回合、正要起跑的（锁里认领，见 releaseLaunch），把那一次起跑冻住：它在拉起执行器之前的
 * 最后一道闸上撤回（turn-lock.ts `freezeStartingTurn`）。返回 `starting`，由调用方照「停一个正在起跑的回合」
 * 那一套收尾；撤了、没在起跑返回 `withdrawn`；没有可撤的返回 null。
 */
export async function withdrawLaunchRequest(taskId: string): Promise<WithdrawnLaunch | null> {
  return withPrerequisiteLock(taskId, async () => {
    const task = await readTask(taskId);
    const record = await launchRecord(taskId);
    if ((task?.status !== "backlog" && task?.status !== "paused") || !record?.requestedAt) return null;
    const { freezeStartingTurn, isTurnClaimed } = await import("./runs.js");
    const starting = isTurnClaimed(taskId) && freezeStartingTurn(taskId, "canceled");
    await db.update(taskPrerequisiteLaunches).set({ requestedAt: null, blocked: null, startFailures: 0, retryAt: null })
      .where(eq(taskPrerequisiteLaunches.taskId, taskId));
    // 「接着跑」欠下的那一笔也划掉：不然下一次兑现又把请求挂回来（dispatch-hold.ts）。
    await db.update(tasks).set({ holdOwedBy: null }).where(and(eq(tasks.id, taskId), isNotNull(tasks.holdOwedBy)));
    const forPrerequisites = !record.launchedAt && (await prerequisiteEdges(taskId)).length > 0;
    const what = forPrerequisites ? "「前置站齐就开工」" : "自动开工";
    // 等着跟它一起开工的回复（执行型待发送）一并撤掉，否则下一次投递扫描又把请求挂回去；原文照抄进时间线。
    const { cancelPendingMessage } = await import("./pending-messages.js");
    const stashed = await db.select().from(scheduledMessages).where(and(eq(scheduledMessages.taskId, taskId),
      eq(scheduledMessages.status, "pending"), eq(scheduledMessages.execution, true), isNull(scheduledMessages.deliveringSince)));
    for (const message of stashed) await cancelPendingMessage(message, `停止了${what}`);
    const text = forPrerequisites ? "已停止：不再等前置站齐自动开工。要开工再点运行。" : "已停止：不再自动开工。要开工再点运行。";
    if (!await appendTaskTimeline(taskId, receiptLine(text))) {
      const { noteSystemNotice } = await import("./user-action-rejection.js");
      await noteSystemNotice(taskId, `prerequisite-withdrawn:${record.requestedAt}`, "停止", text);
    }
    lastHoldup.delete(taskId);
    await republishPrerequisiteView([taskId]);
    return { kind: starting ? "starting" : "withdrawn", what };
  });
}

// ── 扫描 ─────────────────────────────────────────────────────────────────────

/**
 * 全部挂着的请求判一遍。几条一起判：名额在认领那一下当场数，几路同时放行也不会一起越过上限。按挂上的先后
 * （同一刻挂的按建任务先后）发起，先来的先数名额。
 */
export async function sweepLaunchRequests(): Promise<void> {
  if (dbClient.closed) return; // 进程收尾（测试关库、server 退出）时迟到的那一扫
  const rows = await db.select({ taskId: taskPrerequisiteLaunches.taskId }).from(taskPrerequisiteLaunches)
    .leftJoin(tasks, eq(tasks.id, taskPrerequisiteLaunches.taskId))
    .where(isNotNull(taskPrerequisiteLaunches.requestedAt))
    .orderBy(asc(taskPrerequisiteLaunches.requestedAt), asc(tasks.createdAt), asc(taskPrerequisiteLaunches.taskId));
  await Promise.all(rows.map(({ taskId }) => releaseLaunch(taskId)
    .catch((error) => { if (!dbClient.closed) console.error(`[ash] 自动开工判定失败 task=${taskId}:`, error); })));
}

let sweepTimer: NodeJS.Timeout | null = null;
/** 短暂合并一下再扫：一次放锁、一次结算往往连着好几个事件。 */
export function sweepSoon(): void {
  if (sweepTimer) return;
  sweepTimer = setTimeout(() => {
    sweepTimer = null;
    void sweepLaunchRequests().catch((error) => console.error("[ash] 自动开工扫描失败:", error));
  }, 200);
  sweepTimer.unref();
}

let booting = false;
/**
 * 开机最早调一次（main.ts，接回在跑的回合之前）：从这一刻起到 `startLaunchRequests`，放行口一律不起 —— 接回之前
 * 数名额，数的是重启前那几条还没占上锁的空桶，会多起。
 */
export function holdLaunchesForBoot(): void {
  booting = true;
}

let started = false;
/** 开机调一次（排在重启接回之后：名额要数上接回来的回合）：补办一遍、之后每分钟兜底扫一遍。 */
export async function startLaunchRequests(intervalMs = 60_000): Promise<void> {
  if (started) return;
  started = true;
  booting = false;
  await sweepLaunchRequests();
  setInterval(() => void sweepLaunchRequests().catch((error) => console.error("[ash] 自动开工扫描失败:", error)), intervalMs).unref();
}

// 任何一把回合锁放开：名额可能空出来了，被名额挡住的当场补放，不等每分钟那一扫。加载本模块就装上。
onTurnReleasedAlso(() => sweepSoon());
