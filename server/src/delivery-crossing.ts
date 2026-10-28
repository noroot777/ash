// 「这段输入**越过 spawn 那条线了吗**」——「还没启动」与「交付不明」之间唯一的分界事实。
//
// 为什么非得有它:持久投递协议此前靠「租约时刻之后有没有回合开起来过」反推送达,而
// `sessions.turn_started_at` 是在 **spawn 之后**才写的(orchestrator 的 persistRunner)。
// 真正不可逆的外部效果是 spawn/投喂本身,会话行只是事后记账 —— 于是「没有会话行」只证明
// 记账没做完,不证明输入没出去。第 1 轮审查 F1 用假 CLI + SIGKILL 跨进程实测:同一段交代被
// 真实启动的 agent 收到两次(`BEFORE_CRASH_AGENT_INPUT_COUNT 1` → `AFTER_RETRY 2`),
// 第二次正是恢复时按「一定没送出去」归还后重投的。
//
// 所以这里在**交出 prompt 之前**先把「这几条输入即将越线」同步落到磁盘。两个硬约束决定了
// 形态:
//  ① **必须同步**。从 `takeFreeze` 到 `run(...)` 之间一个 await 都不许有(暂停请求的交接
//     就靠这段同步区,见 orchestrator 那一段注释),而 libsql 的写一律是异步的 —— 文件是
//     这段窗口里唯一能用的持久介质。顺带 fsync:进程被 SIGKILL 时页缓存还在,但整机断电
//     时不在,而这张记号写错方向的代价正是重放。
//  ② **必须按消息 id 分得开**。判的是「这一条输入出去没有」,不是「这一轮起没起来」。
//
// **凭据写不成就不许产生外部效果。** 第一版写不下去时只告警不抛,于是 mkdir/open/write/fsync
// 任何一样失败(实测 `EEXIST`:`runs/<task>/crossed` 被一个普通文件占住;同类还有 `EACCES`、
// `ENOSPC`、`EIO`)都会照常 spawn,恢复侧又把「记号不存在」读成「没投喂」—— 第 2 轮自由审查
// 跨进程实测到同一段交代再次被执行(`BEFORE_CRASH 1` → `AFTER_RETRY 2`)。现在续跑交代那条路
// 走 `requireDeliveryCrossing`:写不成当场抛,这一轮在 spawn 之前原地撤回,输入安全退回任务。
// 目录则更早一步在认领凭证时就建好(`ensureCrossingDir`),这样恢复侧读到「目录在、这一条
// 不在」才是**真的**没写过,而不是「这棵树根本没建起来」。
//
// 普通待发送消息此刻仍按既有口径走「宁可重发一次也不丢一句话」—— 那是用户打的字,重发在会话
// 里看得见,与 agent 自己的流水线交接不是同一个取舍(见 reclaimStaleDeliveries 的注释)。
// 记号照样给它们写(`noteDeliveryCrossing`,尽力而为),越线这件事对谁都是同一个事实。
import { closeSync, fsyncSync, mkdirSync, openSync, rmSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import { RUNS_DIR } from "./paths.js";

const crossingDir = (taskId: string): string => join(RUNS_DIR, taskId, "crossed");
const crossingPath = (taskId: string, messageId: string): string =>
  join(crossingDir(taskId), `${messageId}.json`);

/** 越线凭据落不下来。抛它的时刻**一个字都还没送出去**,调用方据此原地撤回并归还输入。 */
export class DeliveryCrossingUnwritable extends Error {
  constructor(taskId: string, cause: unknown) {
    super(`投递越线记号写不下来（task=${taskId}）：${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "DeliveryCrossingUnwritable";
    this.cause = cause;
  }
}

/** 目录项本身也落盘,否则断电后文件可能连名字都不在。平台不支持就算了(Windows 上打不开
 *  目录 fd),这一档的保证降回「进程崩溃仍在」。 */
function fsyncDir(path: string): void {
  try {
    const dir = openSync(path, "r");
    try { fsyncSync(dir); } finally { closeSync(dir); }
  } catch { /* 目录 fsync 不是必须 */ }
}

/**
 * 把这个任务的记号目录**先建起来**,在还能 await、还没产生任何外部效果的时候。
 *
 * 为什么要单独一步:恢复侧要分清「这一条没写过」和「这棵树根本不在」。目录由认领凭证那一步
 * 负责建好之后,「目录在、文件不在」才构成真正的否证;建不起来就当场抛 —— 凭据系统坏了,
 * 这一轮根本不该开始。
 */
export function ensureCrossingDir(taskId: string): void {
  try {
    mkdirSync(crossingDir(taskId), { recursive: true });
    fsyncDir(crossingDir(taskId));
  } catch (error) {
    throw new DeliveryCrossingUnwritable(taskId, error);
  }
}

function writeCrossings(
  taskId: string, messageIds: readonly string[], about: { sessionId: string; turnStart: string },
): void {
  mkdirSync(crossingDir(taskId), { recursive: true });
  for (const messageId of messageIds) {
    const fd = openSync(crossingPath(taskId, messageId), "w");
    try {
      writeSync(fd, JSON.stringify({ ...about, at: new Date().toISOString() }));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  fsyncDir(crossingDir(taskId));
}

/**
 * 记下「这几条输入即将越过 spawn」,**凭据档**:写不成就抛,调用方不许继续往下走。
 * 全同步,调用点就在 `run(...)` 上面一行。
 */
export function requireDeliveryCrossing(
  taskId: string, messageIds: readonly string[], about: { sessionId: string; turnStart: string },
): void {
  if (!messageIds.length) return;
  try { writeCrossings(taskId, messageIds, about); }
  catch (error) { throw new DeliveryCrossingUnwritable(taskId, error); }
}

/**
 * 同上,**尽力而为档**:普通待发送消息用。它们的既有策略是「宁可重发」,所以记号缺失只是让
 * 那条缝里的判定退回改动之前那样,不值得为它把用户按下的「继续」整个拦掉。
 */
export function noteDeliveryCrossing(
  taskId: string, messageIds: readonly string[], about: { sessionId: string; turnStart: string },
): void {
  if (!messageIds.length) return;
  try { writeCrossings(taskId, messageIds, about); }
  catch (error) { console.warn(`[ash] 投递越线记号写入失败 task=${taskId}:`, error); }
}

/**
 * 两档策略的唯一入口,给 spawn 前那一行用:`required` 为真 = 凭据档(写不成当场抛,调用方
 * 原地撤回);否则 = 尽力而为档。两档的取舍见文件头。
 */
export function recordDeliveryCrossing(
  taskId: string, messageIds: readonly string[],
  about: { sessionId: string; turnStart: string }, required: boolean | undefined,
): void {
  if (required) requireDeliveryCrossing(taskId, messageIds, about);
  else noteDeliveryCrossing(taskId, messageIds, about);
}

/**
 * 这一条输入越过 spawn 了吗 —— **三态**。
 *
 *  · `crossed`    —— 记号在:它已经交出去过;
 *  · `absent`     —— 目录在、这一条不在:凭据是硬前置(写不成就不会 spawn),所以这是**否证**;
 *  · `unreadable` —— 这一问本身没答上来(目录不在了、权限没了、I/O 错)。读不出来不是「没有」:
 *                    按「没有」处理就是把一段可能已经执行过的交代重新投一遍。
 */
export type CrossingRead = "crossed" | "absent" | "unreadable";

export function deliveryCrossing(taskId: string, messageId: string): CrossingRead {
  try {
    statSync(crossingPath(taskId, messageId));
    return "crossed";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return "unreadable";
  }
  // 文件不在:只有**目录确实在**才算否证 —— 目录是认领凭证那一步建好并 fsync 过的,
  // 它不在说明这棵树被谁动过,那种沉默证明不了任何事。
  try {
    statSync(crossingDir(taskId));
    return "absent";
  } catch {
    return "unreadable";
  }
}

/** 这一条投递已经有定论了(标 sent / 已归还),记号留着只是垃圾。 */
export function forgetDeliveryCrossing(taskId: string, messageIds: readonly string[]): void {
  for (const messageId of messageIds) {
    try { rmSync(crossingPath(taskId, messageId), { force: true }); }
    catch (error) { console.warn(`[ash] 投递越线记号清理失败 task=${taskId} message=${messageId}:`, error); }
  }
}
