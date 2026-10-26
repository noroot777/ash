// 门禁跑着的那十几到九十分钟里**看着它**：记下它什么时候还在出东西、什么时候不出了。
//
// 由来（用户 2026-10-26）：一次 `npm run test:accept` 跑满 90 分钟被收掉，日志里只留下
// 一句「超过 90 分钟，按超时处理」。事后翻遍那份日志也答不出最要紧的那个问题 ——
// 它是**某一步卡住了**，还是**整台机器在爬**？两种的处置完全相反：前者去找那条不肯退出
// 的用例/进程，后者去看谁在抢资源。光看「最后停在第 27 条横幅」分不出来，因为日志里
// 没有一个时间戳，没法知道那 27 条是均匀用掉 90 分钟，还是 10 分钟跑完之后干等了 80 分钟。
//
// 所以这一层只做一件事：**把时间轴补上**。
//  · 每 ACCEPT_GATE_PROGRESS_MS 往日志里落一行进度（开跑第几分钟、输出涨到多少、静了多久）
//  · 日志连着 ACCEPT_GATE_SILENCE_MS 不长 → 不等满上限，当场判「卡住了」
//  · 被收掉那一刻（超时或静默）在日志**末尾**补一段现场：停在哪一行、静了多久、产出节奏
//
// 末尾这件事是硬要求：回显给界面和 agent 的只有最后 ACCEPT_GATE_TAIL_BYTES 个字节，写在
// 中间的任何结论都会被测试输出冲掉。
import { statSync } from "node:fs";
import { ACCEPT_GATE_PROGRESS_MS, ACCEPT_GATE_SILENCE_MS, ACCEPT_GATE_TIMEOUT_MS } from "@ash/shared/accept-gate";
import { acceptGateLogTail, appendGateLog } from "./accept-gate-process.js";

/** 采样间隔。一次只是 `statSync` 一下，30 秒足够分辨分钟级的事。 */
const SAMPLE_MS = 30_000;

/** 「停在这一行」最多给多少字符：一行超长的 JSON 会把有限的日志尾巴整个吃掉。 */
const LAST_LINE_MAX = 160;

/** 产出节奏最多列多少个采样点，多了从最早的开始省略。 */
const MAX_MARKS = 24;

/** 撞上限时「最近一次输出」在这个数以内，就还算它在持续产出（只是慢），不算接近卡死。 */
const CRAWLING_SILENCE_MS = 2 * 60_000;

export type GateWatchTimings = { timeoutMs: number; silenceMs: number; progressMs: number; sampleMs: number };

let overrides: Partial<GateWatchTimings> | null = null;

/** 只给回归用：把几道时限压到毫秒级，免得一条用例真等 90 分钟。传 null 还原。 */
export function overrideGateWatchTimings(timings: Partial<GateWatchTimings> | null): void {
  overrides = timings;
}

function timingsNow(): GateWatchTimings {
  return {
    timeoutMs: ACCEPT_GATE_TIMEOUT_MS, silenceMs: ACCEPT_GATE_SILENCE_MS,
    progressMs: ACCEPT_GATE_PROGRESS_MS, sampleMs: SAMPLE_MS, ...overrides,
  };
}

/** 被收掉那一刻的现场。`gateWatchReport` 把它翻译成人话。 */
export type GateWatchScene = {
  /** 哪条线先撞上：撞上限 = timeout，先静死 = stalled。 */
  failure: "timeout" | "stalled";
  elapsedMs: number;
  /** 距离命令**自己**最后一次有输出过了多久（我们写的进度行不算）。 */
  silentMs: number;
  /** 触发它的那道线有多长，用来把「跑了多久 / 上限多少」摆在一起。 */
  limitMs: number;
  /** 命令最后吐出来的那一行（我们自己的 `[ash]` 行会被滤掉）。 */
  lastLine: string | null;
  /** 命令自己产出的字节数（不含进度行）。 */
  bytes: number;
  /** 产出节奏采样点，形如 `5m/4.1KB`。 */
  marks: string[];
};

export type GateWatchVerdict = { failure: "timeout" | "stalled"; note: string };
export type GateWatch = { stop: () => void };

const minutes = (ms: number): string => (Math.max(0, ms) / 60_000).toFixed(1);
const size = (bytes: number): string => bytes < 1024 ? `${bytes}B` : `${(bytes / 1024).toFixed(1)}KB`;

function fileSize(path: string): number {
  try { return statSync(path).size; } catch { return 0; }
}

/**
 * 日志里命令**自己**最后吐的那一行。
 *
 * 滤掉 `[ash]` 开头的行是必须的：进度行就是我们自己写的，不滤的话「停在这一行」永远
 * 指向我们的心跳，等于没说。`\r` 也当换行切：进度条那类输出整段只有一个 `\n`。
 */
function lastCommandLine(logPath: string): string | null {
  const tail = acceptGateLogTail(logPath, 4000);
  const lines = tail.split(/[\r\n]+/)
    .map(line => line.replace(/\u001B\[[0-9;]*[A-Za-z]/g, "").trim())
    .filter(line => line.length > 0 && !line.startsWith("[ash]"));
  const last = lines.at(-1);
  if (!last) return null;
  return last.length > LAST_LINE_MAX ? `${last.slice(0, LAST_LINE_MAX)}…` : last;
}

/**
 * 现场 → 人话。两份措辞：`log` 是落进日志尾巴的那一段，`short` 是落进任务时间线的一句
 * （刷新后还看得见，用户不点开日志也能知道该往哪儿查）。
 *
 * 结论只有两种，而且必须**当场判死**，不能留给读的人自己猜：
 *  · 静默 → 某一步卡住了，从「停在这一行」往下找；
 *  · 撞上限但一直在出东西 → 整条命令在爬，去看谁在抢资源 / 这批用例是不是变重了。
 */
export function gateWatchReport(scene: GateWatchScene): { log: string; short: string } {
  const stuck = scene.failure === "stalled";
  const crawling = !stuck && scene.silentMs < CRAWLING_SILENCE_MS;
  const stoppedAt = scene.lastLine ? `\`${scene.lastLine}\`` : "（日志里没有命令自己的输出）";
  const verdict = stuck
    ? `连续 ${minutes(scene.silentMs)} 分钟零输出 —— 是**某一步卡住了**，不是机器慢。`
      + `从「停在这一行」的下一步开始找：那条用例的断言可能早就跑完了，是进程（浏览器、开发服务）没退出。`
    : crawling
      ? `直到被收掉都还在出东西（最近一次 ${minutes(scene.silentMs)} 分钟前）—— 不是卡死，是**整条命令在爬**。`
        + `对着上面的产出节奏看它是一直慢，还是从某个点开始变慢（多半是那时有别的活在抢机器）。`
      : `撞上限时已经 ${minutes(scene.silentMs)} 分钟没有输出，但还没静到判死 —— `
        + `**又慢又接近卡住**，先按「停在这一行」查那一步，再看机器负载。`;
  const log = [
    "",
    "[ash] ──── 被收掉时的现场 ────",
    `[ash] 跑了 ${minutes(scene.elapsedMs)} 分钟（撞上的是${stuck ? "静默线" : "时长上限"}：${minutes(scene.limitMs)} 分钟），命令自己的输出累计 ${size(scene.bytes)}。`,
    `[ash] 最后一次有输出在 ${minutes(scene.silentMs)} 分钟前，即开跑后第 ${minutes(scene.elapsedMs - scene.silentMs)} 分钟。`,
    `[ash] 停在这一行：${stoppedAt}`,
    `[ash] 产出节奏（开跑第几分钟 / 累计输出）：${scene.marks.length ? scene.marks.join(" ") : "（没跑够一个采样间隔）"}`,
    `[ash] 判断：${verdict}`,
    "",
  ].join("\n");
  const short = stuck
    ? `停在 ${stoppedAt} 之后连续 ${minutes(scene.silentMs)} 分钟没有任何输出（已跑 ${minutes(scene.elapsedMs)} 分钟），判为某一步卡住，不是机器慢。`
    : `跑满 ${minutes(scene.elapsedMs)} 分钟被收掉，停在 ${stoppedAt}，最近一次输出在 ${minutes(scene.silentMs)} 分钟前、累计只产出 ${size(scene.bytes)}`
      + `${crawling ? "，是整条命令在爬而不是某一步卡死。" : "，又慢又接近卡住。"}`;
  return { log, short };
}

/**
 * 起一个看门的。`onVerdict` 只会被叫到一次（超时或静默，先到的说了算），叫之前现场
 * 已经写进日志末尾了。调用方拿 `stop()` 在命令自己退出/被取消时把它撤掉。
 */
export function startGateWatch(opts: { logPath: string; onVerdict: (verdict: GateWatchVerdict) => void }): GateWatch {
  const timings = timingsNow();
  const startedAt = Date.now();
  // `counted` 是已经计过账的字节数（含我们自己写的进度行），`ownBytes` 是其中我们写的那部分。
  let counted = fileSize(opts.logPath);
  let ownBytes = 0;
  let lastOutputAt = startedAt;
  let nextProgressAt = startedAt + timings.progressMs;
  const marks: string[] = [];
  let finished = false;

  const finish = (failure: "timeout" | "stalled", at: number, silentMs: number, limitMs: number): void => {
    if (finished) return;
    finished = true;
    clearInterval(handle);
    const report = gateWatchReport({
      failure, elapsedMs: at - startedAt, silentMs, limitMs,
      lastLine: lastCommandLine(opts.logPath),
      bytes: Math.max(0, counted - ownBytes),
      marks: marks.length > MAX_MARKS ? ["…", ...marks.slice(-MAX_MARKS)] : marks,
    });
    appendGateLog(opts.logPath, report.log);
    opts.onVerdict({ failure, note: report.short });
  };

  const tick = (): void => {
    if (finished) return;
    const at = Date.now();
    const current = fileSize(opts.logPath);
    if (current > counted) { counted = current; lastOutputAt = at; }
    if (at >= nextProgressAt) {
      nextProgressAt = at + timings.progressMs;
      const produced = Math.max(0, current - ownBytes);
      marks.push(`${minutes(at - startedAt)}m/${size(produced)}`);
      appendGateLog(opts.logPath, `[ash] 进度 · 开跑后 ${minutes(at - startedAt)} 分钟 · 已产出 ${size(produced)}`
        + ` · 最近一次输出在 ${minutes(at - lastOutputAt)} 分钟前\n`);
      // 这一行是**我们**写的，不是命令在出东西。不把它从账上扣掉的话，静默检测会被自己的
      // 心跳一直喂饱，永远判不出「卡住了」—— 那正是这整个文件要解决的那件事。
      const after = fileSize(opts.logPath);
      ownBytes += Math.max(0, after - current);
      counted = Math.max(counted, after);
    }
    const silentMs = at - lastOutputAt;
    if (silentMs >= timings.silenceMs) finish("stalled", at, silentMs, timings.silenceMs);
    else if (at - startedAt >= timings.timeoutMs) finish("timeout", at, silentMs, timings.timeoutMs);
  };

  const handle = setInterval(tick, Math.max(1, timings.sampleMs));
  handle.unref?.();
  return { stop: () => { finished = true; clearInterval(handle); } };
}
