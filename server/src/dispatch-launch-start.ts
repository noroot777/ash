// 派活单派出的任务「欠一次起跑」（dispatch_start_debts，一条任务一行，见 db/schema-dispatch-launch.ts）怎么还、什么时候销。
//
// 这一行是用户按下「派出去」那一笔原始请求，只交接一次：
//   · **销账只认重读出来的现场**，不认「起组的函数回来了」——runGroupInBackground 会把起跑失败、连同失败交代自己也
//     失败的那一档吞成正常返回。按起组的同一把尺子（`groupLaunchTargets`）看这一条还是不是该起而没起：起跑过了、排在
//     队列里还没轮到（队列推进有它自己的持久账）、开工请求已经挂在前置上（前置站稳就起，那份请求是持久的）、被归档
//     删掉、整组被暂停（用户按的停，恢复全组时他自己会起）——都算还清；
//   · **撤销是终局的**：用户对这一条按了停止，停止那一下就把它这一行划掉（`forgetDispatchStart`，跟开工判定同一把
//     前置锁）。之后的退避重试、重启补起只认还在的行，不会从「它还是 backlog、还能起」反推用户仍要它开工；
//   · **所有自动起跑都走同一条路**（`launchOwed`）：首次派出、退避重试、重启补起都照「运行分组」起，同组名额跟前置放行
//     共用；每一条轮到时在开工判定那把前置锁里核它这一行还在（`stillOwed`）——没了就不起，不论它在名额后面排了多久。
// 起一趟没还清（或数都没数成）就留账退避再起，几次都不成就留给下一次启动；重启那一扫读库失败同样退避重来。
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { db } from "./db/index.js";
import { dispatchStartDebts, groups, taskPrerequisiteLaunches } from "./db/schema.js";
import { groupLaunchTargets, runGroupInBackground } from "./scheduler.js";

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

/** 开工判定那把前置锁里问的那一句：这一条「派出去就开工」的那一笔还在不在（停止键在同一把锁里划掉它）。 */
async function stillOwed(taskId: string): Promise<boolean> {
  const [debt] = await db.select({ taskId: dispatchStartDebts.taskId }).from(dispatchStartDebts).where(eq(dispatchStartDebts.taskId, taskId));
  return !!debt;
}

/**
 * 首次派出、退避重试、重启补起都走这一条：照「运行分组」起（同组同时在跑的名额、起跑回执、失败交代、队列推进都是
 * 那一套，跟前置放行共用名额），每一条轮到时在前置锁里核它那一笔还在——被停掉的那条排在名额后面也不会被起。
 * runGroupInBackground 要等组里的成员轮完才回来。
 */
async function launchOwed(groupId: string): Promise<void> {
  try {
    await runGroupInBackground(groupId, stillOwed);
  } catch (error) {
    console.error(`[ash] 起派出的那一组出错 ${groupId}:`, error);
  }
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

/** 还有人欠着才起一趟（退避、重启用；刚派出时全组都欠着，直接起）。 */
async function relaunchOwed(groupId: string): Promise<void> {
  let owed: string[];
  try {
    owed = await owedDispatchStarts(groupId);
  } catch (error) {
    console.error(`[ash] 读派出那一组还欠谁起跑失败 ${groupId}:`, error);
    return;
  }
  if (owed.length) await launchOwed(groupId);
}

/** 刚派出：整组都是这一笔新建的、都欠着，起一趟，轮完之后核账。 */
export async function startDispatchedGroup(groupId: string): Promise<void> {
  await launchOwed(groupId);
  await settleDispatchStarts(groupId, 0);
}

/**
 * 重启时补起：上一个进程派出了、还没还清起跑的那几组，各起一趟（只有还欠着的会被起）。只发起、不等——启动流程不能被它挂住。
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
