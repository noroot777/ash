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
// ── 静默档(2026-11-02 补):一条进展都没有过 ─────────────────────────────────────
// 上面那句「纯静默在这一层分辨不出『上游挂住』和『工具在跑』」只对**半途安静**成立。还有一种
// 现场它分辨得很清楚:**这一轮从开始到现在,一条进展事件都没有过**。健康的回合不长这样 ——
// 哪怕第一个动作就是一条跑半小时的命令,工具调用本身也是一条 `tool` 事件,瞬间就到;长思考
// 有 reasoning 增量。零进展只有两种成因,而且都是坏的:回合输入压根没送进 agent,或者连接从头
// 没建起来。
//
// 2026-11-02 任务 WfLfTjaGzcA8 就是前者(旧服务端死在「恢复线程」与「送出回合输入」之间,
// 新服务端按 pid 接管了那个闲置进程):1.5 小时零输出、零报错,`willRetry` 一条都没有,所以
// 上面那套「只认 error 事件」的判据**一拍都不会动**,界面一直显示「当前回合仍在进行」。
//
// 所以这一档的判据刻意收得极窄,窄到不可能误杀正常长回合:
//   · 由消费链在**回合开始**时显式挂上(`watchTurnSilence`),起点取回合真实起点而不是挂上的
//     那一刻 —— 接管回来的会话挂得晚,但它欠的时间是真欠的;
//   · **第一条进展事件就摘掉它**(同 `isProgress` 那份判据,`session`/`context`/`system` 不算
//     进展,这正是接管时唯一会出现的那种事件);
//   · 阈值另一套、比错误档更宽(警告 10 分钟 / 熔断 45 分钟):纯静默是更弱的证据,宁可晚杀;
//   · 期间**来了一条错误事件**就把它换成错误档那一份(`openStall`)—— 前提被推翻了,而且那边的
//     口径校得更准;沿用静默档的起点会让它比错误档该有的时刻提早熔断。
//
// ── 各执行器喂进来的是什么(2026-10-30 盘点,错误档只认 error 事件) ──────────────
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
//   ③ **重试被咽掉、一个字都不发**:pi 的 `auto_retry_*` 只落原始 trace 不进事件流(它自己的
//      注释也写着「长时间重试时界面会显得静默」)。半途安静的那一半仍然是盲区(要补得先有真实
//      样本);但这一轮**从头到尾**都没动静的那一半已经由上面的静默档盖住了,与执行器无关。
// 结论:**判据与两档动手在这一份里,一处都不重复;而「我在等上游」要由各 adapter 说出来**
// —— 落在第 ③ 档的那几家,这一层给不出结论也不会乱猜(纯静默不动手,见上面一段)。
//
// 本文件**不碰库、不碰 bus**:判据是纯状态机,所以能被 `test-turn-stall.ts` 直接钉住。
// 落盘、终止回合、回收句柄由各链传进来的 `StallActions` 做;唯一的例外是
// `turn-stall-verdict.ts` —— 那也只是一张内存表,而「这一轮算失败」这个结论必须由下结论的
// 这一方写下,见那个文件头。
import type { AgentEvent, ModelFailure } from "@ash/shared";
import { isExecutionNotice } from "./session-notice.js";
import { producesWork } from "@ash/shared/waiting";
import { markStallFailure, type StallVerdict } from "./turn-stall-verdict.js";
import {
  adoptedSilenceWarningText, silentTurnTripText, silentTurnWarningText,
  stallEscalateText, stallResumeText, stallTripText, stallVolatileVerdictText, stallWarningText,
} from "./turn-stall-text.js";
import type { StallActions, StallFacts, StallOwner } from "./turn-stall-contract.js";
import { now } from "./util.js";
import { pollMs, resetStallThresholdWarnings, thresholds } from "./turn-stall-thresholds.js";

export type { StallActions, StallFacts, StallOwner } from "./turn-stall-contract.js";

type Stall = StallFacts & {
  /**
   * 哪一档在盯它。两档的**判据、阈值和措辞都不同**,所以这一位不是装饰:
   *   · `errors`  —— 自上次有进展以来只收到错误事件(原始那一档,起点 = 第一条错误);
   *   · `silence` —— 这一轮一条进展事件都没有过(起点 = 回合真实起点,见文件头静默档那一节)。
   */
  kind: "errors" | "silence";
  /**
   * 静默档里**接管前那段核实不了**的那一种(`watchAdoptedSilence`):只警告、不熔断。它看见的只是
   * 「接管以来没有新进展」,说成「整轮零输出」并据此判失败就是替上一个进程追认(第 1 轮自由审查 F1)。
   */
  unverifiedHistory?: boolean;
  owner: StallOwner;
  sinceMs: number;
  /** 已经**通知**过了(时间线/执行过程那一条)。一次性的,不重发。 */
  warned: boolean;
  /** 持久投影已经**确认**落库了。没确认就每拍重投一次 —— 跟 `warned` 是两件事(见 `project`)。 */
  projected: boolean;
  /**
   * 已经投影出去的那个**身份**(库里 `upstream_stalled_since` 存的就是这个值),没投过是 null。
   *
   * 为什么不能直接用 `since`:换档时(静默档收到第一条错误 → 错误档)起点必须换成错误到达的
   * 时刻,否则熔断会提早整整一个「回合已经跑了多久」。可撤销那颗红环的 CAS 认的是**置上它的
   * 那一刻**(`session-stall-flag.ts` 的 `unsetStalled`),于是起点一换,旧标记就再也撤不掉 ——
   * 页面上任务已经恢复正常输出、红环却永久亮着,刷新还在(第 1 轮自由审查 F6)。
   *
   * 所以投影责任跟着这一位走、而不是跟着 `since` 走:换档时整个迁移给新的那一条(见
   * `openStall` 的 `inherit`),`close` 撤的也是这一位。
   */
  projectedSince: string | null;
  /** 此刻有一笔投影在途:别叠第二笔。 */
  projecting: boolean;
  trippedAtMs: number | null;
  escalated: boolean;
  actions: StallActions;
};

const stalls = new Map<string, Stall>();

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
export function errorFacts(event: AgentEvent): { message: string; notice: boolean; child: boolean; model: ModelFailure | null } | null {
  const inner = event.kind === "tool" && event.nativeWork?.type === "activity" ? event.nativeWork.event : null;
  const err: AgentEvent | typeof inner = inner ?? event;
  if (!err || err.kind !== "error") return null;
  // notice 的判据只有一份(session-notice.ts):包装内外同一个字段、同一个含义,
  // 所以解包之后照样过那一份,别在这儿另写一遍 `level === "notice"`。
  return { message: err.message, notice: isExecutionNotice(err), child: !!inner, model: err.model ?? null };
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
const lastProgress = new WeakMap<StallOwner, { turn: string; kind: string; noted: boolean }>();

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
    //
    // **静默档靠的正是这一条**:重启接管时唯一会出现的事件就是 `session`(会话身份报一遍),
    // 它在这里原地返回,所以那一轮仍然算「一条进展都没有」。
    if (!isProgress(event)) return;
    if (turnStartedAt) {
      // 把「这一轮产出过东西」落到进程之外去(理由见 StallActions.noteProgress)。**重试到
      // 确认**:落盘报失败就在下一条进展事件上再来一次 —— 只调一次的那一版里,一次写失败就
      // 永久留下「读侧确证没产出」这个假前提(第 2 轮自由审查 F2)。确认之后只走下面那次
      // WeakMap.set,所以热路径(正文 delta)不受影响。
      const prior = lastProgress.get(owner);
      let noted = prior?.turn === turnStartedAt && prior.noted;
      if (!noted) {
        try {
          noted = actions.noteProgress?.() ?? true; // 没实现这一档 = 这条链不需要持久那一半
        } catch (error) {
          console.warn(`[ash] 记下会话 ${sessionId} 本轮已有进展失败:`, error);
        }
      }
      lastProgress.set(owner, { turn: turnStartedAt, kind: event.kind, noted });
    }
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
  //
  // **静默档也在这里换掉**(`kind !== "errors"`):一条错误事件推翻了它的前提(「什么都没有」),
  // 而错误档的起点校得更准。沿用静默档那个起点(= 回合真实起点)会让熔断比错误档该有的时刻
  // 提早整整一个「回合已经跑了多久」,正好踩在「宁可晚杀不可早杀」的反面。
  //
  // **但背着未兑现终止义务的那一条不许被顶掉**(本轮审查 N2):熔断已经作出、话已经说出去了,
  // 顶掉它等于把 `trippedAtMs`/`escalated` 一起清零 —— 同一轮会被重新警告、重新判决一遍,
  // 宽限回收那一档也从头开始。终止义务只有两个出口(见上面那段),换档不是其中之一。
  const reusable = held && held.owner === owner && held.turnStartedAt === turnStartedAt
    && (held.kind === "errors" || held.trippedAtMs !== null);
  const stall = reusable ? held! : openStall(sessionId, owner, turnStartedAt, actions);
  stall.actions = actions;
  stall.errors += 1;
  if (err.notice) stall.retries += 1;
  if (err.child) stall.childErrors += 1;
  stall.lastMessage = err.message.slice(0, 300);
  stall.lastModel = err.model;
  evaluate(sessionId, stall);
}

/**
 * **回合开始了,盯住「它到底有没有真的跑起来」** —— 静默档的入口(判据与取舍见文件头那一节)。
 *
 * 三条消费链在**开始消费这一轮的事件流之前**各调一次。幂等:同一条会话同一轮重复调是空转。
 *
 * 为什么必须由消费链显式挂、而不是等第一条事件来开:这一档要抓的恰恰是**一条事件都不来**的
 * 回合 —— 事件驱动的开法在这种现场永远不会被触发,而那正是 2026-11-02 那次 1.5 小时零输出的
 * 形状。起点取 `turnStartedAt`(回合真实起点)而不是此刻:重启接管回来的会话挂得晚,但它欠的
 * 时间是真欠的,按此刻起算等于把已经静默掉的那段一笔勾销。
 *
 * `hadProgress` 是**这一轮在别的进程里有没有产出过东西**,由消费链从进程外那份事实读进来
 * (`turn-progress-mark.ts`;本模块不碰盘)。三档里只有「确证没有过」才允许开这一档 ——
 * 「有过」和「读不出来」一律不开:接管一个正在跑长工具的健康回合时,本进程一条进展都看不到
 * (都在 `agentOffset` 之前),光凭内存里那张 WeakMap 判等于把它和「输入压根没送到」混为一谈,
 * 而静默钟按回合真实起点算 —— 10 分钟报警、45 分钟当场杀掉(第 1 轮自由审查 F1 实测)。
 */
export function watchTurnSilence(
  sessionId: string,
  owner: StallOwner,
  turnStartedAt: string | null,
  actions: StallActions,
  hadProgress: "seen" | "none" | "unreadable" = "none",
  /**
   * 静默钟**从哪一刻起算**,缺省 = 回合身份自己那一刻。
   *
   * 只有常驻调度台要给别的值:它串行跑回合,用户插话那一轮可能在队里排了半小时,而身份就是
   * 投入那一刻 —— 按身份起算等于「刚轮到它就已经超时」,当场误杀。排过队的那一轮由所有权层
   * 记下「什么时候轮到它」(team/lead-turns.ts 的 adoptFront),这里按那一刻起算。
   *
   * 一次性任务与讨论不传:它们投入即开跑,两个时刻本来就是同一个,而保留身份那一刻才能让
   * 接管回来的会话把重启前欠的时间算进去。
   */
  clockFrom?: string | null,
): void {
  // 没有回合身份就不盯(同 trackTurnStall):记在一个与它无关的回合名下只会误杀。
  if (!turnStartedAt) return;
  // 起点读不出来也不盯 —— 拿一个 NaN 起点去算 elapsed 就是「见面就熔断」,比不盯坏得多
  // (同 `num()` 对坏 env 的态度)。
  if (!Number.isFinite(Date.parse(turnStartedAt))) return;
  const held = stalls.get(sessionId);
  // 已经在盯这一轮了(含接管回来、带着未兑现终止义务的那一条)→ 空转。
  if (held && held.owner === owner && held.turnStartedAt === turnStartedAt) return;
  // 别顶掉一条**还背着终止义务**的停滞:那份义务只有两个出口,摘牌不是其中之一(见
  // trackTurnStall 里那段)。
  if (held && held.trippedAtMs !== null) return;
  // 这一轮已经有过进展(消费链晚挂、而事件先到) → 静默档压根没有适用对象。
  if (lastProgress.get(owner)?.turn === turnStartedAt) return;
  // **进程外那份事实同理,而且它才是接管那条路上唯一看得见前半段的东西。** 这个状态机不替
  // 「说不上来」做决定:`unreadable` 在这儿一律不开 —— 拿一个核实不了的前提去杀一个可能完全
  // 健康的回合比漏判更坏。未知那一档有自己的出路,而且在**调用方**手上:它知道自己是不是从头
  // 看着这一轮的,也只有它能一边重读证明一边按「我盯得住的那段窗口」起算(见 single-run.ts
  // 那段 `unreadable` 的注释,以及 ../turn-progress-mark.ts 的 `recoverTurnProgress`)。
  if (hadProgress !== "none") {
    if (hadProgress === "unreadable") {
      console.warn(`[ash] 会话 ${sessionId} 本轮有无进展核实不了,这一档不替它下结论(出路在调用方)`);
    }
    return;
  }
  openStall(sessionId, owner, turnStartedAt, actions, "silence", clockFrom ?? turnStartedAt);
}

/**
 * 接管回来、**这一轮此前有没有产出核实不了**时的静默观察:从接管这一刻起盯「还有没有新进展」。
 *
 * 跟 `watchTurnSilence` 的 `none` 不是一件事(第 1 轮自由审查 F1):`none` 是确证整轮零产出,
 * 才有资格说「这一轮压根没跑起来」并按失败结算;这里只知道接管之后没看到新东西 —— 一个升级前
 * 开始、接管后还在跑的长工具完全合法。所以只警告(时间线一条 + 卡片红环,刷新后仍在),不熔断,
 * 让人来决定;一有进展或证明恢复读出「有过」就撤(`trackTurnStall` / `withdrawTurnSilence`)。
 */
export function watchAdoptedSilence(
  sessionId: string,
  owner: StallOwner,
  turnStartedAt: string | null,
  actions: StallActions,
  clockFrom: string,
): void {
  if (!turnStartedAt || !Number.isFinite(Date.parse(turnStartedAt))) return;
  const held = stalls.get(sessionId);
  if (held && held.owner === owner && held.turnStartedAt === turnStartedAt) return;
  if (held && held.trippedAtMs !== null) return;
  if (lastProgress.get(owner)?.turn === turnStartedAt) return;
  openStall(sessionId, owner, turnStartedAt, actions, "silence", clockFrom).unverifiedHistory = true;
}

function openStall(
  sessionId: string,
  owner: StallOwner,
  turnStartedAt: string,
  actions: StallActions,
  kind: "errors" | "silence" = "errors",
  /** 静默钟的起点,缺省 = 回合身份(见 watchTurnSilence 的 clockFrom)。 */
  clockFrom = turnStartedAt,
): Stall {
  // 静默档的起点默认是**回合真实起点**(欠的时间从那时起算,接管回来挂得晚也不打折);常驻台
  // 排过队的那一轮按「什么时候轮到它」算(clockFrom)。错误档取「第一条错误到达的时刻」,
  // 理由见下面那段。
  const at = kind === "silence"
    ? (Number.isFinite(Date.parse(clockFrom)) ? clockFrom : turnStartedAt)
    : now();
  // **顶掉的那一条如果已经把红环投影出去了,那份责任跟着走。**(第 1 轮自由审查 F6)
  //
  // 换档(静默档收到第一条错误 → 错误档)必须换起点,否则熔断提早;但撤那颗红环的 CAS 认的是
  // **置上它的那一刻**,起点一换旧标记就再也撤不掉 —— 任务恢复正常输出后红环永久亮着。所以
  // 把身份整个继承过来:红环期间不灭(它确实一直卡着),`close` 撤的也是这一位。
  //
  // 只继承**同一轮、同一持有者**的那一份:换台/换轮是另一回事,那一份的销账归旧消费链
  // (同下面那段「顶掉的那一条什么都不做」的口径)。
  const displaced = stalls.get(sessionId);
  const inherited = displaced && displaced.owner === owner && displaced.turnStartedAt === turnStartedAt
    ? displaced.projectedSince
    : null;
  const stall: Stall = {
    kind,
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
    lastModel: null,
    // 这一轮停滞之前最后那条正常事件。身份不符 = 那是上一轮的,不算(常驻台一个持有者吃很多轮)。
    lastProgressKind: ((prior) => (prior?.turn === turnStartedAt ? prior.kind : null))(lastProgress.get(owner)),
    elapsedMs: 0,
    owner,
    warned: false,
    trippedAtMs: null,
    // 继承来的那颗红环已经在库里了:不必重投,但**必须记着它**,否则没人撤得掉。
    projected: inherited !== null,
    projectedSince: inherited,
    projecting: false,
    escalated: false,
    actions,
  };
  // 顶掉的那一条**什么都不做**:同一条会话上换了持有者或换了轮(认领语义见上面那句三元),
  // 旧那份从此再不会被 evaluate 碰到,但它那份失败判决仍然归旧消费链读 —— 摘牌只证明它不再
  // 代表这条会话,不证明那条链已经读过判决(第 5 轮审查 F2),所以销账一律由读者自己做
  // (`clearStallFailure`,判据写在 turn-stall-verdict.ts 上)。
  // 也不走 `close`:那会顺手撤掉持久标记,而这条路上标记该归新认领的那一轮管。
  stalls.set(sessionId, stall);
  arm();
  return stall;
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
  lastModel: stall.lastModel,
  lastProgressKind: stall.lastProgressKind,
  elapsedMs: stall.elapsedMs,
});

/** 把**已经投影出去的那颗红环**撤掉。`close` 与迟到的投影共用,所以只有一份(身份口径见 Stall.projectedSince)。 */
function discardProjection(sessionId: string, stall: Stall): void {
  if (!stall.projectedSince) return;
  const since = stall.projectedSince;
  stall.projectedSince = null;
  try {
    stall.actions.resolve({ ...factsOf(stall), since });
  } catch (error) {
    console.warn(`[ash] 撤销会话 ${sessionId} 的上游停滞标记失败:`, error);
  }
}

/** 停滞结束(上游回话 / 回合收尾 / 熔断后回合真的结束了):报过警就得把那个标记撤掉。 */
function close(sessionId: string, stall: Stall): void {
  stalls.delete(sessionId);
  if (stalls.size === 0) disarm();
  // 判决不在这里碰:离开状态机不等于「消费链已经读过它」,销账只能由读者自己做。
  //
  // 撤的是**已经投影出去的那个身份**而不是当前起点(F6):换过档的那一条,库里存的还是上一档
  // 置上它的那一刻,拿新起点去 CAS 一个字都碰不到。没投影过(只通知过、投影还没确认落库)就
  // 没有东西要撤 —— 那一笔本来就没成功。
  discardProjection(sessionId, stall);
}

function evaluate(sessionId: string, stall: Stall): void {
  const { warnErrors, warnMs, tripMs, graceMs, silentWarnMs, silentTripMs } = thresholds();
  const silent = stall.kind === "silence";
  stall.elapsedMs = Math.max(0, Date.now() - stall.sinceMs);
  const facts = factsOf(stall);
  const warnDue = silent
    ? silentWarnMs > 0 && stall.elapsedMs >= silentWarnMs
    : (warnErrors > 0 && stall.errors >= warnErrors) || (warnMs > 0 && stall.elapsedMs >= warnMs);
  if (!stall.warned && warnDue) {
    stall.warned = true;
    try {
      stall.actions.warn(stall.unverifiedHistory ? adoptedSilenceWarningText(facts)
        : silent ? silentTurnWarningText(facts) : stallWarningText(facts), facts);
    } catch (error) {
      console.warn(`[ash] 落会话 ${sessionId} 的上游停滞警告失败:`, error);
    }
  }
  // 持久投影**单独跟**:报过警而它还没确认落库,就每拍重投一次(N1)。幂等,所以重投无害;
  // 不重投的代价是上游还断着、卡片上却永远没有那颗红环。
  if (stall.warned && !stall.projected && !stall.projecting) {
    stall.projecting = true;
    // **同步发起**(不包一层 `Promise.resolve().then`):报警和投影是同一拍里的两件事,推迟一个
    // 微任务的唯一后果是把「卡片上要亮红环」这件事排到别人后面去。
    try {
      void stall.actions.project(facts)
        // 落库确认了才记身份 —— 撤的时候要拿它做 CAS(见 close)。
        .then((ok) => {
          stall.projected = ok;
          if (!ok) return;
          stall.projectedSince = facts.since;
          // **投影是异步的,`close` 可能已经发生**:那一趟因为身份还没落定、什么都没撤,所以
          // 这颗红环现在得由这里收 —— 不然它留在库里没人管(刷新后仍亮,下一轮复用同一行时
          // `ended_at` 一清又亮起来,正是 F6 那个形状的另一条窄路)。
          if (stalls.get(sessionId) !== stall) discardProjection(sessionId, stall);
        })
        .catch((error: unknown) => {
          console.warn(`[ash] 置会话 ${sessionId} 的上游停滞标记失败(下一拍重投):`, error);
        })
        .finally(() => { stall.projecting = false; });
    } catch (error) {
      stall.projecting = false;
      console.warn(`[ash] 置会话 ${sessionId} 的上游停滞标记抛了(下一拍重投):`, error);
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
  if (stall.unverifiedHistory) return; // 只警告、不熔断(见 watchAdoptedSilence)
  const tripDue = silent ? silentTripMs : tripMs;
  if (tripDue <= 0 || stall.elapsedMs < tripDue) return;
  stall.trippedAtMs = Date.now();
  const verdict = silent ? silentTurnTripText(facts) : stallTripText(facts);
  // **先把「这一轮失败」存住,再动手终止。** 顺序是刻意的,而且两层都靠它:
  //   · 同进程 —— trip 会杀进程,流随即结束、消费链当场走到收尾结算,那一刻它必须已经读得到
  //     这个结论(见 turn-stall-verdict.ts);
  //   · 跨进程 —— trip 之后的两件事(时间线上写「已终止并按失败结算」、向执行器发终止请求)
  //     **都收不回来**,而 detached 的进程活得过 server 重启。判决没存住就做这两件事,就会
  //     出现「用户看到已终止、重启接管后却按正常完成结算」(第 1 轮审查 F1,已实测)。
  // 所以这里拿的是**落盘结果**而不是「调过了」:`markStallFailure` 返回即落盘(持久那一半在
  // turn-stall-journal.ts / turn-stall-persist.ts,本模块不碰盘也不碰库)。
  const durability = markStallFailure(stall.sessionId, stall.turnStartedAt, verdict, stall.since, stall.lastModel);
  // 没存住照样终止 —— 那一轮确实该停;但要**如实说一句**,别让用户以为这个结论一定还在。
  const text = durability === "lost-on-restart" ? `${verdict}\n${stallVolatileVerdictText()}` : verdict;
  try {
    stall.actions.trip(text, facts);
  } catch (error) {
    console.warn(`[ash] 熔断会话 ${sessionId} 的停滞回合失败:`, error);
  }
}

/**
 * 接管一个**上一个进程已经判了熔断**的回合:把那份没兑现完的终止义务放回状态机,并按同一条
 * 路兑现它。
 *
 * 为什么非得回到状态机、而不是在消费入口手动「发一句诊断 + 杀一次」(那是上一版的做法):
 * 判决跨进程留下来了,**义务没有**。义务的全部语义都住在这张表里 ——
 *   · 「终止义务只有两个出口」:熔断之后普通进展事件撤不动它,只有同一 owner+回合真的收口、
 *     或者这台明确退役才算完(见 `trackTurnStall` 里那段)。手动杀一次的话,这个回合在状态机
 *     里压根不存在,于是上游要是继续只吐错误,`tripMs` 之后它会被当成**一次全新的停滞**再
 *     宣布一遍熔断、再落一条判决。
 *   · 宽限回收那一档(`ASH_STALL_TRIP_GRACE_MS`):终止请求没生效时升一级回收句柄。手动那条
 *     路一次 `kill()` 之后就没有下文了。
 *   · 「同一份判决只兑现一次」:状态机里这一条在,下一次 `evaluate` 才知道这一轮已经宣布过
 *     熔断,不会重复发终止请求、也不会重复落判决。
 * 所以接管这条路跟熔断那条路**走同一个出口**,差别只在措辞和「判决是现做的还是读回来的」。
 *
 * 现场按判决里记的那一份还原(`verdict.since`),不是按接管这一刻 —— 持久标记的 CAS 认的是
 * 那个身份。`trippedAtMs` 反过来按**现在**算:这一次的终止请求确实是此刻发出的,宽限期该从
 * 此刻起算。
 */
export function resumeTrippedTurn(
  sessionId: string,
  owner: StallOwner,
  turnStartedAt: string,
  verdict: StallVerdict,
  actions: StallActions,
): void {
  const stall = openStall(sessionId, owner, turnStartedAt, actions);
  stall.since = verdict.since;
  const sinceMs = Date.parse(verdict.since);
  if (Number.isFinite(sinceMs)) stall.sinceMs = sinceMs;
  // 上一个进程多半已经报过警、置过持久标记 —— 当成「报过」,这一轮收口时那个标记才撤得掉。
  stall.warned = true;
  stall.trippedAtMs = Date.now();
  stall.elapsedMs = Math.max(0, stall.trippedAtMs - stall.sinceMs);
  try {
    actions.trip(stallResumeText(verdict), factsOf(stall));
  } catch (error) {
    console.warn(`[ash] 接管会话 ${sessionId} 的停滞回合、继续终止失败:`, error);
  }
}

/**
 * 这条会话的消费结束了 / 换台了:**自己持有的**那份停滞状态跟着作废。
 *
 * 身份不符就是空转(被接管的旧台收尾时会走到这里,那一刻状态已经归新台了)。
 */
/**
 * **「核实不了」后来读成了「确证零进展」**:把那条只警告的观察就地换回正常静默档。
 *
 * 两个结论都得有出边(第 2 轮自由审查 F1,实测):读出 `seen` 撤掉它(`withdrawTurnSilence`),
 * 读出 `none` 就不再是历史未知 —— 参与证明完整、记号不在,整轮确实一条进展都没有,该恢复的是
 * 正常静默计时与熔断责任。上一版只接了 `seen`,`none` 一来核验就停了,`unverifiedHistory`
 * 永远留着,一个零输出回合于是永远「进行中」。
 *
 * 不能旁路再挂一条 `watchTurnSilence`:同一持有者同一轮已经在盯,它会原地返回。所以就在这一条
 * 上换:钟改回回合真实起点(重启前欠的时间是真欠的,同 watchTurnSilence 的起算口径),警告按
 * 正常静默档的措辞重报一次;已经投影出去的红环身份(`projectedSince`)不动,撤的时候照旧认它。
 * 只换**这一轮、这个持有者、还背着未知豁免**的那一条。返回真 = 真换了。
 */
export function confirmTurnSilence(
  sessionId: string,
  owner: StallOwner,
  turnStartedAt: string,
): boolean {
  const held = stalls.get(sessionId);
  if (!held || held.owner !== owner || held.turnStartedAt !== turnStartedAt) return false;
  if (held.kind !== "silence" || !held.unverifiedHistory) return false;
  held.unverifiedHistory = false;
  held.since = turnStartedAt;
  held.sinceMs = Date.parse(turnStartedAt);
  held.warned = false; // 先前那句「接管前核实不了」已经不准了,按确证零输出重报
  evaluate(sessionId, held);
  arm();
  return true;
}

/**
 * **撤掉一条「只为核实不了而开」的静默观察** —— 那张进展证明后来读出来了「有过产出」。
 *
 * 和 `clearTurnStall` 的区别就是它那几道闸:只撤**这一轮、这个持有者、静默档、而且还没熔断**
 * 的那一条。错误档不撤(它有自己的判据)、已经熔断的不撤(终止义务只有两个出口,摘牌不是其中
 * 之一,见 `trackTurnStall` 里那段)。撤掉的同时把已经投影出去的红环一起收(`close` 负责)。
 *
 * 返回真 = 真撤掉了一条。
 */
export function withdrawTurnSilence(
  sessionId: string,
  owner: StallOwner,
  turnStartedAt: string,
): boolean {
  const held = stalls.get(sessionId);
  if (!held || held.owner !== owner) return false;
  if (held.kind !== "silence" || held.turnStartedAt !== turnStartedAt) return false;
  if (held.trippedAtMs !== null) return false;
  close(sessionId, held);
  return true;
}

export function clearTurnStall(sessionId: string, owner: StallOwner): void {
  const held = stalls.get(sessionId);
  if (!held || held.owner !== owner) return;
  close(sessionId, held);
}

/** 只给回归测试:把表清干净,免得上一段的残留影响下一段。 */
export function __resetTurnStalls(): void {
  stalls.clear();
  resetStallThresholdWarnings();
  disarm();
}
