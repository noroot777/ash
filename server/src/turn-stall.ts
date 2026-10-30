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
// **判据必须是「自上次非错误事件以来」,不能按回合总时长**:正常的长思考、长工具调用
// (pytest 跑半小时)期间一个事件都不发也很常见,照总时长判会把干得正好的活儿误杀。这也是
// 本模块为什么**只在真的收到过错误事件时才动手** —— 纯静默(一个事件都没有)在这一层分辨不出
// 「上游挂住」和「工具在跑」,那一半由执行器自己负责把「我在等上游」说出来
// (`claude-stream.ts` 的 waitTimer、`codex-app-server.ts` 的 willRetry 提示),说出来了
// 才轮到这里。
//
// 为什么住在**消费层**而不是各执行器里:停滞这件事对 claude / codex / kimi / cursor / … 是
// 同一件事,而 error 事件的语义各家不同(盘点见 docs 与本轮收尾说明)。各 adapter 只负责把
// 「上游在重试」如实抬成 `kind:"error" + level:"notice"` 事件,判据与动手一律在这一份里 ——
// 三条消费链(single-run / duet / team)共用它,别再各内联一份。
//
// ── 各执行器喂进来的是什么(2026-10-30 盘点,看门狗只认 `kind:"error"`) ────────────
// 这一层只能看见各 adapter**肯发出来**的 error 事件,所以盘点的结论同时就是覆盖面:
//   · claude(`executors/claude-stream.ts`)—— 已经是对的那一家:`api_retry` 每次抬成
//     notice,外加一个 waitTimer(默认 5 分钟一条)专治「requesting 之后彻底静默」那种
//     不重试、不报错、零事件的挂住。**两档全覆盖。**
//   · codex app-server(主线程 + 子智能体线程)—— 本轮修的两处,判据合并到
//     `executors/codex-error-event.ts`:重试中 = notice、重试完还是错 = 裸 error。
//     从前主线程整条丢掉(就是这次事故)、子线程一律裸 error(反方向的毛病)。**两档全覆盖。**
//   · codex exec(`executors/codex.ts`)—— 事件流里只有 `turn.failed` 和 `error` 两种,
//     都是终局错误、没有 willRetry 这一档,所以它要么报错收尾、要么静默。**错误一侧覆盖。**
//   · catalog 的十一家(cursor/antigravity/qwen/opencode/kimi/grok/gemini/kilo/pi/qoder/…)
//     —— 错误一律走 `catalog/parsers.ts` 那个共用 finish():spawn 失败、非零退出、exit 0
//     但零输出、流没收尾。全是**进程退出之后**才发的,所以回合进行中它们一个 error 都不发。
//     **这些家此刻只在「进程退出前报过错又不收尾」时才会被看门狗接住。** 已知唯一一处可补的
//     信号源是 pi 的 `auto_retry_*`(它自己的注释也写着「长时间重试时界面会显得静默」),
//     那几个事件现在只落原始 trace、不进事件流 —— 要补得先有真实样本,本轮没动。
// 结论:**停滞判据与两档动手在这一份里,一处都不重复;而「我在等上游」要由各 adapter 说出来**
// —— 不说出来的那几家,这一层给不出结论也不会乱猜(纯静默不动手,见上面一段)。
//
// 本文件**刻意不碰库、不碰 bus**:判据是纯状态机,所以能被 `test-turn-stall.ts` 直接钉住。
// 落盘与终止回合由各链传进来的 `StallActions` 做。
import { join } from "node:path";
import type { AgentEvent } from "@ash/shared";
import { isExecutionNotice } from "./session-notice.js";
import { RUNS_DIR } from "./paths.js";
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
  /** 最后一条错误的原文(已截断)。 */
  lastMessage: string;
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
   * **熔断档**:红色诊断 + 判这一轮失败 + 终止回合。
   *
   * 实现方必须把「这一轮算失败」也落下来(单飞是 `sawExecutionError`),**不能只靠退出码**:
   * 各执行器的 `kill()` 语义不一(codex 的 kill 会置 `stopRequested`,从而咽掉自己那份失败
   * 诊断),光杀进程有可能settle成「受控停止」而不是失败,那样用户连重试按钮都看不到。
   */
  trip(text: string, facts: StallFacts): void;
  /** 停滞解除(上游回话了)或回合收尾:撤掉卡片上那个持久标记。只在真的报过警时才会被调。 */
  resolve(): void;
}

type Stall = StallFacts & {
  owner: StallOwner;
  sinceMs: number;
  warned: boolean;
  tripped: boolean;
  actions: StallActions;
};

const stalls = new Map<string, Stall>();

/**
 * 阈值**每次现读**而不是模块加载时定格:回归测试要在一个进程里分阶段改口径(先钉条数档、
 * 再钉时间档),定格了就得为每一档各起一个进程。读 env 的开销只落在真有停滞时(见 evaluate)。
 *
 * 各档 `<= 0` = 关掉这一档。
 */
function thresholds() {
  return {
    /** 警告档:连续这么多条错误事件(期间无任何非错误事件)就报。 */
    warnErrors: Number(process.env.ASH_STALL_WARN_ERRORS ?? 5),
    /** 警告档:这种状态持续这么久也报(两个条件取或)。 */
    warnMs: Number(process.env.ASH_STALL_WARN_MS ?? 5 * 60_000),
    /** 熔断档:这种状态持续这么久就终止本回合。 */
    tripMs: Number(process.env.ASH_STALL_TRIP_MS ?? 30 * 60_000),
  };
}

const pollMs = () => Math.min(30_000, Math.max(200, Number(process.env.ASH_STALL_POLL_MS ?? 15_000)));

let timer: NodeJS.Timeout | null = null;

/**
 * 时间档只能靠计时器:**最后一条错误事件之后可能再也没有事件了**。W54 现场的重连提示
 * 恰好每 80 秒一条,看着像能靠事件驱动走完;但同一个毛病换成「挂住之后彻底静默」
 * (2026-09-24 那次中转网关挂了 47 分钟,回合从头到尾零事件)就一条都不会来 ——
 * 事件驱动的那一版会在最后一条提示上永远停住。
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

/** 这条事件算「上游接着往下走了」吗 —— 停滞判据的**唯一**解除条件。 */
const isProgress = (event: AgentEvent): boolean => event.kind !== "error";

/**
 * 事件消费链上的每一条 agent 事件都过这里。
 *
 * 口径(与「自上次非错误事件以来只有错误事件」逐字对应):
 *   · 任何**非** error 事件 → 停滞解除。`session`/`context`/`system` 也算 —— 它们虽然不是
 *     上游在回话(所以 `shared/src/waiting.ts` 的 `resumesWaiting` 不收它们),但它们证明
 *     这条流还在动,而这里要防的恰恰是「误杀还在动的回合」,保守的那一边就是解除。
 *   · error 事件 → 计入停滞。`level:"notice"`(上游在重试)另记一笔,诊断文案要用。
 *     真故障(非 notice)**同样计入**:它既不是进展,也不该把 30 分钟的钟重置掉 —— 一个每隔
 *     几分钟报一次真错、却永远不收尾的回合跟重连循环是同一个毛病。
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
  if (isProgress(event)) {
    if (stalls.size === 0) return; // 热路径(正文 delta)在这儿就走掉
    const held = stalls.get(sessionId);
    // 持有者不符 = 迟到的旧台输出,无权解除接管那台的停滞(同 session-waiting.ts 的换台闸)。
    if (!held || held.owner !== owner) return;
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
  if (isExecutionNotice(event)) stall.retries += 1;
  if (event.kind === "error") stall.lastMessage = event.message.slice(0, 300);
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
    lastMessage: "",
    elapsedMs: 0,
    owner,
    warned: false,
    tripped: false,
    actions,
  };
  stalls.set(sessionId, stall);
  arm();
  return stall;
}

/** 停滞结束(上游回话 / 回合收尾 / 已熔断):报过警就得把卡片上那个标记撤掉。 */
function close(sessionId: string, stall: Stall): void {
  stalls.delete(sessionId);
  if (stalls.size === 0) disarm();
  if (!stall.warned) return;
  try {
    stall.actions.resolve();
  } catch (error) {
    console.warn(`[ash] 撤销会话 ${sessionId} 的上游停滞标记失败:`, error);
  }
}

function evaluate(sessionId: string, stall: Stall): void {
  const { warnErrors, warnMs, tripMs } = thresholds();
  stall.elapsedMs = Math.max(0, Date.now() - stall.sinceMs);
  const facts: StallFacts = {
    sessionId: stall.sessionId,
    taskId: stall.taskId,
    turnStartedAt: stall.turnStartedAt,
    since: stall.since,
    errors: stall.errors,
    retries: stall.retries,
    lastMessage: stall.lastMessage,
    elapsedMs: stall.elapsedMs,
  };
  if (!stall.warned
    && ((warnErrors > 0 && stall.errors >= warnErrors) || (warnMs > 0 && stall.elapsedMs >= warnMs))) {
    stall.warned = true;
    try {
      stall.actions.warn(stallWarningText(facts), facts);
    } catch (error) {
      console.warn(`[ash] 落会话 ${sessionId} 的上游停滞警告失败:`, error);
    }
  }
  if (stall.tripped || tripMs <= 0 || stall.elapsedMs < tripMs) return;
  stall.tripped = true;
  // 先登记再动手:`trip` 会杀掉进程,流随即结束、消费链走到 clearTurnStall —— 表里还留着
  // 这一条的话,那次 close 会再调一次 resolve 去撤标记,把熔断诊断旁边那个卡片状态一起
  // 擦掉。所以这里先摘牌(resolve 由 trip 的实现方在失败结算里自己负责)。
  stalls.delete(sessionId);
  if (stalls.size === 0) disarm();
  try {
    stall.actions.trip(stallTripText(facts), facts);
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

/** 错误条数 + 其中多少条是重试提示。两个数都给:全是重试 ≠ 一半是真故障,措辞不该一样。 */
const tally = (facts: StallFacts): string =>
  facts.retries >= facts.errors
    ? `共 ${facts.errors} 条,全部是上游重试提示`
    : `共 ${facts.errors} 条,其中 ${facts.retries} 条是上游重试提示`;

const lastLine = (facts: StallFacts): string =>
  facts.lastMessage ? `最后一条:${facts.lastMessage}` : "最后一条错误没有附带说明。";

/** 警告档的文案。落进执行过程里它发生的那个位置,所以写成「此刻怎么了」。 */
export function stallWarningText(facts: StallFacts): string {
  return `〔上游停滞〕自上一条正常输出以来只收到错误事件(${tally(facts)}),已经 ${minutes(facts.elapsedMs)}`
    + `没有任何模型输出或工具调用 —— 多半是模型上游连不上。${lastLine(facts)}`;
}

/** 熔断档的文案:完整诊断(重试次数、停滞起点、原始日志落点、怎么续)+ 阈值怎么调。 */
export function stallTripText(facts: StallFacts): string {
  return `〔上游停滞·已自动终止本回合〕自 ${facts.since} 起连续 ${minutes(facts.elapsedMs)}`
    + `只收到错误事件、没有任何模型输出或工具调用(${tally(facts)}),判定模型上游连不上,`
    + `已终止本回合并按失败结算。${lastLine(facts)}\n`
    + `原始事件流:${join(RUNS_DIR, facts.taskId)}(会话 ${facts.sessionId},回合起于 ${facts.turnStartedAt})\n`
    + "可直接重试续跑,或换一个执行器/供应商再跑。"
    + "熔断时长由 ASH_STALL_TRIP_MS 配置(默认 30 分钟,置 0 关闭);"
    + "警告档是 ASH_STALL_WARN_ERRORS(默认 5 条)与 ASH_STALL_WARN_MS(默认 5 分钟)。";
}

/** 只给回归测试:把表清干净,免得上一段的残留影响下一段。 */
export function __resetTurnStalls(): void {
  stalls.clear();
  disarm();
}
