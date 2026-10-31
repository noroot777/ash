// 回合级**停滞看门狗**:这一轮还在不在往前走。
//
// 起因(2026-10-30,任务 W54czudPJ9Q9 的修复回合):模型上游所在的中转主机整体离线,codex
// 自己无限重连了 4 小时 45 分 —— 事件流 254 行里 216 条是 `willRetry:true` 的
// 「Reconnecting... waiting for network」,模型零输出、零工具调用。而 ash 全程**无任何报错、
// 无超时**,界面一直显示 running。三层叠加造成的:
//   ① 执行器把 `willRetry` 的错误有意静默丢掉(防瞬时抖动刷屏,本意合理),却没有升级路径
//      —— 第 1 次和第 216 次重连待遇完全相同;
//   ② ash 的失败判定全是**验尸式**的(`executors/diagnostics.ts` 只在进程退出后运行),
//      进程活着 = 回合进行中,全仓没有任何回合级停滞检测;
//   ③ CLI 自身重连无上限(上游工具,不归我们改)。
// 于是「永远失败的回合」和「正常的长回合」在产品里不可区分,只能人工翻 jsonl 才看得出来。
//
// 这里补的是第 ② 层,两档:
//   • **警告档** —— 自上一条正常输出以来只收到错误事件,且(条数够 / 时间够)。落一条持久
//     可见的提示,并在任务卡片上亮出来(刷新后还在,不是只弹 toast)。
//   • **熔断档** —— 这种状态超过可配置时长,自动终止本回合、按失败结算,完整诊断进时间线。
//
// **判据必须是「自上次上游真回话以来」,不能按回合总时长**:正常的长思考、长工具调用
// (pytest 跑半小时)期间一个事件都不发也很常见,照总时长判会把干得正好的活儿误杀。这也是
// 本模块为什么**只在真的收到过错误事件时才动手** —— 纯静默(一个事件都没有)在这一层分辨不出
// 「上游挂住」和「工具在跑」,那一半由执行器自己负责把「我在等上游」说出来
// (`claude-stream.ts` 的 waitTimer、`codex-app-server.ts` 的 willRetry 提示),说出来了
// 才轮到这里。
//
// 「真回话」有一层细化,别退回成「不是错误就算」:adapter 自己报的那些辅助通知
// (`session` 会话身份、`context` 本地算的上下文水位、`system` 旁注)都**不是上游在回话**。
// Claude 每条重试提示后面紧跟一条 `session`,照「非错误即进展」判就是每条重试被自己后面
// 那句身份通知当场解除 —— 远超阈值也一声不响(第 2 轮审查 F1,已实测)。这一类既不解除也不
// 计数,连「卡在哪一步」都不记。判据共用 `@ash/shared/waiting` 的 `resumesWaiting`(那个文件
// 就是为了不让三处判据各自漂),钉子在 test-turn-stall.ts ③a/③b/③c 与 test-claude-retry-stall.ts。
//
// 为什么住在**消费层**而不是各执行器里:停滞这件事对 claude / codex / kimi / cursor / … 是
// 同一件事,只有「怎么把上游在重试这件事说出来」各家不同。三条消费链(single-run / duet /
// team)共用这一份,别再各内联一份;**也别在某个 adapter 里另抄一个计时器**。
//
// ── 各执行器喂进来的是什么(2026-10-30 盘点,看门狗只认 error 事件) ──────────────
// 按**错误什么时候发得出来**分三档,这三档决定了看门狗在哪几家身上真的有用:
//   ① **活动期就发错误**(回合还在跑、进程还活着就发 —— 看门狗接得住的只有这一档):
//      claude 的 `api_retry`(已抬成 `level:"notice"`,外加一个 waitTimer 专治「requesting
//      之后彻底静默」那种不重试、不报错、零事件的挂住,**两档全覆盖**);codex app-server
//      的主线程与子智能体线程(本轮修的两处,判据合到 `executors/codex-error-event.ts`:
//      重试中 = notice、重试完还是错 = 裸 error);以及 catalog 里按流内事件报错的那几家
//      —— gemini(`error` 事件,含 warning 档)、kimi、grok、kilo、opencode、cursor、qwen、
//      qoder、antigravity、pi(各自的 `result`/`turn` 失败)。**但后面这十家发的基本都是
//      终局错误**(「这一轮失败了」,发完就收尾),不是「我在重试」,所以看门狗在它们身上兜
//      的是另一种毛病:**报了错又不收尾**(反复报错却永不结束的回合,照总时长判抓不到)。
//   ② **只在收尾时发错误**(`catalog/parsers.ts` 的共用 `finish()`:spawn 失败、非零退出、
//      exit 0 却零输出、流没收尾)—— 全是验尸式的,那时回合已经结束,看门狗不参与。
//   ③ **重试被咽掉、一个字都不发**(真正的盲区):pi 的 `auto_retry_*` 只落原始 trace 不进
//      事件流(它自己的注释也写着「长时间重试时界面会显得静默」)。要补得先有真实样本,
//      本轮没动。codex 主线程从前也在这一档,就是这次事故。
// 结论:**判据与两档动手在这一份里,一处都不重复;而「我在等上游」要由各 adapter 说出来**
// —— 落在第 ③ 档的那几家,这一层给不出结论也不会乱猜(纯静默不动手,见上面一段)。
//
// 本文件**不碰库、不碰 bus**:判据是纯状态机,所以能被 `test-turn-stall.ts` 直接钉住。
// 落盘、终止回合、回收句柄由各链传进来的 `StallActions` 做;唯一的例外是
// `turn-stall-verdict.ts` —— 那也只是一张内存表,而「这一轮算失败」这个结论必须由下结论的
// 这一方写下,见那个文件头。
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AgentEvent } from "@ash/shared";
import { detachedPathsFor } from "./executors/detached-child.js";
import { isExecutionNotice } from "./session-notice.js";
import { RUNS_DIR } from "./paths.js";
import { runTracePaths } from "./transcript.js";
import { producesWork } from "@ash/shared/waiting";
import { markStallFailure, retireStallFailure } from "./turn-stall-verdict.js";
import { now } from "./util.js";

/** 持有者 = 此刻在消费这条会话的那个实例本身(同 session-waiting.ts 的 WaitingOwner)。 */
export type StallOwner = object;

/** 一次停滞的现场。文本由本模块统一拼(三条链的措辞不许漂),这里只带事实。 */
export interface StallFacts {
  sessionId: string;
  taskId: string;
  turnStartedAt: string;
  /** 停滞起点:**第一条错误事件的到达时刻**(见 openStall 的注释,刻意取保守的那一边)。 */
  since: string;
  /** 自那以来的错误事件总数。 */
  errors: number;
  /** 其中 `level:"notice"` 的那些 —— 「上游在重试」这一类。 */
  retries: number;
  /** 其中来自**子智能体线程**的那些(包装成 `nativeWork` 活动的,见 errorFacts)。 */
  childErrors: number;
  /** 最后一条错误的原文(已截断)。 */
  lastMessage: string;
  /**
   * 停滞**之前**这一轮最后那条正常事件是什么(`text`/`thinking`/`tool`/…),null = 这一轮从头
   * 到尾没有过正常事件。
   *
   * 诊断里「卡在哪一步」靠它:`tool` 之后挂住(工具跑完等模型总结)和一条正常输出都没有过
   * (连接从头就没建起来)是两种现场,要查的东西完全不同。
   *
   * **原始协议的 method/type 不在这一层**:那个只有 `executors/diagnostics.ts` 的
   * `RunTraceRecorder.finish()` 产出,而它是**进程退出之后**才跑的 —— 熔断这一刻进程还活着,
   * 那个对象压根不存在。同一份信息在下面 `rawLogHint` 指名的那个原始事件流文件的最后一行里。
   */
  lastProgressKind: string | null;
  elapsedMs: number;
}

export interface StallActions {
  /** 这个任务的 id —— 诊断里要给原始事件流的落点。 */
  taskId: string;
  /**
   * **警告档**:落一条持久可见的提示。
   *
   * 落点是**执行过程**(trace)而不是 `.md` 的 system 旁注:后者是回合收口之后才补落盘的,
   * 一整串提示会糊在会话结尾、离它真正发生的那一步十万八千里(用户 2026-10-21 反馈,
   * 同一个理由写在 `executors/claude-stream.ts` 的 waitTimer 那段)。
   */
  warn(text: string, facts: StallFacts): void;
  /**
   * **熔断档**:红色诊断 + 终止这一轮。
   *
   * 「这一轮算失败」这件事**本模块已经替实现方钉好了**(熔断前先写 `turn-stall-verdict.ts`,
   * 三处结算各自去读),实现方不必、也不该再去反推退出码 —— 被杀的 CLI 多半报不出非零,理由
   * 见那个文件头。这里只负责「说出来 + 让它停下」。
   */
  trip(text: string, facts: StallFacts): void;
  /**
   * **熔断的兜底**:`trip` 之后过了宽限期,这一轮**还是没真的结束**。
   *
   * 为什么要有这一档(第 1 轮审查第 4 条):`trip` 对常驻台走的是 `interrupt()`,而那只是
   * 往 stdin 写一行请求 —— 没有 ACK、没有「等回合真的结束」、也没有强杀退路。请求没人理
   * 的话,熔断就只是在时间线上说了句话,回合照旧卡着。所以熔断**以真实结束为成功条件**:
   * 没结束就在这里回收句柄/台。
   *
   * 不实现 = 这条链的 `trip` 本身就是硬终止(单飞/duet 直接 `kill()`),不需要第二档。
   */
  escalate?(text: string, facts: StallFacts): void;
  /**
   * 停滞解除(上游回话了)或回合收尾:撤掉卡片上那个持久标记。只在真的报过警时才会被调。
   *
   * **熔断之后同样会走到这里**(回合真结束时)—— 那个标记说的是「此刻正卡着」,回合都结束了
   * 它就该撤掉,持久可见的那份证据是时间线上的熔断诊断 + 任务落的失败态。不撤的那一版会把
   * 标记留在会话行上,下一轮复用同一行时 `ended_at` 一清,它又亮起来:页面上一边是正常答完
   * 的新回合、一边是红色停滞环,刷新还在(第 1 轮审查第 3 条,已实测)。
   */
  resolve(facts: StallFacts): void;
}

type Stall = StallFacts & {
  owner: StallOwner;
  sinceMs: number;
  warned: boolean;
  trippedAtMs: number | null;
  escalated: boolean;
  actions: StallActions;
};

const stalls = new Map<string, Stall>();

/** 配过一次的坏值只报一次,别让看门狗自己变成刷屏源。 */
const badEnvReported = new Set<string>();

/**
 * 读一个毫秒/条数阈值。**非有限数一律退回默认值**。
 *
 * 不校验的那一版有个很糟的失效方向(第 1 轮审查非拦项):`ASH_STALL_TRIP_MS=30m` 解析成
 * `NaN`,而 `NaN <= 0` 和 `elapsedMs < NaN` **都是 false** —— 两道闸同时放行,于是第一条
 * 错误事件就当场熔断。看门狗配错一个字就变成「见错就杀」,这比不设看门狗更坏。
 */
function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const value = Number(raw);
  if (Number.isFinite(value)) return value;
  if (!badEnvReported.has(name)) {
    badEnvReported.add(name);
    console.warn(`[ash] ${name}=${JSON.stringify(raw)} 不是数字,这一档按默认值 ${fallback} 走`);
  }
  return fallback;
}

/**
 * 阈值**每次现读**而不是模块加载时定格:回归测试要在一个进程里分阶段改口径(先钉条数档、
 * 再钉时间档),定格了就得为每一档各起一个进程。读 env 的开销只落在真有停滞时(见 evaluate)。
 *
 * 各档 `<= 0` = 关掉这一档。
 */
function thresholds() {
  return {
    /** 警告档:连续这么多条错误事件(期间上游一次都没真回话)就报。 */
    warnErrors: num("ASH_STALL_WARN_ERRORS", 5),
    /** 警告档:这种状态持续这么久也报(两个条件取或)。 */
    warnMs: num("ASH_STALL_WARN_MS", 5 * 60_000),
    /** 熔断档:这种状态持续这么久就终止本回合。 */
    tripMs: num("ASH_STALL_TRIP_MS", 30 * 60_000),
    /** 熔断之后留给「这一轮真的结束」的宽限期,过了就回收句柄(见 StallActions.escalate)。 */
    graceMs: num("ASH_STALL_TRIP_GRACE_MS", 60_000),
  };
}

const pollMs = () => Math.min(30_000, Math.max(200, num("ASH_STALL_POLL_MS", 15_000)));

let timer: NodeJS.Timeout | null = null;

/**
 * 时间档只能靠计时器:**最后一条错误事件之后可能再也没有事件了**。W54 现场的重连提示
 * 恰好每 80 秒一条,看着像能靠事件驱动走完;但同一个毛病换成「挂住之后彻底静默」
 * (2026-09-24 那次中转网关挂了 47 分钟,回合从头到尾零事件)就一条都不会来 ——
 * 事件驱动的那一版会在最后一条提示上永远停住。熔断后的宽限期同理:回合没结束就没有事件。
 *
 * 一个共享计时器扫整张表(而不是每条会话一个):停滞是少见状态,表通常是空的。
 */
function arm() {
  if (timer || stalls.size === 0) return;
  timer = setInterval(() => {
    for (const [sessionId, stall] of [...stalls]) evaluate(sessionId, stall);
    if (stalls.size === 0) disarm();
  }, pollMs());
  timer.unref?.(); // 看门狗不能拖着进程不让退
}

function disarm() {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

/**
 * 这条事件是不是一条错误 —— **穿过包装看里面那一层**。
 *
 * 子智能体(codex 的子线程、claude 的 `parent_tool_use_id` 子回合)的每一条活动都被
 * `executors/native-agent-activity.ts` 的 `childActivity()` 包成
 * `{ kind:"tool", name:"Agent", nativeWork:{ type:"activity", event } }` —— 包装层恒为
 * `tool`,真正的那条错误躺在 `nativeWork.event` 里。只看外层的那一版于是把子线程的重连
 * 风暴读成「有工具在动」:**既开不了停滞,还会把父线程已经开着的那一份当场解除**,正好
 * 把看门狗关在了最需要它的场合(第 1 轮审查第 1 条,已实测)。
 *
 * 不变量写在这一层而不是让各 adapter 改发裸 error:子线程的错误**不是**父回合的终局错误
 * (几百条重连提示不该把这一轮判成有执行故障,也不该从子智能体抽屉里跑到主时间线上),
 * 包装要留着,逻辑子线程身份也要留着 —— 所以这里顺手把「它来自子线程」一起带出去,
 * 熔断诊断要用。
 */
function errorFacts(event: AgentEvent): { message: string; notice: boolean; child: boolean } | null {
  const inner = event.kind === "tool" && event.nativeWork?.type === "activity" ? event.nativeWork.event : null;
  const err: AgentEvent | typeof inner = inner ?? event;
  if (!err || err.kind !== "error") return null;
  // notice 的判据只有一份(session-notice.ts):包装内外同一个字段、同一个含义,
  // 所以解包之后照样过那一份,别在这儿另写一遍 `level === "notice"`。
  return { message: err.message, notice: isExecutionNotice(err), child: !!inner };
}

/**
 * 「这条事件算**上游接着往下走了**吗」—— 解除停滞的唯一条件,判据**共用** `@ash/shared/waiting`
 * 的 `resumesWaiting`(text/thinking/tool/attachment/usage/turnEnd/done 算,`session`/`context`/
 * `system` 不算)。
 *
 * 自己内联一张表的那一版错在把「不是错误」读成了「有进展」(第 2 轮审查 F1,已实测):Claude
 * 的一次重试在原始流里是**两条** —— 先一条 notice error,紧跟一条 `session`(把 CLI 会话 id 报
 * 一遍)。于是每一条重试都被自己后面那句身份通知当场解除,一条永远连不上的会话报警和熔断都
 * 不会发生,页面上只有八条普通提示、任务一直显示运行中。那句话压根不是上游回话,它是适配器
 * 自己的辅助通知 —— 而这正是 `shared/src/waiting.ts` 早就写明的口径,三个维护点共一份就是为了
 * 不出现这种分叉(那个文件顶部说的就是这件事)。
 *
 * 所以三档,不是两档:
 *   · **进展**(`resumesWaiting`)→ 熔断前解除停滞;
 *   · **错误**(穿过子智能体包装,见 errorFacts)→ 计入停滞;
 *   · **其余**(`session`/`context`/`system`)→ 既不计入也不解除,一个字都不动。
 *
 * 第三档刻意排在「宁可漏判不误杀」那一侧之外:它们不是进展的证据,但也不是停滞的证据。真的
 * 恢复了,紧跟着就会有正文/工具/收尾事件,那一条才解除。
 */
// 「上游真回话了吗」的判据整份住在 `@ash/shared/waiting`(producesWork):包装恒为
// `kind:"tool"`,照外层判等于「子线程有任何动静都算进展」,而**包装不是进展,里面那条才算**
// (与 errorFacts 同一道穿透)。上一版只穿透了 `activity` 一种包装,`type:"agent"` 的状态
// 通知仍从默认分支漏过去 —— 一条「仍在运行」的心跳就能解除停滞(审查 F1,已实测)。
const isProgress = (event: AgentEvent): boolean => producesWork(event);

/**
 * 这一轮最后那条**正常**事件是什么 kind,按持有者记(见 StallFacts.lastProgressKind)。
 *
 * 用 WeakMap 挂在持有者对象上而不是一张按 sessionId 的表:持有者就是此刻在消费这条流的那个
 * 句柄/台,它被回收时这条记录跟着没,不需要任何清理路径 —— 而按 sessionId 的表就得为每条活着
 * 的会话各记一份、还得保证收尾时删掉。带上回合身份是因为常驻台一个持有者吃很多轮。
 *
 * 代价是每条正常事件一次 WeakMap.set(正文 delta 也算,那是最密的一路)。量级上可忽略,但它
 * 确实排在下面那句「热路径在这儿就走掉」之前,所以摆在明处:换来的是熔断诊断说得出「卡在哪
 * 一步」,而不是只能说「什么都没有」。
 */
const lastProgress = new WeakMap<StallOwner, { turn: string; kind: string }>();

/**
 * 事件消费链上的每一条 agent 事件都过这里。
 *
 * 口径(与「自上次**有进展**以来只有错误事件」逐字对应,三档见上面的 `isProgress`):
 *   · 进展事件 → 停滞解除;适配器的辅助通知(`session`/`context`/`system`)既不解除也不计入。
 *   · error 事件 → 计入停滞。`level:"notice"`(上游在重试)另记一笔,诊断文案要用。
 *     真故障(非 notice)**同样计入**:它既不是进展,也不该把 30 分钟的钟重置掉 —— 一个每隔
 *     几分钟报一次真错、却永远不收尾的回合跟重连循环是同一个毛病。
 *   · 两侧都**穿过子智能体包装**判(见 errorFacts):包装不是进展。
 *
 * `turnStartedAt` 给 null = 这一刻还没有回合身份:一条都不记(同 session-waiting.ts ——
 * 没有回合的提示记下来只会挂在一个与它无关的回合名下,熔断更不该在没有身份时动手)。
 */
export function trackTurnStall(
  sessionId: string,
  owner: StallOwner,
  turnStartedAt: string | null,
  event: AgentEvent,
  actions: StallActions,
): void {
  const err = errorFacts(event);
  if (!err) {
    // 第三档:既不是进展也不是错误(适配器的辅助通知)—— 一个字都不动,连 lastProgressKind
    // 都不记,否则熔断诊断会把「卡在哪一步」说成那句身份通知。
    if (!isProgress(event)) return;
    if (turnStartedAt) lastProgress.set(owner, { turn: turnStartedAt, kind: event.kind });
    if (stalls.size === 0) return; // 热路径(正文 delta)在这儿就走掉
    const held = stalls.get(sessionId);
    // 持有者不符 = 迟到的旧台输出,无权解除接管那台的停滞(同 session-waiting.ts 的换台闸)。
    if (!held || held.owner !== owner) return;
    // **熔断之后,这一条不再是「观察」,而是一份没兑现的终止义务** —— 普通进展事件撤不动它。
    //
    // 分两档是刻意的(第 2 轮审查 F1,已实测):
    //   · 熔断**之前**:任何进展事件都解除(判据见上面的 isProgress)。
    //   · 熔断**之后**:`trip` 对常驻台走的是 request-only 的 `interrupt()`,而「有事件到达」
    //     压根证明不了那个请求生效了。照上一档解除的那一版于是把 grace 兜底一起撤掉:页面上
    //     「已自动终止本回合并按失败结算」已经写着了,任务却永远停在运行中、连停滞环都灭了
    //     (resolve 把标记撤了),刷新后还是这个矛盾。
    // 所以终止义务只有两个出口:**同一 owner+回合真的收口**(三条链各自的 turnEnd / 收流
    // finally / closeLead → clearTurnStall),或者**这台明确退役**(retireLead → clearTurnStall)。
    // 两个出口都走 clearTurnStall,不经过这里。
    if (held.trippedAtMs !== null) return;
    close(sessionId, held);
    return;
  }
  if (!turnStartedAt) return;
  const held = stalls.get(sessionId);
  // 换台或换轮都从这一条重新起:新持有者报的第一条错误就是**认领**。
  const stall = held && held.owner === owner && held.turnStartedAt === turnStartedAt
    ? held
    : openStall(sessionId, owner, turnStartedAt, actions);
  stall.actions = actions;
  stall.errors += 1;
  if (err.notice) stall.retries += 1;
  if (err.child) stall.childErrors += 1;
  stall.lastMessage = err.message.slice(0, 300);
  evaluate(sessionId, stall);
}

function openStall(
  sessionId: string,
  owner: StallOwner,
  turnStartedAt: string,
  actions: StallActions,
): Stall {
  const at = now();
  const stall: Stall = {
    sessionId,
    taskId: actions.taskId,
    turnStartedAt,
    // 真实停滞起点在「上一条正常输出」和「第一条错误」之间,我们只记得住后者。取它 =
    // 测出来的停滞时长**偏短**,于是熔断**偏晚** —— 宁可晚杀,不可早杀。为此不必给每条
    // 活着的会话都记一份 lastProgressAt(那是一张跟会话数同阶的表,只为了换早几十秒)。
    since: at,
    sinceMs: Date.parse(at),
    errors: 0,
    retries: 0,
    childErrors: 0,
    lastMessage: "",
    // 这一轮停滞之前最后那条正常事件。身份不符 = 那是上一轮的,不算(常驻台一个持有者吃很多轮)。
    lastProgressKind: ((prior) => (prior?.turn === turnStartedAt ? prior.kind : null))(lastProgress.get(owner)),
    elapsedMs: 0,
    owner,
    warned: false,
    trippedAtMs: null,
    escalated: false,
    actions,
  };
  // 顶掉的那一条也算退场:同一条会话上换了持有者或换了轮(认领语义见上面那句三元),
  // 旧那份从此再不会被 evaluate 碰到,它的失败判决于是进入孤立时效(见 turn-stall-verdict.ts)。
  // 不走 `close`:那会顺手撤掉持久标记,而这条路上标记该归新认领的那一轮管。
  const displaced = stalls.get(sessionId);
  if (displaced) retire(displaced);
  stalls.set(sessionId, stall);
  arm();
  return stall;
}

/**
 * 这条停滞记录离开状态机了 → 把它那份失败判决标成「已退场」。
 *
 * **只对熔断过的那些有意义**(没熔断就没有判决,那边是空转)。判决本身绝不在这里删:退场
 * 之后紧接着就是消费链读它、结算、再销账,删早一步那一轮就又会被记成正常完成(第 2、3 轮
 * 审查同一处的两次打回,理由写在 turn-stall-verdict.ts 的 ORPHAN_MS 上)。
 */
function retire(stall: Stall): void {
  if (stall.trippedAtMs === null) return;
  retireStallFailure(stall.sessionId, stall.turnStartedAt);
}

const factsOf = (stall: Stall): StallFacts => ({
  sessionId: stall.sessionId,
  taskId: stall.taskId,
  turnStartedAt: stall.turnStartedAt,
  since: stall.since,
  errors: stall.errors,
  retries: stall.retries,
  childErrors: stall.childErrors,
  lastMessage: stall.lastMessage,
  lastProgressKind: stall.lastProgressKind,
  elapsedMs: stall.elapsedMs,
});

/** 停滞结束(上游回话 / 回合收尾 / 熔断后回合真的结束了):报过警就得把那个标记撤掉。 */
function close(sessionId: string, stall: Stall): void {
  stalls.delete(sessionId);
  if (stalls.size === 0) disarm();
  retire(stall);
  if (!stall.warned) return;
  try {
    stall.actions.resolve(factsOf(stall));
  } catch (error) {
    console.warn(`[ash] 撤销会话 ${sessionId} 的上游停滞标记失败:`, error);
  }
}

function evaluate(sessionId: string, stall: Stall): void {
  const { warnErrors, warnMs, tripMs, graceMs } = thresholds();
  stall.elapsedMs = Math.max(0, Date.now() - stall.sinceMs);
  const facts = factsOf(stall);
  if (!stall.warned
    && ((warnErrors > 0 && stall.errors >= warnErrors) || (warnMs > 0 && stall.elapsedMs >= warnMs))) {
    stall.warned = true;
    try {
      stall.actions.warn(stallWarningText(facts), facts);
    } catch (error) {
      console.warn(`[ash] 落会话 ${sessionId} 的上游停滞警告失败:`, error);
    }
  }
  if (stall.trippedAtMs !== null) {
    // 已经熔断过了。**这一条不摘牌**:熔断的成功条件是「这一轮真的结束」,而那只能由消费链
    // 走到 clearTurnStall 来证明(届时 close 会把标记撤掉)。回合没结束就说明终止请求没生效,
    // 过了宽限期再升一级回收句柄 —— 只升一次,之后留在表里等真实结束。
    // 从前这里是 `stalls.delete()`,于是熔断掉的那一轮既没人兜底、标记也永远撤不掉
    // (第 1 轮审查第 3、4 条)。
    if (!stall.escalated && graceMs > 0 && Date.now() - stall.trippedAtMs >= graceMs) {
      stall.escalated = true;
      try {
        stall.actions.escalate?.(stallEscalateText(facts, graceMs), facts);
      } catch (error) {
        console.warn(`[ash] 回收会话 ${sessionId} 的停滞回合失败:`, error);
      }
    }
    return;
  }
  if (tripMs <= 0 || stall.elapsedMs < tripMs) return;
  stall.trippedAtMs = Date.now();
  const verdict = stallTripText(facts);
  // **先把「这一轮失败」存住,再动手终止。** 顺序是刻意的,而且两层都靠它:
  //   · 同进程 —— trip 会杀进程,流随即结束、消费链当场走到收尾结算,那一刻它必须已经读得到
  //     这个结论(见 turn-stall-verdict.ts);
  //   · 跨进程 —— trip 之后的两件事(时间线上写「已终止并按失败结算」、向执行器发终止请求)
  //     **都收不回来**,而 detached 的进程活得过 server 重启。判决没存住就做这两件事,就会
  //     出现「用户看到已终止、重启接管后却按正常完成结算」(第 1 轮审查 F1,已实测)。
  // 所以这里拿的是**落盘结果**而不是「调过了」:`markStallFailure` 返回即落盘(持久那一半在
  // turn-stall-journal.ts / turn-stall-persist.ts,本模块不碰盘也不碰库)。
  const durability = markStallFailure(stall.sessionId, stall.turnStartedAt, verdict);
  // 没存住照样终止 —— 那一轮确实该停;但要**如实说一句**,别让用户以为这个结论一定还在。
  const text = durability === "lost-on-restart" ? `${verdict}\n${stallVolatileVerdictText()}` : verdict;
  try {
    stall.actions.trip(text, facts);
  } catch (error) {
    console.warn(`[ash] 熔断会话 ${sessionId} 的停滞回合失败:`, error);
  }
}

/**
 * 这条会话的消费结束了 / 换台了:**自己持有的**那份停滞状态跟着作废。
 *
 * 身份不符就是空转(被接管的旧台收尾时会走到这里,那一刻状态已经归新台了)。
 */
export function clearTurnStall(sessionId: string, owner: StallOwner): void {
  const held = stalls.get(sessionId);
  if (!held || held.owner !== owner) return;
  close(sessionId, held);
}

const minutes = (ms: number): string => {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} 秒`;
  return `${Math.round(ms / 60_000)} 分钟`;
};

/** 错误条数 + 其中多少条是重试提示 + 多少条来自子智能体线程。措辞不该把三种混成一种。 */
const tally = (facts: StallFacts): string => {
  const head = facts.retries >= facts.errors
    ? `共 ${facts.errors} 条,全部是上游重试提示`
    : `共 ${facts.errors} 条,其中 ${facts.retries} 条是上游重试提示`;
  if (!facts.childErrors) return head;
  return `${head};${facts.childErrors === facts.errors ? "全部" : `其中 ${facts.childErrors} 条`}来自子智能体线程`;
};

const lastLine = (facts: StallFacts): string =>
  facts.lastMessage ? `最后一条:${facts.lastMessage}` : "最后一条错误没有附带说明。";

/** 卡在哪一步 —— 「工具跑完等模型总结」和「一条正常输出都没有过」是两种现场。 */
const stalledAfter = (facts: StallFacts): string =>
  facts.lastProgressKind
    ? `停滞前这一轮最后一条正常事件是 ${facts.lastProgressKind}。`
    : "这一轮从头到尾没有过任何正常事件(连接多半压根没建起来)。";

/**
 * 原始事件流的**落点**。
 *
 * 给目录是不够的 —— 一个任务目录下几十个文件,出事那一轮是哪一个得人去猜(第 1 轮审查
 * 非拦项)。两组文件名都是 `(sessionId, 回合起点)` 的纯函数(`detachedPathsFor` /
 * `runTracePaths`),所以这里能算出确切路径;`existsSync` 过一遍只报真的存在的那几个,
 * 免得指一个不存在的文件给用户。都不存在就退回目录。
 */
function rawLogHint(facts: StallFacts): string {
  const dir = join(RUNS_DIR, facts.taskId);
  const candidates = [
    detachedPathsFor(dir, facts.sessionId, facts.turnStartedAt).out,
    runTracePaths(dir, facts.sessionId, facts.turnStartedAt).eventsPath,
  ];
  const found = candidates.filter((path) => {
    try {
      return existsSync(path);
    } catch {
      return false;
    }
  });
  return found.length ? found.join("；") : `${dir}(本回合未单独落原始事件流)`;
}

/** 警告档的文案。落进执行过程里它发生的那个位置,所以写成「此刻怎么了」。 */
export function stallWarningText(facts: StallFacts): string {
  return `〔上游停滞〕自上一条正常输出以来只收到错误事件(${tally(facts)}),已经 ${minutes(facts.elapsedMs)}`
    + `没有任何模型输出或工具调用 —— 多半是模型上游连不上。${lastLine(facts)}`;
}

/** 熔断档的文案:完整诊断(重试次数、停滞起点、原始日志落点、怎么续)+ 阈值怎么调。 */
export function stallTripText(facts: StallFacts): string {
  return `〔上游停滞·已自动终止本回合〕自 ${facts.since} 起连续 ${minutes(facts.elapsedMs)}`
    + `只收到错误事件、没有任何模型输出或工具调用(${tally(facts)}),判定模型上游连不上,`
    + `已终止本回合并按失败结算。${stalledAfter(facts)}${lastLine(facts)}\n`
    + `原始事件流:${rawLogHint(facts)}(会话 ${facts.sessionId},回合起于 ${facts.turnStartedAt})\n`
    + "可直接重试续跑,或换一个执行器/供应商再跑。"
    + "熔断时长由 ASH_STALL_TRIP_MS 配置(默认 30 分钟,置 0 关闭);"
    + "警告档是 ASH_STALL_WARN_ERRORS(默认 5 条)与 ASH_STALL_WARN_MS(默认 5 分钟)。";
}

/**
 * 判决**没能存住**时补在熔断诊断后面的一句。
 *
 * 为什么要说出来:这一轮照常被终止、照常按失败结算,但那个结论只在当前进程的内存里 —— 如果
 * ash 在这一轮结算完之前重启,接管的新进程读不到它,这一轮可能又显示成「已完成」。这正是
 * F1 那条路,出现过一次就不该再让用户自己去猜。
 */
export function stallVolatileVerdictText(): string {
  return "注意:这个结论没能写进磁盘(多半是磁盘满或权限问题),"
    + "如果 ash 在本回合结算完之前重启,它可能重新显示成已完成 —— 以这条诊断为准。";
}

/** 兜底档的文案:终止请求没生效,这一轮是被**回收句柄**结束的 —— 如实说,别冒充前一句。 */
export function stallEscalateText(facts: StallFacts, graceMs: number): string {
  return `〔上游停滞·终止请求未生效,已回收进程〕${minutes(graceMs)}前已请求终止这一停滞回合,`
    + `到现在仍未收到回合结束 —— 改为直接回收它的进程。这一轮仍按失败结算(${tally(facts)})。\n`
    + "宽限期由 ASH_STALL_TRIP_GRACE_MS 配置(默认 60 秒,置 0 关闭这一档)。";
}

/** 只给回归测试:把表清干净,免得上一段的残留影响下一段。 */
export function __resetTurnStalls(): void {
  stalls.clear();
  badEnvReported.clear();
  disarm();
}
