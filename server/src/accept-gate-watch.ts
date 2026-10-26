// 门禁跑着的那十几到九十分钟里**看着它**：记下它什么时候在出东西、什么时候不出了。
//
// 由来（用户 2026-10-26）：一次 `npm run test:accept` 跑满 90 分钟被收掉，日志里只留下
// 一句「超过 90 分钟，按超时处理」。事后翻遍那份日志也答不出最要紧的那个问题 ——
// 它是**某一步卡住了**，还是**整台机器在爬**？两种的处置完全相反：前者去找那条不肯退出
// 的用例/进程，后者去看谁在抢资源。光看「最后停在第 27 条横幅」分不出来，因为日志里
// 没有一个时间戳，没法知道那 27 条是均匀用掉 90 分钟，还是 10 分钟跑完之后干等了 80 分钟。
//
// 所以这一层只做一件事：**把时间轴补上**。
//  · 每 ACCEPT_GATE_PROGRESS_MS 往日志里落一行进度（开跑第几分钟、产出多少、静了多久）
//  · 连着 ACCEPT_GATE_SILENCE_MS 没有输出 → 在日志里喊一声（**只喊，不收掉它**）
//  · 撞上时限那一刻交出一段「现场」：停在哪一行、静了多久、产出节奏是什么样
//
// 两条边界，都是第 1 轮审查钉下来的，别回退：
//  ① **不拿静默去掐命令**。日志长不长只能证明有没有在输出，证明不了有没有在前进；
//     理由与出路写在 ACCEPT_GATE_SILENCE_MS 的注释里。同理，结论只摆证据和两种读法，
//     不替人断言「就是卡住」或「就是在爬」—— 卡死的进程一样可以一直打心跳。
//  ② **谁写的日志按字节偏移认，不按文本前缀猜**。被测命令完全可以打印 `[ash] ...`，
//     按前缀过滤会把它当成我们自己的心跳删掉，于是「停在哪一行」指向更早的一行甚至没有。
//
// 现场由调用方在**所有人都写完之后**追加（见 accept-gate.ts 的 settleGate）：回显给界面
// 和 agent 的只有最后 ACCEPT_GATE_TAIL_BYTES 个字节，而停止期命令自己吐的清理输出、
// 结算摘要都排在我们后面，谁最后写谁才真的在尾巴里。
import { statSync } from "node:fs";
import { ACCEPT_GATE_PROGRESS_MS, ACCEPT_GATE_SILENCE_MS, ACCEPT_GATE_TIMEOUT_MS } from "@ash/shared/accept-gate";
import { acceptGateLogTailBytes, appendGateLog } from "./accept-gate-process.js";

/** 采样间隔。一次只是 `statSync` 一下；「最后一次输出」取的是文件 mtime，不是这个节拍。 */
const SAMPLE_MS = 30_000;

/** 「停在这一行」最多给多少字符：一行超长的 JSON 会把有限的日志尾巴整个吃掉。 */
const LAST_LINE_MAX = 160;

/** 找「停在这一行」时往回读多少字节。 */
const LAST_LINE_SCAN_BYTES = 8000;

/** 产出节奏最多列多少个采样点，多了从最早的开始省略。 */
const MAX_MARKS = 24;

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

/** 撞上时限那一刻的现场。`gateWatchReport` 把它翻译成人话。 */
export type GateWatchScene = {
  elapsedMs: number;
  limitMs: number;
  /** 距离命令**自己**最后一次有输出过了多久（我们写的进度行不算）。 */
  silentMs: number;
  /** 这条命令从头到尾有没有出过东西。全程安静和「出过、后来不出了」是两回事。 */
  everProduced: boolean;
  /** 命令最后吐出来的那一行。 */
  lastLine: string | null;
  /** 命令自己产出的字节数（不含进度行，也不含开跑前就在的启动说明）。 */
  bytes: number;
  /** 产出节奏采样点，形如 `5.0m/4.1KB`。 */
  marks: string[];
  /** 静默到多久就该喊一声，用来说明「最后那段算不算长」。 */
  silenceMs: number;
};

export type GateWatchVerdict = {
  /** 追加到日志**最后**的那一段。调用方负责在所有人写完之后再追加它。 */
  scene: string;
  /** 落进任务时间线的一句话。 */
  note: string;
};
export type GateWatch = { stop: () => void };

const minutes = (ms: number): string => (Math.max(0, ms) / 60_000).toFixed(1);
const size = (bytes: number): string => bytes < 1024 ? `${bytes}B` : `${(bytes / 1024).toFixed(1)}KB`;

function fileStat(path: string): { size: number; mtimeMs: number } {
  try { const info = statSync(path); return { size: info.size, mtimeMs: info.mtimeMs }; }
  catch { return { size: 0, mtimeMs: 0 }; }
}

/**
 * 日志里命令**自己**最后吐的那一行。
 *
 * `own` 是我们自己写进去的那些字节区间（绝对偏移）。先把它们原地抹成换行再切行 ——
 * 这样既不会把命令的同前缀输出误删，也不会让「命令没写换行就静了」时它和我们的心跳
 * 粘成一行（第 1 轮审查 F3 / N2）。
 */
function lastCommandLine(logPath: string, own: [number, number][]): string | null {
  const { buf, start } = acceptGateLogTailBytes(logPath, LAST_LINE_SCAN_BYTES);
  if (buf.length === 0) return null;
  for (const [from, to] of own) {
    const begin = Math.max(0, from - start);
    const end = Math.min(buf.length, to - start);
    if (end > begin) buf.fill(0x0a, begin, end);
  }
  const lines = buf.toString("utf8").split(/[\r\n]+/)
    .map(line => line.replace(/\u001B\[[0-9;]*[A-Za-z]/g, "").trim())
    .filter(line => line.length > 0);
  const last = lines.at(-1);
  if (!last) return null;
  return last.length > LAST_LINE_MAX ? `${last.slice(0, LAST_LINE_MAX)}…` : last;
}

/**
 * 现场 → 人话。两份措辞：`scene` 落进日志尾巴，`note` 落进任务时间线（刷新后还看得见，
 * 用户不点开日志也知道该往哪儿查）。
 *
 * **只摆证据和读法，不替人下判决**（第 1 轮审查 F1）：长时间零输出里既有「卡住了」，
 * 也有「这条命令本来就有安静的一段 / 它把输出重定向到别处了」；持续输出里既有「在爬」，
 * 也有「卡死在打心跳」。把这两种可能一起写出来，比给一个听上去很确定的错误方向有用。
 */
export function gateWatchReport(scene: GateWatchScene): GateWatchVerdict {
  const quiet = scene.silentMs >= scene.silenceMs;
  const stoppedAt = scene.lastLine ? `\`${scene.lastLine}\`` : "（这条命令没有往门禁日志里写过任何东西）";
  const reading = !scene.everProduced
    ? `它从头到尾没往门禁日志里写过东西 —— 可能是它把输出重定向到别处了，也可能真的一步都没走成。`
      + `先确认这条命令平时会不会往 stdout 打东西，再决定是查它的另一份日志还是查它卡在哪。`
    : quiet
      ? `最后 ${minutes(scene.silentMs)} 分钟一个字节都没有。**更像**是停在上面那一行之后的某一步 `
        + `（它的断言可能早跑完了，是进程 —— 浏览器、开发服务 —— 没退出）；但日志只能证明有没有在输出，`
        + `安静地编译/等远端的命令也长这样。`
      : `直到被收掉它都还在出东西（最近一次 ${minutes(scene.silentMs)} 分钟前）。**更像**是整条命令在爬 `
        + `（对着产出节奏看它是一直这么慢，还是从某个点起慢下来 —— 后者多半是那时有别的活在抢机器）；`
        + `但一直在打印不等于在前进，卡死在打心跳也长这样。`;
  const log = [
    "",
    "[ash] ──── 被收掉时的现场 ────",
    `[ash] 跑了 ${minutes(scene.elapsedMs)} 分钟（上限 ${minutes(scene.limitMs)} 分钟），命令自己的输出累计 ${size(scene.bytes)}。`,
    `[ash] 最后一次有输出在 ${minutes(scene.silentMs)} 分钟前，即开跑后第 ${minutes(scene.elapsedMs - scene.silentMs)} 分钟。`,
    `[ash] 停在这一行：${stoppedAt}`,
    `[ash] 产出节奏（开跑第几分钟 / 累计输出）：${scene.marks.length ? scene.marks.join(" ") : "（没跑够一个采样间隔）"}`,
    `[ash] 怎么读：${reading}`,
    "",
  ].join("\n");
  const note = !scene.everProduced
    ? `跑满 ${minutes(scene.elapsedMs)} 分钟被收掉，期间它一个字节都没往门禁日志里写过。`
    : `跑满 ${minutes(scene.elapsedMs)} 分钟被收掉，停在 ${stoppedAt}，最近一次输出在 ${minutes(scene.silentMs)} 分钟前、`
      + `累计产出 ${size(scene.bytes)}${quiet ? "，最后那段是完全静止的。" : "，到最后都还在出东西。"}`;
  return { scene: log, note };
}

/**
 * 起一个看门的。`onVerdict` 只会被叫到一次（撞上时限），**它不负责收掉命令**，也不负责
 * 把现场写进日志 —— 现场得排在所有人后面写，由调用方在结算末尾追加。
 */
export function startGateWatch(opts: { logPath: string; onVerdict: (verdict: GateWatchVerdict) => void }): GateWatch {
  const timings = timingsNow();
  const startedAt = Date.now();
  // `counted` = 已经计过账的文件长度；`base` = 开跑前就在那儿的启动说明；`ownBytes` = 我们
  // 自己写进去的进度行。命令自己的产出 = counted - base - ownBytes（第 1 轮审查 N1）。
  const base = fileStat(opts.logPath).size;
  let counted = base;
  let ownBytes = 0;
  const own: [number, number][] = [];
  let lastOutputAt = startedAt;
  let everProduced = false;
  let noticedSilence = false;
  let nextProgressAt = startedAt + timings.progressMs;
  const marks: string[] = [];
  let finished = false;

  /** 自己往日志里写一行，并把写进去的字节区间记下来 —— 既不算命令的产出，也不算它的输出时刻。 */
  const writeOwn = (text: string): void => {
    const before = fileStat(opts.logPath).size;
    // 命令可能停在一行的半中间（没写换行）。贴着它写会把两边粘成一行。
    const glued = before > 0 && acceptGateLogTailBytes(opts.logPath, 1).buf.at(0) !== 0x0a;
    const payload = glued ? `\n${text}` : text;
    appendGateLog(opts.logPath, payload);
    const after = fileStat(opts.logPath).size;
    // 认领的区间**最多**是自己写的那么多字节：命令正好在这中间也写了一笔的话，按「写之前
    // 的长度」认领会把它那几个字节也抹掉。取两者里更靠后的那个边界。
    const from = Math.max(before, after - Buffer.byteLength(payload));
    if (after > from) { own.push([from, after]); ownBytes += after - from; }
    counted = Math.max(counted, after);
  };

  const tick = (): void => {
    if (finished) return;
    const at = Date.now();
    const info = fileStat(opts.logPath);
    if (info.size > counted) {
      counted = info.size;
      everProduced = true;
      // 取 mtime 而不是这一拍的时刻：命令可能在上一拍刚过就写完了，按节拍记会凭空多算
      // 一个采样间隔的静默（第 1 轮审查 N3）。
      lastOutputAt = Math.min(at, info.mtimeMs || at);
      noticedSilence = false;
    }
    const silentMs = at - lastOutputAt;
    if (at >= nextProgressAt) {
      nextProgressAt = at + timings.progressMs;
      const produced = Math.max(0, counted - base - ownBytes);
      marks.push(`${minutes(at - startedAt)}m/${size(produced)}`);
      writeOwn(`[ash] 进度 · 开跑后 ${minutes(at - startedAt)} 分钟 · 已产出 ${size(produced)}`
        + ` · 最近一次输出在 ${minutes(silentMs)} 分钟前\n`);
    }
    if (!noticedSilence && silentMs >= timings.silenceMs) {
      noticedSilence = true;
      // 只喊一声。要不要现在就收掉它由人决定（验收台上那颗「取消」），理由见
      // ACCEPT_GATE_SILENCE_MS 的注释。
      writeOwn(`[ash] 注意 · 已经连续 ${minutes(silentMs)} 分钟没有任何输出；命令仍在跑，没有被收掉。\n`);
    }
    if (at - startedAt >= timings.timeoutMs) {
      finished = true;
      clearInterval(handle);
      opts.onVerdict(gateWatchReport({
        elapsedMs: at - startedAt, limitMs: timings.timeoutMs, silentMs, everProduced,
        silenceMs: timings.silenceMs,
        lastLine: lastCommandLine(opts.logPath, own),
        bytes: Math.max(0, counted - base - ownBytes),
        marks: marks.length > MAX_MARKS ? ["…", ...marks.slice(-MAX_MARKS)] : marks,
      }));
    }
  };

  const handle = setInterval(tick, Math.max(1, timings.sampleMs));
  handle.unref?.();
  return { stop: () => { finished = true; clearInterval(handle); } };
}
