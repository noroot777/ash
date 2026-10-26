// 门禁日志里**哪一个字节是谁写的**。这一层的全部存在理由就是这一句。
//
// 由来（第 1 轮审查 F3 → 第 2 轮 R2-F1 → 第 3 轮 F2，同一条问题被钉了三次）：命令的
// stdout/stderr 由 spawnAcceptGate 直接接到门禁日志那个 fd 上，ash 的进度行一度也往同一
// 份文件里追加，于是「这一行是谁写的」只能靠内容去猜。三种猜法全被实测推翻：
//  · 按 `[ash] ` 前缀猜 —— 被测命令自己也能打印这个前缀；
//  · 写前写后两次 stat 推自己那几个字节的区间 —— 命令可能正好插在这两次 stat 中间，
//    推出来的区间会把它的输出当成心跳抹掉；
//  · 把自己写过的行**原文**记下来剔除 —— O_APPEND 只保证我们这一段不被从中间拆开，
//    **不保证它前面是个换行**。命令在「读最后一个字节」和「append」之间写了半行，两段就
//    粘成 `...[ash] 进度 · …`，原文比不上，于是 ash 的提示被当成了命令的末行。
//
// 所以不猜了：**ash 的元信息根本不写进那份文件**。命令跑着的那段时间里门禁日志只有命令
// 一个写入者（ash 只在开跑前和结算时写，两头都在 watcher 的窗口之外），watcher 要的末行、
// 字节数、更新时间于是全部直接取自它，中间没有「判断来源」这一步可错。
// ash 自己的两样东西住在日志旁边：
//   <log>.notes   跑的过程中的进度/静默提示，一行一条按时间追加
//   <log>.scene   撞上时限那一刻的现场，一次性冻结，之后不再改
// 用户看到的仍然是合起来的一份：acceptGateLogTail / acceptGateLogText 在末尾给它们留位置。
//
// 现场为什么必须单独冻结（第 2 轮审查 R2-F2）：停不掉的进程是受支持的生产状态，它之后写的
// 每一个字节都能把追加在日志末尾的现场顶出可回显的那一段。「这一次 append 暂时在最后」不是
// 不变量，谁最后写也不由我们说了算；存成旁边一份，刷新多少次、后面再写多少都挤不掉。
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** 回显的那一段尾巴里带最近几条进度。完整时间轴在现场的「产出节奏」里，不在这儿凑数。 */
const NOTES_IN_TAIL = 3;

/** 读进度文件最多读尾部多少字节。正常一场门禁十几行，这是防回归里把节拍压到毫秒级。 */
const NOTES_MAX_BYTES = 64_000;

export function gateNotesPath(logPath: string): string {
  return `${logPath}.notes`;
}

export function gateScenePath(logPath: string): string {
  return `${logPath}.scene`;
}

/** 记一条 ash 自己的进度/提示。**不碰门禁日志**，所以它永远不会跟命令的输出粘在一起。 */
export function appendGateNote(logPath: string, line: string): boolean {
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(gateNotesPath(logPath), `${line}\n`, "utf8");
    return true;
  } catch { return false; /* 写不进去不该让门禁本身失败，下面的读口按「没有」处理 */ }
}

/**
 * 冻结现场。存成了返回 null，**没存成返回一句给人看的降级说明** —— 磁盘满、权限拒绝都
 * 是真会发生的，吞掉它就成了「界面上宣称有现场、文件里其实没有」（第 3 轮审查 F1）。
 * 调用方拿到这句话要把它写进日志和时间线，并自己把现场直接追加进日志兜底。
 */
export function freezeGateScene(logPath: string, scene: string): string | null {
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    writeFileSync(gateScenePath(logPath), scene, "utf8");
    return null;
  } catch (error) {
    return `被收掉时的现场没能单独存下来（${error instanceof Error ? error.message : String(error)}）：`
      + `已改为直接写进日志，后面要是还有进程在写，它可能被顶出可回显的那一段。`;
  }
}

function readSidecar(path: string): string {
  try {
    if (!existsSync(path)) return "";
    const size = statSync(path).size;
    const start = Math.max(0, size - NOTES_MAX_BYTES);
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.alloc(size - start);
      readSync(fd, buf, 0, buf.length, start);
      return buf.toString("utf8");
    } finally { closeSync(fd); }
  } catch { return ""; }
}

export function readGateScene(logPath: string): string {
  return readSidecar(gateScenePath(logPath));
}

function noteLines(logPath: string): string[] {
  return readSidecar(gateNotesPath(logPath)).split("\n").map(line => line.trim()).filter(line => line.length > 0);
}

/**
 * 补在回显尾巴后面的那一段 ash 元信息。
 *
 * 出了结论就只给现场：现场里已经有完整的产出节奏，再把进度行抄一遍只会挤掉命令自己的输出。
 */
export function gateDiagnosisTail(logPath: string): string {
  const scene = readGateScene(logPath);
  if (scene) return scene;
  const notes = noteLines(logPath).slice(-NOTES_IN_TAIL);
  return notes.length ? `${notes.join("\n")}\n` : "";
}

/** 「看完整日志」那一份：进度时间轴全给，后面跟着现场。 */
export function gateDiagnosisFull(logPath: string): string {
  const notes = noteLines(logPath);
  const scene = readGateScene(logPath);
  const timeline = notes.length ? `\n[ash] ──── 跑的过程中的进度 ────\n${notes.join("\n")}\n` : "";
  return `${timeline}${scene ? `\n${scene}` : ""}`;
}
