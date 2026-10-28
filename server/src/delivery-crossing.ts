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
// 读这张记号的只有续跑交代那条协议(pending-checkpoint-recovery.ts 的三态判定)。普通待发送
// 消息此刻仍按既有口径走「宁可重发一次也不丢一句话」—— 那是用户打的字,重发在会话里看得见,
// 与 agent 自己的流水线交接不是同一个取舍(见 reclaimStaleDeliveries 的注释)。记号照样给
// 它们写:越线这件事对谁都是同一个事实,将来要收紧那一侧时不必再补一遍现场。
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { RUNS_DIR } from "./paths.js";

const crossingDir = (taskId: string): string => join(RUNS_DIR, taskId, "crossed");
const crossingPath = (taskId: string, messageId: string): string =>
  join(crossingDir(taskId), `${messageId}.json`);

/**
 * 记下「这几条输入即将越过 spawn」。**全同步**,调用点就在 `run(...)` 上面一行。
 *
 * 写不下去时只告警不抛:这一刻拦下这一轮的代价(用户按了继续却什么都没发生)比记号缺失
 * 更确定地伤人,而记号缺失只是让那条缝里的判定退回改动之前那样(按「没送出去」归还)。
 */
export function noteDeliveryCrossing(
  taskId: string, messageIds: readonly string[], about: { sessionId: string; turnStart: string },
): void {
  if (!messageIds.length) return;
  try {
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
    // 目录项本身也要落盘,否则断电后文件可能连名字都不在。平台不支持就算了(Windows 上
    // 打不开目录 fd),这一档的保证降回「进程崩溃仍在」。
    try {
      const dir = openSync(crossingDir(taskId), "r");
      try { fsyncSync(dir); } finally { closeSync(dir); }
    } catch { /* 目录 fsync 不是必须 */ }
  } catch (error) {
    console.warn(`[ash] 投递越线记号写入失败 task=${taskId}:`, error);
  }
}

/** 这一条输入越过 spawn 了吗。读不出来(目录没了)按 false —— 那就退回「没送出去」那一档。 */
export function deliveryCrossed(taskId: string, messageId: string): boolean {
  try { return existsSync(crossingPath(taskId, messageId)); }
  catch { return false; }
}

/** 这一条投递已经有定论了(标 sent / 已归还),记号留着只是垃圾。 */
export function forgetDeliveryCrossing(taskId: string, messageIds: readonly string[]): void {
  for (const messageId of messageIds) {
    try { rmSync(crossingPath(taskId, messageId), { force: true }); }
    catch (error) { console.warn(`[ash] 投递越线记号清理失败 task=${taskId} message=${messageId}:`, error); }
  }
}
