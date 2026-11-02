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
// 四条边界，都是审查钉下来的，别回退：
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
//  ④ **一份观测只能证明它自己那一刻的事**（第 5 轮 F1）。日志后来读不到了，末尾那一段里
//     有没有输出就是未知 —— 「读不到」推不出「没有」。所以 scene、note、进度行、静默提醒
//     共用同一条有效性：绝对断言（「全程没写过」「到最后还在出东西」）只有从头看到尾才
//     说得出口，其余一律降成「截至某时」加一句未知。**不可观测的区间也不许进静默计量**
//     （第 6 轮 F1）：「接上之前的 70 分钟看不到」不等于「那 70 分钟它没输出」。
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
  /**
   * **截至这次观测**，我们**亲眼见过**它输出没有。没见过有两种：真的没写，和那段我们
   * 看不见 —— 后者由 sinceMs/agoMs 区分。它证不了读不到的区间里有没有写。
   */
  everProduced: boolean;
  /**
   * **已确认**的静默时长。见过输出就是「距最后一次输出多久」；一次都没见过就是
   * 「从开始能确认起到现在多久」—— 接入之前那段不可观测的时间**一个毫秒都不许算进来**
   * （第 6 轮审查 F1：命令在第 69 分钟刚输出过，第 70 分钟才接上，不能报「连续静默 70 分钟」）。
   */
  silentMs: number;
  /** 命令最后吐出来的那一行；它写过东西但尾部读不出可用的一行时是 null。 */
  lastLine: string | null;
  /**
   * 这次观测离被收掉有多久。**大于 0 = 末尾这一段日志读不到**，这份观测只能证明它自己
   * 那一刻的事，不能拿来说「全程没有」「到最后还在出东西」（第 5 轮审查 F1）。
   */
  agoMs: number;
  /**
   * 基线是开跑后第几毫秒定下的。大于 0 = 开跑那一刻读不到日志，是后来才接上的，
   * 接上之前的产出算不进来，于是「它没写过东西」只能降级成未知（第 5 轮审查 N1）。
   */
  sinceMs: number;
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
  // 全篇只有一个参照点：**最后一次确认有输出距今多久**。观测本身可能是几十分钟前的，
  // 把那时候的 silentMs 直接说成「最近一次在 1 分钟前」，就是拿旧量冒充现在（第 5 轮 F1）。
  const confirmedAgoMs = seen ? seen.silentMs + seen.agoMs : 0;
  // 末尾这一段读不到：里面它有没有继续出东西、停没停，一概未知 —— 「读不到」推不出「没有」。
  const blind = !!seen && seen.agoMs > 0;
  // 开跑那一刻没读到日志，基线是后来才接上的：接上之前写没写过同样未知。
  const late = !!seen && seen.sinceMs > 0;
  // 只有「收场那一刻还读得到」才敢给这两种读法：不可观测的区间里卡住和在爬都可能发生。
  const quiet = !!seen && !blind && seen.silentMs >= scene.silenceMs;
  const running = !!seen && !blind && seen.silentMs < RECENT_OUTPUT_MS;
  // 「没写过」是一句绝对断言，只有**从头看到尾**才说得出口。
  const neverWrote = !!seen && !seen.everProduced && !blind && !late;
  const stoppedAt = !seen ? "（读不到这份日志，说不出它停在哪）"
    : seen.lastLine ? `\`${seen.lastLine}\``
      : seen.everProduced ? "（它写过东西，但日志尾部读不出可用的一行）"
        : neverWrote ? "（这条命令没有往门禁日志里写过任何东西）"
          : "（截至读得到的那一刻，它还没往门禁日志里写过东西）";
  const reading = !seen
    ? `这份日志一次都没读成功（被删掉、没权限、路径被换过都长这样），所以它写没写过、停在哪**都是未知** —— `
      + `别当成它没输出。先确认日志文件还在不在，再看命令是不是把输出写到了别处。`
    : blind
      ? `末尾这 ${minutes(seen.agoMs)} 分钟读不到这份日志（被删掉、没权限、路径被换过都长这样），`
        + `这段里它有没有继续出东西、有没有停下来，**都是未知** —— 读不到推不出没有。`
        + (seen.everProduced
          ? `能确认的只有：最后一次见到它出东西是 ${minutes(confirmedAgoMs)} 分钟前。`
          : `能确认的只有：到读得到的那一刻为止它还没写过东西，这不等于全程没写过。`)
        + `先确认日志文件还在不在，再回头判它是卡住还是在爬。`
      : neverWrote
        ? `它从头到尾没往门禁日志里写过东西 —— 可能是它把输出重定向到别处了，也可能真的一步都没走成。`
          + `先确认这条命令平时会不会往 stdout 打东西，再决定是查它的另一份日志还是查它卡在哪。`
        : !seen.everProduced
          ? `开跑那一刻读不到这份日志，是开跑后第 ${minutes(seen.sinceMs)} 分钟才接上的：接上之后这 ${minutes(seen.silentMs)} 分钟`
            + `它一个字节都没写过，**更早的那段写没写过是未知的**（那段不算在静默时长里）。先确认开跑那会儿日志为什么读不到。`
          : quiet
            ? `最后 ${minutes(seen.silentMs)} 分钟一个字节都没有。**更像**是停在上面那一行之后的某一步 `
              + `（它的断言可能早跑完了，是进程 —— 浏览器、开发服务 —— 没退出）；但日志只能证明有没有在输出，`
              + `安静地编译/等远端的命令也长这样。`
            : running
              ? `直到被收掉它都还在出东西（最近一次 ${minutes(seen.silentMs)} 分钟前）。**更像**是整条命令在爬 `
                + `（对着产出节奏看它是一直这么慢，还是从某个点起慢下来 —— 后者多半是那时有别的活在抢机器）；`
                + `但一直在打印不等于在前进，卡死在打心跳也长这样。`
              // 停在「安静了十几分钟、但还没到该喊一声的程度」这一档：两种可能都没被排除，就别选边。
              : `最近一次输出是 ${minutes(seen.silentMs)} 分钟前，既不算一直在出东西，也还没静到该喊一声。`
                + `对着产出节奏看它是一路慢下来，还是在上面那一行之后就基本停了。`;
  const bytesText = !seen ? "（读不出来）"
    : ` ${size(seen.bytes)}${blind ? `（只算到 ${minutes(seen.agoMs)} 分钟前）` : ""}`
      + `${late ? `（自开跑后第 ${minutes(seen.sinceMs)} 分钟起算）` : ""}`;
  const log = [
    "",
    "[ash] ──── 被收掉时的现场 ────",
    `[ash] 跑了 ${minutes(scene.elapsedMs)} 分钟（上限 ${minutes(scene.limitMs)} 分钟），命令自己的输出累计${bytesText}。`,
    // 没亲眼见过输出时**不存在**「最后一次输出」这个时刻：拿开跑时刻顶上去就是凭空造了
    // 一个事件时间（第 6 轮审查 F1）。只有从头看到尾才敢说「一次都没有过」。
    !seen ? `[ash] 最后一次有输出在什么时候：读不出来。`
      : seen.everProduced
        ? `[ash] 最后一次有输出在 ${minutes(confirmedAgoMs)} 分钟前，即开跑后第 ${minutes(scene.elapsedMs - confirmedAgoMs)} 分钟。`
        : late || blind
          ? `[ash] 最后一次有输出在什么时候：未知。能确认的只有 —— `
            + `${late ? `开跑后第 ${minutes(seen.sinceMs)} 分钟才接上这份日志，接上之后` : "从开跑起"}`
            + `那 ${minutes(seen.silentMs)} 分钟没有新增输出${blind ? `，再往后 ${minutes(seen.agoMs)} 分钟读不到` : ""}。`
          : `[ash] 最后一次有输出：从开跑到被收掉都没有过。`,
    `[ash] 停在这一行：${stoppedAt}`,
    ...(blind ? [`[ash] 注意：末尾 ${minutes(seen.agoMs)} 分钟读不到这份日志，上面这几个数都只到那之前；`
      + `那一段里有没有输出是未知的。`] : []),
    `[ash] 产出节奏（开跑第几分钟 / 累计输出）：${scene.marks.length ? scene.marks.join(" ") : "（没跑够一个采样间隔）"}`,
    `[ash] 怎么读：${reading}`,
    "",
  ].join("\n");
  const ran = `跑满 ${minutes(scene.elapsedMs)} 分钟被收掉`;
  const note = !seen
    ? `${ran}；这份日志读不出来，它写没写过、停在哪都没法说。`
    : blind
      ? `${ran}；${seen.everProduced
        ? `最后一次确认有输出在 ${minutes(confirmedAgoMs)} 分钟前，停在 ${stoppedAt}、累计产出 ${size(seen.bytes)}`
        : "到读得到的那一刻为止它还没写过东西"}；末尾 ${minutes(seen.agoMs)} 分钟读不到这份日志，那一段是未知的。`
      : neverWrote
        ? `${ran}，期间它一个字节都没往门禁日志里写过。`
        : !seen.everProduced
          ? `${ran}；开跑后第 ${minutes(seen.sinceMs)} 分钟才接上这份日志，从那以后它一个字节都没写过，更早的未知。`
          : `${ran}，停在 ${stoppedAt}，最近一次输出在 ${minutes(seen.silentMs)} 分钟前、`
            + `累计产出 ${size(seen.bytes)}${quiet ? "，最后那段是完全静止的。" : running ? "，到最后都还在出东西。" : "。"}`;
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
  // base/identity 在**第一次读成功**时定下，不一定是开跑那一刻：日志当时读不到（权限、
  // 文件系统抖动）不该让这个看门狗哑一整场（第 5 轮审查 N1）。代价是接上之前的产出分不出
  // 哪些是启动说明，所以那种情况下「它没写过东西」一律降级成未知，由 sinceMs 带给措辞。
  const first = sightGateLog(opts.logPath, LAST_LINE_SCAN_BYTES);
  let base = first?.length ?? null;
  let identity = first?.identity ?? null;
  // baseMono 同时是**静默计量的起点**：在它之前我们看不见这份日志，看不见就什么都证不了。
  let baseMono = startedMono;
  // 亲眼见过输出才有「最后一次输出时刻」；没见过就是 null，不拿开跑时刻冒充（第 6 轮 F1）。
  let lastOutputMono: number | null = null;
  let lastSightMono = startedMono;
  let seen: (Omit<GateSeen, "agoMs"> & { atMono: number }) | null = null;
  let noticedSilence = false;
  let noticedBlind = false;
  let nextProgressAt = startedMono + timings.progressMs;
  const marks: string[] = [];
  let finished = false;

  const tick = (): void => {
    if (finished) return;
    const at = now();
    const sight = sightGateLog(opts.logPath, LAST_LINE_SCAN_BYTES);
    if (sight && (base === null || identity === null)) {
      base = sight.length; identity = sight.identity; baseMono = at;
    }
    // 读成功、还是那份文件、长度没倒退 —— 三条都满足才拿它整块换掉 `seen`。任何一条不满足
    // 就**原样留着上一次读成功的那一份**（现场会说破它是多久以前的、那一段是未知的）：
    // 交出一份旧但自洽的事实，好过把新读数拼进旧结论（第 4 轮审查 F1）。
    const ok = !!sight && base !== null && sight.identity === identity && sight.length - base >= (seen?.bytes ?? 0);
    if (ok && sight && base !== null) {
      const bytes = Math.max(0, sight.length - base);
      if (bytes > (seen?.bytes ?? 0)) {
        // 取 mtime 而不是这一拍的时刻：命令可能在上一拍刚过就写完了，按节拍记会凭空多算
        // 一个采样间隔的静默（第 1 轮审查 N3）。mtime 是墙上时间，它比现在早多少，就从
        // 单调轴上的现在往回退多少 —— 但这段增长一定发生在上一次观测之后，所以**夹在
        // 「距上次观测多久」之内**，系统时间在这中间被校正也折不进来（第 4 轮审查 N3）。
        const age = Math.min(sight.mtimeMs ? Math.max(0, Date.now() - sight.mtimeMs) : 0,
          Math.max(0, at - lastSightMono));
        // 再夹一道：静默起点不许早于「开始能确认」那一刻 —— 更早的事我们没资格作证。
        lastOutputMono = Math.max(baseMono, at - age);
        // 又出东西了：下一段静默还得再喊一声，否则「安静 → 恢复 → 再安静」只提醒第一次
        //（第 4 轮审查 N1）。
        noticedSilence = false;
      }
      lastSightMono = at;
      seen = {
        // 见没见过输出只有一个来源:lastOutputMono 有没有被置过。两套记法会漂。
        atMono: at, bytes, everProduced: lastOutputMono !== null, lastLine: lastCommandLine(sight, base),
        // 静默从「最后一次见到输出」起算；一次都没见过就从「开始能确认」起算,不可观测的那段不计。
        silentMs: Math.max(0, at - (lastOutputMono ?? baseMono)),
        sinceMs: Math.max(0, baseMono - startedMono),
      };
    }
    const elapsedMs = at - startedMono;
    // 进度、静默提醒跟现场共用同一条有效性：**这一拍读不到日志，就不许拿上一拍的数字
    // 当现在的事实，也不许把「时间在流逝」说成「它没有任何输出」**（第 5 轮审查 F1）。
    if (at >= nextProgressAt) {
      nextProgressAt = at + timings.progressMs;
      marks.push(`${minutes(elapsedMs)}m/${ok && seen ? size(seen.bytes) : "?"}`);
      appendGateNote(opts.logPath, ok && seen
        ? `[ash] 进度 · 开跑后 ${minutes(elapsedMs)} 分钟 · 已产出 ${size(seen.bytes)} · `
          + (seen.everProduced ? `最近一次输出在 ${minutes(seen.silentMs)} 分钟前`
            : seen.sinceMs > 0 ? `接上日志之后这 ${minutes(seen.silentMs)} 分钟没见过新增输出`
              : `到现在还没见过它输出`)
        : `[ash] 进度 · 开跑后 ${minutes(elapsedMs)} 分钟 · 读不到这份日志，产出和静默时长都看不到`);
    }
    if (ok) {
      noticedBlind = false;
      if (!noticedSilence && seen && seen.silentMs >= timings.silenceMs) {
        noticedSilence = true;
        // 只喊一声。要不要现在就收掉它由人决定（验收台上那颗「取消」），理由见
        // ACCEPT_GATE_SILENCE_MS 的注释。
        appendGateNote(opts.logPath, !seen.everProduced && seen.sinceMs > 0
          // 接上之前那段看不见,不能算进「连续没有任何输出」—— 它可能正好在那会儿输出过。
          ? `[ash] 注意 · 自开跑后第 ${minutes(seen.sinceMs)} 分钟接上这份日志起，连续 ${minutes(seen.silentMs)} 分钟`
            + `没有新增输出（更早的看不到）；命令仍在跑，没有被收掉。`
          : `[ash] 注意 · 已经连续 ${minutes(seen.silentMs)} 分钟没有任何输出；命令仍在跑，没有被收掉。`);
      }
    } else if (!noticedBlind) {
      noticedBlind = true;
      appendGateNote(opts.logPath, `[ash] 注意 · 这份日志读不到了（被删掉、没权限、路径被换过都长这样）；`
        + `命令仍在跑，但它之后有没有输出都看不到了。`);
    }
    if (elapsedMs >= timings.timeoutMs) {
      finished = true;
      clearInterval(handle);
      opts.onVerdict(gateWatchReport({
        elapsedMs, limitMs: timings.timeoutMs, silenceMs: timings.silenceMs,
        seen: seen ? { bytes: seen.bytes, everProduced: seen.everProduced, silentMs: seen.silentMs,
          lastLine: seen.lastLine, sinceMs: seen.sinceMs, agoMs: Math.max(0, at - seen.atMono) } : null,
        marks: marks.length > MAX_MARKS ? ["…", ...marks.slice(-MAX_MARKS)] : marks,
      }));
    }
  };

  const handle = setInterval(tick, Math.max(1, timings.sampleMs));
  handle.unref?.();
  return { stop: () => { finished = true; clearInterval(handle); } };
}
