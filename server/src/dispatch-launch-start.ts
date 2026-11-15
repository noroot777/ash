// 派活单派出的任务「欠一次起跑」（dispatch_start_debts，一条任务一行，见 db/schema-dispatch-launch.ts）怎么还、什么时候销。
//
// 这一行是用户按下「派出去」那一笔原始请求，只交接一次：
//   · **销账只认重读出来的现场**，不认「起组的函数回来了」——runGroupInBackground 会把起跑失败、连同失败交代自己也
//     失败的那一档吞成正常返回。按起组的同一把尺子（`groupLaunchTargets`）看这一条还是不是该起而没起：起跑过了、排在
//     队列里还没轮到（队列推进有它自己的持久账）、开工请求已经挂在前置上（前置站稳就起，那份请求是持久的）、被归档
//     删掉、整组被暂停（用户按的停，恢复全组时他自己会起）——都算还清；
//   · **撤销是终局的**：用户对这一条按了停止，停止那一下就把它这一行划掉（`forgetDispatchStart`，跟开工判定同一把
//     前置锁）。之后的退避重试、重启补起只认还在的行，不会从「它还是 backlog、还能起」反推用户仍要它开工；
//   · **补起只起还欠着的那几条**，逐条起（排在队列里的推它那条队列），不重放整组：整组重放会把别的成员——包括被停掉
//     的那条——一起重新挂回去。
// 起一趟没还清（或数都没数成）就留账退避再起，几次都不成就留给下一次启动；重启那一扫读库失败同样退避重来。
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { db } from "./db/index.js";
import { dispatchStartDebts, groups, queueItems, taskPrerequisiteLaunches, tasks } from "./db/schema.js";
import { isAcceptingTask } from "./acceptance-lock.js";
import { preparePendingCheckpointStart } from "./pending-checkpoint-recovery.js";
import { holdForPrerequisitesLocked, withPrerequisiteLock } from "./prerequisite-gate.js";
import { seatThenStart } from "./queue-seat.js";
import { claimOwnTurn, releaseTurn } from "./runs.js";
import { advanceQueue, groupLaunchTargets, runGroupInBackground } from "./scheduler.js";
import { readActionFacts } from "./task-actions.js";
import { runVerdict } from "./task-action-verdicts.js";
import { resumeOrRunTask } from "./task-resume.js";

/** 起一趟没还清时，隔多久再起（毫秒）；用完还没还清就等下一次启动。 */
const START_RETRY_MS = [2_000, 10_000, 60_000, 300_000];
/** 重启那一扫读库失败时，隔多久再扫（毫秒）；最后一档一直重复，直到扫成为止。 */
const SCAN_RETRY_MS = [1_000, 5_000, 30_000, 300_000];

const timer = (ms: number, work: () => void) => setTimeout(work, ms).unref?.();

/** 用户对这一条按了停止：它那笔「派出去就开工」的请求就此作废。调用方拿着这条任务的前置锁。 */
export async function forgetDispatchStart(taskId: string): Promise<void> {
  await db.delete(dispatchStartDebts).where(eq(dispatchStartDebts.taskId, taskId));
}

/**
 * 这一组里还欠着起跑的那几条（顺手把已经还清的销掉）。整组不在了、被暂停了：全部销掉。开工请求已经挂在前置上的
 * 算还清——那份请求是持久的，前置站稳由前置那边起。
 */
export async function owedDispatchStarts(groupId: string): Promise<string[]> {
  const debts = (await db.select({ taskId: dispatchStartDebts.taskId }).from(dispatchStartDebts)
    .where(eq(dispatchStartDebts.groupId, groupId))).map((row) => row.taskId);
  if (!debts.length) return [];
  const [group] = await db.select({ paused: groups.paused }).from(groups).where(eq(groups.id, groupId));
  const targets = new Set(group && !group.paused ? await groupLaunchTargets(groupId) : []);
  const held = new Set((await db.select({ taskId: taskPrerequisiteLaunches.taskId }).from(taskPrerequisiteLaunches).where(and(
    inArray(taskPrerequisiteLaunches.taskId, debts), isNotNull(taskPrerequisiteLaunches.requestedAt), isNull(taskPrerequisiteLaunches.launchedAt),
  ))).map((row) => row.taskId));
  const owed = debts.filter((taskId) => targets.has(taskId) && !held.has(taskId));
  const paid = debts.filter((taskId) => !owed.includes(taskId));
  if (paid.length) await db.delete(dispatchStartDebts).where(inArray(dispatchStartDebts.taskId, paid));
  return owed;
}

/**
 * 起一条还欠着的。判据同「运行」那颗键（runVerdict、前置、回合锁、验收锁、队列占位），只是「这一行还在」要跟开工判定
 * 在同一把前置锁里核：停止那一下先划掉这一行，这里就不会再替它挂一笔「前置站齐就开工」。
 */
async function startOwedTask(taskId: string): Promise<void> {
  const [queued] = await db.select({ queueId: queueItems.queueId }).from(queueItems).where(eq(queueItems.taskId, taskId));
  if (queued) return advanceQueue(queued.queueId);
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  if (!task || !runVerdict(await readActionFacts(task)).ok) return;
  if (await preparePendingCheckpointStart(taskId)) return;
  const hold = await withPrerequisiteLock(taskId, async () => {
    const [debt] = await db.select({ taskId: dispatchStartDebts.taskId }).from(dispatchStartDebts).where(eq(dispatchStartDebts.taskId, taskId));
    return debt ? holdForPrerequisitesLocked(taskId, { source: "group" }) : { reason: "已撤销" };
  });
  if (hold) return;
  const turn = claimOwnTurn(taskId, "single");
  if (!turn) return;
  if (isAcceptingTask(taskId)) return releaseTurn(taskId, turn);
  await seatThenStart(taskId, turn, () => resumeOrRunTask(taskId, { reason: "group", turnHeld: turn }));
}

/** 核一遍这一组还欠谁；没还清（或核不了）就退避，起还欠着的那几条，再核。 */
async function settleDispatchStarts(groupId: string, attempt: number): Promise<void> {
  let owed: string[] | null = null;
  try {
    owed = await owedDispatchStarts(groupId);
  } catch (error) {
    console.error(`[ash] 核对派出那一组还欠谁起跑失败 ${groupId}:`, error);
  }
  if (owed && !owed.length) return;
  const wait = START_RETRY_MS[attempt];
  if (wait === undefined) {
    console.error(`[ash] 派出的那一组起了 ${attempt + 1} 次还有人没起跑 ${groupId}${owed ? `（${owed.join(", ")}）` : ""}，账留着，下次启动再补`);
    return;
  }
  timer(wait, () => void relaunchOwed(groupId).then(() => settleDispatchStarts(groupId, attempt + 1)));
}

/** 逐条起这一组还欠着的（每条各自兜底，一条起不来不挡别的）。 */
async function relaunchOwed(groupId: string): Promise<void> {
  let owed: string[];
  try {
    owed = await owedDispatchStarts(groupId);
  } catch (error) {
    console.error(`[ash] 读派出那一组还欠谁起跑失败 ${groupId}:`, error);
    return;
  }
  await Promise.all(owed.map((taskId) => startOwedTask(taskId)
    .catch((error) => console.error(`[ash] 补起派出的任务出错 ${taskId}:`, error))));
}

/**
 * 刚派出：整组都是这一笔新建的、都欠着，照「运行分组」起一趟（并发上限、队列、前置全按它来）。runGroupInBackground
 * 要等组里的成员轮完才回来，回来之后核账。
 */
export async function startDispatchedGroup(groupId: string): Promise<void> {
  try {
    await runGroupInBackground(groupId);
  } catch (error) {
    console.error(`[ash] 派出的那一组起跑出错 ${groupId}:`, error);
  }
  await settleDispatchStarts(groupId, 0);
}

/**
 * 重启时补起：上一个进程派出了、还没还清起跑的那几条，逐条起（不重放整组）。只发起、不等——启动流程不能被它挂住。
 * 读库失败退避再扫。
 */
export async function recoverDispatchLaunchStarts(attempt = 0): Promise<void> {
  let groupIds: string[];
  try {
    groupIds = [...new Set((await db.select({ groupId: dispatchStartDebts.groupId }).from(dispatchStartDebts)).map((row) => row.groupId))];
  } catch (error) {
    const wait = SCAN_RETRY_MS[Math.min(attempt, SCAN_RETRY_MS.length - 1)]!;
    console.error(`[ash] 读派出后欠着起跑的任务失败，${wait / 1000}s 后再扫:`, error);
    timer(wait, () => void recoverDispatchLaunchStarts(attempt + 1));
    return;
  }
  for (const groupId of groupIds) void relaunchOwed(groupId).then(() => settleDispatchStarts(groupId, 0));
  if (groupIds.length) console.log(`[ash] 补起 ${groupIds.length} 组派出后没来得及起跑的任务`);
}
