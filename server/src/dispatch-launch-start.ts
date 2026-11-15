// 派活单派出的那一组「欠一次起跑」（dispatch_launch_starts，见 db/schema-dispatch-launch.ts）怎么还、什么时候销账。
//
// **销账只认重读出来的现场，不认「起组的函数回来了」**：runGroupInBackground 把起跑失败、连同失败交代自己
// 也失败的那一档都吞成正常返回（scheduler.ts / group-start-failure.ts），它回来不等于有人接走了起跑。所以每起
// 一趟，回头按起组的同一把尺子（`groupLaunchTargets`）数一遍还有谁欠着：
//   · 一个都不欠了——都起跑过、轮到之前排在队列里（队列推进有它自己的持久账）、被撤销/归档/删掉、整组被
//     暂停（那是用户按的停，恢复全组时他自己会起）、或者开工请求已经挂在前置上（前置站稳就起，那份请求是
//     持久的，prerequisite-gate.ts）——才销账；
//   · 还有人欠着、或者连数都没数成——账留着，退避再起；几次都不成就留给下一次启动，重启时再补。
// 重启时的那一扫（recoverDispatchLaunchStarts）读库失败同样退避重来，不会因为一次读失败就没人接手。
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { db } from "./db/index.js";
import { dispatchLaunchStarts, groups, taskPrerequisiteLaunches } from "./db/schema.js";
import { groupLaunchTargets, runGroupInBackground } from "./scheduler.js";

/** 起一趟没还清时，隔多久再起（毫秒）；用完还没还清就等下一次启动。 */
const START_RETRY_MS = [2_000, 10_000, 60_000, 300_000];
/** 重启那一扫读库失败时，隔多久再扫（毫秒）；最后一档一直重复，直到扫成为止。 */
const SCAN_RETRY_MS = [1_000, 5_000, 30_000, 300_000];

const timer = (ms: number, work: () => void) => setTimeout(work, ms).unref?.();

/**
 * 这一组还有谁欠着起跑。整组不在了、被暂停了：没人欠（暂停是用户按的停）。开工请求已经挂在前置上的不算欠——
 * 那份请求是持久的，前置站稳由前置那边起。
 */
export async function owedDispatchStarts(groupId: string): Promise<string[]> {
  const [group] = await db.select({ paused: groups.paused }).from(groups).where(eq(groups.id, groupId));
  if (!group || group.paused) return [];
  const targets = await groupLaunchTargets(groupId);
  if (!targets.length) return [];
  const held = await db.select({ taskId: taskPrerequisiteLaunches.taskId }).from(taskPrerequisiteLaunches).where(and(
    inArray(taskPrerequisiteLaunches.taskId, targets), isNotNull(taskPrerequisiteLaunches.requestedAt), isNull(taskPrerequisiteLaunches.launchedAt),
  ));
  const waiting = new Set(held.map((row) => row.taskId));
  return targets.filter((taskId) => !waiting.has(taskId));
}

/**
 * 起这一组，回头核一遍还清了没有：还清了销账，没还清（或核不了）留账退避再起。runGroupInBackground 要等组里
 * 的成员轮完才回来（并发上限下排着的也算），所以这一趟可能很长——中途进程没了，账还在，重启补起。
 */
export async function startDispatchedGroup(groupId: string, attempt = 0): Promise<void> {
  try {
    await runGroupInBackground(groupId);
  } catch (error) {
    console.error(`[ash] 派出的那一组起跑出错 ${groupId}:`, error);
  }
  let owed: string[] | null = null;
  try {
    owed = await owedDispatchStarts(groupId);
  } catch (error) {
    console.error(`[ash] 核对派出那一组还欠谁起跑失败 ${groupId}:`, error);
  }
  if (owed && !owed.length) {
    await db.delete(dispatchLaunchStarts).where(eq(dispatchLaunchStarts.groupId, groupId))
      .catch((error) => console.error(`[ash] 销掉派出那一组的起跑记录失败 ${groupId}（重启时会再核一次）:`, error));
    return;
  }
  const wait = START_RETRY_MS[attempt];
  if (wait === undefined) {
    console.error(`[ash] 派出的那一组起了 ${attempt + 1} 次还有人没起跑 ${groupId}${owed ? `（${owed.join(", ")}）` : ""}，账留着，下次启动再补`);
    return;
  }
  timer(wait, () => void startDispatchedGroup(groupId, attempt + 1));
}

/**
 * 重启时补起：上一个进程派出了、还没还清起跑的那几组。只发起、不等——每一组要等成员轮完才回来，启动流程不能被
 * 它挂住。读库失败退避再扫。
 */
export async function recoverDispatchLaunchStarts(attempt = 0): Promise<void> {
  let owed: { groupId: string }[];
  try {
    owed = await db.select({ groupId: dispatchLaunchStarts.groupId }).from(dispatchLaunchStarts);
  } catch (error) {
    const wait = SCAN_RETRY_MS[Math.min(attempt, SCAN_RETRY_MS.length - 1)]!;
    console.error(`[ash] 读派出后欠着起跑的那几组失败，${wait / 1000}s 后再扫:`, error);
    timer(wait, () => void recoverDispatchLaunchStarts(attempt + 1));
    return;
  }
  for (const row of owed) void startDispatchedGroup(row.groupId);
  if (owed.length) console.log(`[ash] 补起 ${owed.length} 组派出后没来得及起跑的任务`);
}
