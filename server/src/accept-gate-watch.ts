// 门禁跑着的那十几到九十分钟里**看着它**：记下它什么时候在出东西、什么时候不出了。
//
// 由来（用户 2026-10-26）：一次 `npm run test:accept` 跑满 90 分钟被收掉，日志里只留下
// 一句「超过 90 分钟，按超时处理」。事后翻遍那份日志也答不出最要紧的那个问题 ——
// 它是**某一步卡住了**，还是**整台机器在爬**？两种的处置完全相反：前者去找那条不肯退出
// 的用例/进程，后者去看谁在抢资源。光看「最后停在第 27 条横幅」分不出来，因为日志里
// 没有一个时间戳，没法知道那 27 条是均匀用掉 90 分钟，还是 10 分钟跑完之后干等了 80 分钟。
//
// 所以这一层只做一件事：**把时间轴补上**。
//  · 每 ACCEPT_GATE_PROGRESS_MS 记一行进度（开跑第几分钟、产出多少、静了多久）
//  · 连着 ACCEPT_GATE_SILENCE_MS 没有输出 → 喊一声（**只喊，不收掉它**）
//  （两样都落在日志**旁边**那份 .notes 里，回显给界面和 agent 的那一段仍然带着它们）
//  · 撞上时限那一刻交出一段「现场」：停在哪一行、静了多久、产出节奏是什么样
//
// 三条边界，都是审查钉下来的，别回退：
//  ① **不拿静默去掐命令**（第 1 轮 F1）。日志长不长只能证明有没有在输出，证明不了有没有
//     在前进；理由与出路写在 ACCEPT_GATE_SILENCE_MS 的注释里。同理，结论只摆证据和两种
//     读法，不替人断言「就是卡住」或「就是在爬」—— 卡死的进程一样可以一直打心跳。
//  ② **这个文件一个字节都不往门禁日志里写**（第 3 轮 F2）。进度和提示走旁边那份 .notes，
//     于是命令跑着的时候日志只有命令一个写入者，末行、字节数、更新时间直接取自它，中间
//     没有「判断来源」这一步可错。三种判来源的猜法怎么被逐一推翻，见 accept-gate-diagnosis.ts
//     的头部 —— 想在这儿「再加一道排除」之前先读那段。
//  ③ **一拍只读一次日志**（第 4 轮 F1）。末行、字节数、写没写过、静了多久全部出自同一次
//     有界观测（accept-gate-observe.ts），后到的字节只能进下一拍。分几次读就会拼出
//     「停在这一行 X、累计 26B」又「从头到尾没写过东西」这种自相矛盾的裁定。
//
// 现场也不往日志里追加，在 accept-gate.ts 的 settleGate 里**第一时间冻结存盘**：日志里
// 「谁最后写」不由我们说了算，停不掉的进程之后写的每个字节都能把它顶出可回显的那一段。
import { ACCEPT_GATE_PROGRESS_MS, ACCEPT_GATE_SILENCE_MS, ACCEPT_GATE_TIMEOUT_MS } from "@ash/shared/accept-gate";
import { appendGateNote } from "./accept-gate-diagnosis.js";
import { sightGateLog, type GateLogSighting } from "./accept-gate-observe.js";

/** 采样间隔。一次就是一回有界观测；「最后一次输出」取的是文件 mtime，不是这个节拍。 */
const SAMPLE_MS = 30_000;

/** 「停在这一行」最多给多少字符：一行超长的 JSON 会把有限的日志尾巴整个吃掉。 */
const LAST_LINE_MAX = 160;

/** 每次观测往回读多少字节（「停在这一行」就从这一段里找）。 */
const LAST_LINE_SCAN_BYTES = 8000;

/** 最近一次输出在这个数以内，才好意思说它「还在出东西」。 */
const RECENT_OUTPUT_MS = 2 * 60_000;

/** 最后一次读到日志超过这个数，现场就要说破「下面这些数是那时候的」。 */
const STALE_SIGHT_MS = 60_000;

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

/**
 * 一次有界观测里读到的全部事实。**整块一起产生、整块一起消费**：这几项之间的自洽是
 * 这个类型存在的全部理由（第 4 轮 F1），别单独取一项去跟别处的读数拼。
 */
export type GateSeen = {
  /** 命令自己产出的字节数（截止长度减掉开跑前就在的启动说明）。 */
  bytes: number;
  /** 截止之内它到底写没写过。全程安静和「出过、后来不出了」是两回事。 */
  everProduced: boolean;
  /** 距命令最后一次有输出过了多久。 */
  silentMs: number;
  /** 命令最后吐出来的那一行；它写过东西但尾部读不出可用的一行时是 null。 */
  lastLine: string | null;
  /** 这次观测离被收掉有多久。大于 0 说明之后日志就读不到了，上面几项是那时候的样子。 */
  agoMs: number;
};

/** 撞上时限那一刻的现场。`gateWatchReport` 把它翻译成人话。 */
export type GateWatchScene = {
  elapsedMs: number;
  limitMs: number;
  /** 同一次有界观测里的全部事实。null = 一次都没读成功：**未知，不是「它没输出过」**。 */
  seen: GateSeen | null;
  /** 产出节奏采样点，形如 `5.0m/4.1KB`。 */
  marks: string[];
  /** 静默到多久就该喊一声，用来说明「最后那段算不算长」。 */
  silenceMs: number;
};

export type GateWatchVerdict = {
  /** 冻结存盘的那一段。调用方负责在任何可能失败的事情之前把它存下来。 */
  scene: string;
  /** 落进任务时间线的一句话。 */
  note: string;
};
export type GateWatch = { stop: () => void };

/** 单调时钟。进程起来之后只增不减，系统时间被校正也不受影响。 */
const now = (): number => performance.now();

const minutes = (ms: number): string => (Math.max(0, ms) / 60_000).toFixed(1);
const size = (bytes: number): string => bytes < 1024 ? `${bytes}B` : `${(bytes / 1024).toFixed(1)}KB`;

/**
 * 这次观测里命令**自己**最后吐的那一行。不需要「排掉谁」：这份文件在它跑着的时候只有
 * 它一个写入者。两道截断，都不是来源推断：
 *
 *  · `base` 之前的一概不看 —— 那是开跑前 ash 写的启动说明（命令原文、快照路径…）。
 *    不截断的话，全程没输出的命令会被报成「停在 `[ash] $ <命令>`」（第 2 轮审查 R2-F1）。
 *  · 空行和纯 ANSI 控制序列不算一行。
 */
function lastCommandLine(sight: GateLogSighting, base: number): string | null {
  const from = Math.max(0, base - sight.tailStart);
  if (sight.tail.length <= from) return null;
  const lines = sight.tail.subarray(from).toString("utf8").split(/[\r\n]+/)
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
 *
 * 读不到日志时**说「未知」**（第 4 轮审查 F1）：那跟「它没输出过」指向完全不同的排查。
 */
export function gateWatchReport(scene: GateWatchScene): GateWatchVerdict {
  const seen = scene.seen;
  const quiet = !!seen && seen.silentMs >= scene.silenceMs;
  const stale = !!seen && seen.agoMs >= STALE_SIGHT_MS;
  // null 有三种事实，别混成一句话：读不到这份日志 / 从没写过 / 写过但尾部读不出可用的一行。
  const stoppedAt = !seen ? "（读不到这份日志，说不出它停在哪）"
    : seen.lastLine ? `\`${seen.lastLine}\``
      : seen.everProduced ? "（它写过东西，但日志尾部读不出可用的一行）"
        : "（这条命令没有往门禁日志里写过任何东西）";
  const reading = !seen
    ? `这份日志一次都没读成功（被删掉、没权限、路径被换过都长这样），所以它写没写过、停在哪**都是未知** —— `
      + `别当成它没输出。先确认日志文件还在不在，再看命令是不是把输出写到了别处。`
    : !seen.everProduced
      ? `它从头到尾没往门禁日志里写过东西 —— 可能是它把输出重定向到别处了，也可能真的一步都没走成。`
        + `先确认这条命令平时会不会往 stdout 打东西，再决定是查它的另一份日志还是查它卡在哪。`
      : quiet
        ? `最后 ${minutes(seen.silentMs)} 分钟一个字节都没有。**更像**是停在上面那一行之后的某一步 `
          + `（它的断言可能早跑完了，是进程 —— 浏览器、开发服务 —— 没退出）；但日志只能证明有没有在输出，`
          + `安静地编译/等远端的命令也长这样。`
        : seen.silentMs < RECENT_OUTPUT_MS
          ? `直到被收掉它都还在出东西（最近一次 ${minutes(seen.silentMs)} 分钟前）。**更像**是整条命令在爬 `
            + `（对着产出节奏看它是一直这么慢，还是从某个点起慢下来 —— 后者多半是那时有别的活在抢机器）；`
            + `但一直在打印不等于在前进，卡死在打心跳也长这样。`
          // 停在「安静了十几分钟、但还没到该喊一声的程度」这一档：两种可能都没被排除，就别选边。
          : `最近一次输出是 ${minutes(seen.silentMs)} 分钟前，既不算一直在出东西，也还没静到该喊一声。`
            + `对着产出节奏看它是一路慢下来，还是在上面那一行之后就基本停了。`;
  const log = [
    "",
    "[ash] ──── 被收掉时的现场 ────",
    `[ash] 跑了 ${minutes(scene.elapsedMs)} 分钟（上限 ${minutes(scene.limitMs)} 分钟），`
      // 空格是给数字留的，「（读不出来）」自带全角括号，再留一个就成了 `累计 （读不出来）`。
      + `命令自己的输出累计${seen ? ` ${size(seen.bytes)}` : "（读不出来）"}。`,
    seen
      ? `[ash] 最后一次有输出在 ${minutes(seen.silentMs)} 分钟前，即开跑后第 ${minutes(scene.elapsedMs - seen.silentMs - seen.agoMs)} 分钟。`
      : `[ash] 最后一次有输出在什么时候：读不出来。`,
    `[ash] 停在这一行：${stoppedAt}`,
    ...(stale ? [`[ash] 注意：上面这几个数截至 ${minutes(seen.agoMs)} 分钟前最后一次读到它，之后这份日志就读不出来了。`] : []),
    `[ash] 产出节奏（开跑第几分钟 / 累计输出）：${scene.marks.length ? scene.marks.join(" ") : "（没跑够一个采样间隔）"}`,
    `[ash] 怎么读：${reading}`,
    "",
  ].join("\n");
  const note = !seen
    ? `跑满 ${minutes(scene.elapsedMs)} 分钟被收掉；这份日志读不出来，它写没写过、停在哪都没法说。`
    : !seen.everProduced
      ? `跑满 ${minutes(scene.elapsedMs)} 分钟被收掉，期间它一个字节都没往门禁日志里写过。`
      : `跑满 ${minutes(scene.elapsedMs)} 分钟被收掉，停在 ${stoppedAt}，最近一次输出在 ${minutes(seen.silentMs)} 分钟前、`
        + `累计产出 ${size(seen.bytes)}${quiet ? "，最后那段是完全静止的。"
          : seen.silentMs < RECENT_OUTPUT_MS ? "，到最后都还在出东西。" : "。"}`
        + (stale ? `（截至 ${minutes(seen.agoMs)} 分钟前最后一次读到它。）` : "");
  return { scene: log, note };
}

/**
 * 起一个看门的。`onVerdict` 只会被叫到一次（撞上时限），**它不负责收掉命令**，也不负责
 * 存现场 —— 现场由调用方在结算的第一步冻结存盘（settleGate → freezeGateScene）。
 */
export function startGateWatch(opts: { logPath: string; onVerdict: (verdict: GateWatchVerdict) => void }): GateWatch {
  const timings = timingsNow();
  // 累计时长和两道时限走**单调时钟**：跑的过程中系统时间被校正（不是改时区）会让
  // Date.now() 的差值凭空变长变短，90 分钟这条线跟着提前或延后（第 3 轮审查 N2）。
  // 墙上时间只在一处用：把文件 mtime 换算回单调轴。
  const startedMono = now();
  // 日志长度只分两段，中间没有第三方：
  //   base   开跑前就在那儿的启动说明（命令原文、快照路径…），一个字节都不算命令的
  //   命令产出 = 截止长度 - base
  // 成立的前提是这个文件在它跑着的时候只有命令一个写入者 —— 所以我们自己的进度行在旁边
  // 那份 .notes 里，这里不写日志（第 3 轮审查 F2）。
  const first = sightGateLog(opts.logPath, LAST_LINE_SCAN_BYTES);
  const base = first?.length ?? 0;
  // 身份一变就不是同一份日志了（被轮转/删了重建），长度没法跟 base 比，这拍整个不要。
  const identity = first?.identity ?? null;
  let lastOutputMono = startedMono;
  let lastSightMono = startedMono;
  let seen: (Omit<GateSeen, "agoMs"> & { atMono: number }) | null = null;
  let noticedSilence = false;
  let nextProgressAt = startedMono + timings.progressMs;
  const marks: string[] = [];
  let finished = false;

  const tick = (): void => {
    if (finished) return;
    const at = now();
    const sight = sightGateLog(opts.logPath, LAST_LINE_SCAN_BYTES);
    // 读成功、还是那份文件、长度没倒退 —— 三条都满足才拿它整块换掉 `seen`。任何一条不满足
    // 就**原样留着上一次读成功的那一份**（现场会说破它是多久以前的）：交出一份旧但自洽的
    // 事实，好过把新读数拼进旧结论（第 4 轮审查 F1）。
    if (sight && sight.identity === identity && sight.length - base >= (seen?.bytes ?? 0)) {
      const bytes = Math.max(0, sight.length - base);
      if (bytes > (seen?.bytes ?? 0)) {
        // 取 mtime 而不是这一拍的时刻：命令可能在上一拍刚过就写完了，按节拍记会凭空多算
        // 一个采样间隔的静默（第 1 轮审查 N3）。mtime 是墙上时间，它比现在早多少，就从
        // 单调轴上的现在往回退多少 —— 但这段增长一定发生在上一次观测之后，所以**夹在
        // 「距上次观测多久」之内**，系统时间在这中间被校正也折不进来（第 4 轮审查 N3）。
        const age = Math.min(sight.mtimeMs ? Math.max(0, Date.now() - sight.mtimeMs) : 0,
          Math.max(0, at - lastSightMono));
        lastOutputMono = at - age;
        // 又出东西了：下一段静默还得再喊一声，否则「安静 → 恢复 → 再安静」只提醒第一次
        //（第 4 轮审查 N1）。
        noticedSilence = false;
      }
      lastSightMono = at;
      seen = {
        atMono: at, bytes, everProduced: bytes > 0 || (seen?.everProduced ?? false),
        silentMs: Math.max(0, at - lastOutputMono), lastLine: lastCommandLine(sight, base),
      };
    }
    const silentMs = Math.max(0, at - lastOutputMono);
    const elapsedMs = at - startedMono;
    const produced = seen ? size(seen.bytes) : "（读不到日志）";
    if (at >= nextProgressAt) {
      nextProgressAt = at + timings.progressMs;
      marks.push(`${minutes(elapsedMs)}m/${seen ? size(seen.bytes) : "?"}`);
      appendGateNote(opts.logPath, `[ash] 进度 · 开跑后 ${minutes(elapsedMs)} 分钟 · 已产出 ${produced}`
        + ` · 最近一次输出在 ${minutes(silentMs)} 分钟前`);
    }
    if (!noticedSilence && silentMs >= timings.silenceMs) {
      noticedSilence = true;
      // 只喊一声。要不要现在就收掉它由人决定（验收台上那颗「取消」），理由见
      // ACCEPT_GATE_SILENCE_MS 的注释。
      appendGateNote(opts.logPath, `[ash] 注意 · 已经连续 ${minutes(silentMs)} 分钟没有任何输出；命令仍在跑，没有被收掉。`);
    }
    if (elapsedMs >= timings.timeoutMs) {
      finished = true;
      clearInterval(handle);
      opts.onVerdict(gateWatchReport({
        elapsedMs, limitMs: timings.timeoutMs, silenceMs: timings.silenceMs,
        seen: seen ? { bytes: seen.bytes, everProduced: seen.everProduced, silentMs: seen.silentMs,
          lastLine: seen.lastLine, agoMs: Math.max(0, at - seen.atMono) } : null,
        marks: marks.length > MAX_MARKS ? ["…", ...marks.slice(-MAX_MARKS)] : marks,
      }));
    }
  };

  const handle = setInterval(tick, Math.max(1, timings.sampleMs));
  handle.unref?.();
  return { stop: () => { finished = true; clearInterval(handle); } };
}
