// 单飞任务「跑一回合」:**消费事件流**,以及结算之后的那些钩子。
//
// 从 orchestrator.ts 拆出来（那边已经超过 700 行的单文件上限）。依赖方向是
// 单向的：orchestrator / reattach 都 import 这里，这里不回头 import 它们 ——
// 结算规则是全局单点，谁也不该另造一份。
//
// **「这一笔该落成哪个状态」已经搬到 `settle-status.ts`**（同一条上限）:那一段自成一块
// 职责（续聊/原生/手停/提问/检查点/严格完成协议/哨兵闸），而且被引导、重试、测试直接调。
import { cleanupSettled, nothingToCollect, type CleanupResult } from "./executors/kill.js";
import type { WriteStream } from "node:fs";
import type { AgentEvent, AgentType, ModelFailure, SessionRole, TurnOutcome } from "@ash/shared";
import { eq, sql } from "drizzle-orm";
import { db } from "./db/index.js";
import { tasks, sessions } from "./db/schema.js";
import { bus } from "./bus.js";
import { closeSessionTurns, recordTurnSpan } from "./session-turns.js";
import { scanForTitle } from "./auto-title.js";
import { applyAutoTitle } from "./auto-title-apply.js";
import {
  adoptRun, bindNativeSteer, finalizeAbandonedRun, takeSteered, takeStopped, turnIdentity,
} from "./runs.js";
import { now } from "./util.js";
import type { AgentExecutor, RunHandle } from "./executors/types.js";
import {
  LOST_SESSION_PATCH,
  mergeSessionResumeFault,
  sessionResumeFaultNote,
  shouldDropSession,
  type SessionResumeFault,
} from "./executors/session-lost.js";
import { appendSessionTrace, writeTurn, writeTurnEnd, writeRunError } from "./transcript.js";
import { noteAgentEventUpload } from "./uploads.js";
import { isExecutionNotice, isSessionScopeNotice } from "./session-notice.js";
import { clearSessionWaiting, trackSessionWaiting } from "./session-waiting.js";
import {
  clearTurnStall, confirmTurnSilence, resumeTrippedTurn, trackTurnStall, watchAdoptedSilence, watchTurnSilence, withdrawTurnSilence,
  type StallActions,
} from "./turn-stall.js";
import { progressUnreadableText, stallUnverifiableText } from "./turn-stall-text.js";
import {
  noteTurnProgress, openTurnProgress, recoverTurnProgress, turnProgressFor,
} from "./turn-progress-mark.js";
import { clearStallFailure, stallFailure, type StallVerdict } from "./turn-stall-verdict.js";
import { restoreStallVerdict } from "./turn-stall-persist.js";
import { clearSessionStalled, markSessionStalled } from "./session-stall-flag.js";
import { createExecutionCloser, recordFreeTaskExecutionStartIfFree } from "./free-workflow-events.js";
import { reconcileTurnBaseline } from "./turn-baseline.js";
import { clearTurnStart } from "./turn-output.js";
import { replayUndeliveredMcpCalls } from "./mcp-handoff.js";
import { noteReviewerChannelGap, noteTurnChannelGap } from "./review-channel-gap.js";
import { afterSettlement, settleTaskStatus } from "./settle-status.js";
import { recordSessionUsageEvent, setSessionContext } from "./usage.js";
import { markCliGoalStarted, persistRunGoal } from "./task-cli-state.js";
import { settleContextRebuild } from "./history-reseed.js";

const STEERED_NOTE = "〔系统〕当前回合已由“引导会话”结束。";



export type SingleRunArgs = {
  taskId: string;
  sessId: string;
  agentType: AgentType;
  ex: AgentExecutor;
  cwd: string;
  handle: RunHandle;
  out: WriteStream;
  turnStart: string;
  cliSessionId: string;
  autoTitle: boolean;
  /**
   * 这一轮是**接回来的**(reattach),不是本进程开的。
   *
   * 静默档的进展参与证明只许由「从头消费这一轮」的那个进程落(`openTurnProgress`):接管方
   * 看不到 `agentOffset` 之前那一段,自己补一张证明就等于替上一个进程声明「它没产出过」——
   * 第 2 轮自由审查 F2 实测的升级误杀正是这么来的。这一位只有这一个用途,所以不复用
   * `autoTitle`(那是「标题解析过了没有」,两件事迟早会分叉)。
   */
  adopted?: boolean;
  role?: SessionRole;
  nativeSteer?: {
    prepare?(text: string): string | Promise<string>;
    record(text: string, at: string): void;
  };
};

// 消费一次单飞运行的事件流，直到它结束，然后结算。
//
// **fresh run 与「重启后接管」共用这一份**——两条路只有前半段不同（一个是刚
// spawn 出来的 handle，一个是按 pid+offset 接回来的），从「读事件」这一步往后
// 完全一样。抄成两份的话，结算优先级、标题解析、.md 落盘这些迟早会漂。
// autoTitle=false 时跳过标题解析（接管路径必然已经解析过了）。
//
// 这一层只管**进程归属**:认领 + 兜底(见下);事件流与结算本体在 consumeRunStream。
export async function consumeSingleRun(a: SingleRunArgs): Promise<void> {
  // 消费方在这一行正式接手(runs.ts 的归属三态 ②):此前 handle 的回收责任在起跑方身上,
  // 此后归下面这道 finally。认领本身也是在告诉起跑方的 finally「别再杀了」—— 正常跑完
  // 时登记可能仍在册,那时候动手就是对一个已退出的号发信号(第 1 轮审查 F2)。
  adoptRun(a.handle);
  let streamDrained = false;
  try {
    await consumeRunStream(a, () => {
      streamDrained = true;
    });
  } finally {
    // 认领了就得兜到底。事件流**之前**还有一段初始化(读 tasks 那一行、记自由工作流执行
    // 开始、建 closer),它抛出来时 CLI 早就在跑了,而流循环自己那道 finally 一次都没执行
    // —— 不补这一刀,它就成了没人读输出、停止按钮也碰不到的无主进程(第 1 轮审查 F1)。
    if (!streamDrained) await finalizeAbandonedRun(a.handle);
  }
}

// 事件流 + 结算本体。`markStreamDrained` 由流循环的 finally 调用,告诉外壳「进程资源已经
// 收干净了」—— 在它被调用之前抛出的任何异常,都意味着那个 CLI 还没人收。
async function consumeRunStream(a: SingleRunArgs, markStreamDrained: () => void): Promise<void> {
  const { taskId, sessId, agentType, ex, out } = a;
  const role = a.role ?? "single";
  // 原生 CLI 命令回合(`/compact` 一类)不记「任务执行」:那一轮压根没在推进任务,记下来
  // 自由工作流时间线上就多出一条凭空的「任务执行 · 已完成」(第 2 轮审查 finding 7)。
  // 读的是 tasks.native_turn 而不是新加一个入参:结算那边(settleTaskStatus)看的就是
  // 这一列,同一个真相来源,重启后被接管的那一轮也照样认得出来。
  // verify_round 同理**从库里读**而不是让调用方传:三条起跑路径(fresh run / continueTask /
  // 重启接回)都汇到这儿,由库来答就不会漏标其中一条。验证中途提问、答复回来续跑的那一
  // 回合库里仍挂着轮次号,于是它照样归这一轮验证——跟 orchestrator 的 sideTurn 判据同源。
  const taskRow = (await db.select({ nativeTurn: tasks.nativeTurn, verifyRound: tasks.verifyRound, goalTurn: tasks.goalTurn })
    .from(tasks).where(eq(tasks.id, taskId))).at(0);
  const nativeTurn = !!taskRow?.nativeTurn;
  let goalStartPending = !!taskRow?.goalTurn;
  const verifyRound = taskRow?.verifyRound ?? null;
  const executionEventId = role === "single" && !nativeTurn
    ? await recordFreeTaskExecutionStartIfFree(taskId, a.turnStart).catch((error) => {
        console.warn(`[ash] failed to record free workflow execution start for ${taskId}:`, error);
        return null;
      })
    : null;
  // 终态只认第一次请求的那个,finally 那次兜底只准重试它 —— 理由见 createExecutionCloser。
  const closeExecution = createExecutionCloser(executionEventId, taskId);
  // 会话轮换旁注的缓冲与落盘。**必须声明在 try 外面**：异常路径的兜底 flush 挂在
  // finally 上，声明进 try 里它就不在作用域内了。
  // 先取空再写：正常尾部（agentEnd 之后）跑一次，finally 再跑一次也只是空转 —— 既不会
  // 把同一条写两遍，也不会往已经 end 掉的流上再写（写已 end 的流会当场打崩 server）。
  const sessionNotices: { text: string; at: string; level?: "notice" }[] = [];
  const flushSessionNotices = () => {
    const notices = sessionNotices.splice(0);
    for (const notice of notices) {
      writeTurn(out, { t: "system", agent: agentType, text: notice.text, level: notice.level }, notice.at);
    }
  };
  try {
  let cliSessionId = a.cliSessionId;
  let exitStatus = 0;
  let doneEvent: Extract<AgentEvent, { kind: "done" }> | null = null;
  let streamError: unknown = null;
  // CLI 有时把 API 层失败报成 error 事件后仍以 exit 0 收尾（Claude 的
  // is_error/api_error_status 就是这种）。退出码只能说明进程活着走完，不能证明这一轮
  // 执行成功；自由工作流据此决定是否继续自动复审链。
  let sawExecutionError = false;
  // 最后一条执行故障，审查没结论时据它说怎么断的（`model` = 执行器认出它来自模型 API 时挂的类型）。
  let lastExecutionError: Extract<AgentEvent, { kind: "error" }> | null = null;
  let lastRetryModel: ModelFailure | null = null; // 重试提示撞的是哪一类：看门狗熔断时据它说原因
  // CLI 否认过这条会话，或 Codex stderr 证明 thread 已 poisoned 吗（见
  // executors/session-lost.ts）。认下来的话这一轮收尾时要把失效 id 从库里清掉，
  // 否则每一次重试都在 --resume 同一条坏会话。
  let sessionFault: SessionResumeFault | null = null;
  // 看门狗熔断掉这一轮的话,**收流那一刻**取走的那份结论(赋值点在下面的 finally,理由在那儿)。
  let watchdogFailure: StallVerdict | null = null;
  let titleDone = !a.autoTitle; // when autoTitle, swallow text until the title line is parsed
  let head = "";
  let pendingTraceText = "";
  const runMeta = {
    model: ex.model ?? null,
    reasoningEffort: ex.reasoningEffort ?? null,
    ...(verifyRound ? { verifyRound } : {}),
  };
  appendSessionTrace(taskId, sessId, a.turnStart, { kind: "run", ...runMeta });
  const publishEvent = (event: AgentEvent) => bus.publish({
    type: "agent.event", taskId, sessionId: sessId, role, agentType, ...runMeta, turnStartedAt: a.turnStart, event,
  });
  const flushTraceText = (at?: string) => {
    if (!pendingTraceText) return;
    appendSessionTrace(taskId, sessId, a.turnStart, { kind: "text", text: pendingTraceText }, at);
    pendingTraceText = "";
  };
  // 会话轮换旁注：实时立刻播（用户正看着），落盘攒到 writeTurnEnd 之后再补 —— 见
  // 事件循环里那段注释，夹在正文和 agentEnd 之间会让重建出来的回合用时失准。
  const noteSessionNotice = (text: string, at = now(), level?: "notice") => {
    sessionNotices.push({ text, at, level });
    publishEvent({ kind: "system", text, at, ...(level ? { level } : {}) });
  };
  const emitText = (text: string) => {
    if (!text) return;
    out.write(text);
    pendingTraceText += text;
    publishEvent({ kind: "text", text });
  };
  // 给标题窗口一个结论：命中就改名并把标题行摘掉，没命中就把攒下的正文原样放出去。
  // 返回 false = 还没有结论（窗口没走完），继续攒。
  const resolveTitle = async (flush: boolean) => {
    const scan = scanForTitle(head, flush);
    if (scan.kind === "buffer") return false;
    await applyAutoTitle(taskId, scan.title); // 智能体自己起的标题(见 auto-title.ts)
    titleDone = true;
    head = "";
    emitText(scan.text); // 命中的话标题行已被摘掉，其余原样放行
    return true;
  };
  const persistTrace = (event: AgentEvent, at?: string) => {
    // `context` 刻意不进 trace：trace 是「按回合回放各自的气泡」，而水位属于整条会话的
    // 此刻、只有最后一个值有意义，它的家在 sessions 行上（setSessionContext）。
    if (event.kind === "thinking" || event.kind === "tool" || event.kind === "error" || event.kind === "usage" || event.kind === "attachment") {
      // agent 自己产出的图(工具结果截图之类)也躺在 uploads 目录里,归属跟着这个任务走 ——
      // 不登记的话多人模式下它是「无主资产」,同项目的人在会话里打不开(uploads.ts)。
      // 团队那条链的同一处在 team/session-consumer.ts 的 traceLead:改一处记得看另一处。
      noteAgentEventUpload(taskId, event);
      flushTraceText();
      appendSessionTrace(taskId, sessId, a.turnStart, event, at);
    } else if (event.kind === "done" || event.kind === "turnEnd") {
      flushTraceText();
    }
  };

  // 一条**持久可见**的红字:trace(按它发生的位置回放)+ `.md`(落盘产物)+ 当场推送。三处缺
  // 一不可 —— 项目规矩是「判据是用户刷新页面后仍能看出」,少了 trace 那一笔刷新就没了。
  // 熔断和「结局核实不了」两条路都用它,所以只留一份:措辞归 turn-stall.ts,送达归这里。
  const emitTurnError = (text: string) => {
    const event: AgentEvent = { kind: "error", message: text };
    persistTrace(event);
    writeRunError(out, text);
    publishEvent(event);
  };

  /**
   * **这一轮「有过进展」已经落在进程之外了吗**(记号写成,或接管时就读出 `seen`)。没落之前
   * 水位一个字节都不许推进(理由见下面 offsetTimer 那段)。不盯进展的回合(没有回合身份)
   * 没有这件事要等。
   */
  let progressSecured = !a.turnStart;
  /** 这一轮还在消费吗。进展证明的恢复核验据此收手(回合结束后再撤观察只会撤错下一轮)。 */
  let turnLive = true;
  // 回合级停滞看门狗(判据与两档动手见 turn-stall.ts)。这三件动作是这条链专属的部分 ——
  // 判据一个字都不在这儿,三条消费链共用同一份。
  const stallActions: StallActions = {
    taskId,
    // 警告档走 trace:它排在执行过程里它发生的那个位置(不是回合结尾),而且 level:"notice"
    // 保证它不改变这一轮的成败 —— 上游恢复后正常答完的那一轮仍然算成功。
    warn: (text) => {
      const event: AgentEvent = { kind: "error", message: text, level: "notice", affectsTurn: false };
      persistTrace(event);
      publishEvent(event);
    },
    // 持久那一半单独一个动作:它要报成败,看门狗据此重投到确认(理由见 StallActions.project)。
    project: (facts) => markSessionStalled(taskId, sessId, facts.since),
    // 「这一轮产出过东西」这个事实必须留在进程之外:接管回来的新句柄看不到 `agentOffset`
    // 之前那一段(理由与实测见 turn-progress-mark.ts 文件头)。
    // 返回落盘确认了没有:看门狗据此在下一条进展事件上重试(见 StallActions.noteProgress)。
    noteProgress: () => {
      if (!a.turnStart) return false;
      const recorded = noteTurnProgress(taskId, sessId, a.turnStart);
      // **欠着这一笔时,水位不许越过这段输出**(第 2 轮自由审查 F2 的那一半):见下面 offset
      // 那段注释 —— 这是「进展事实与持久消费水位一起前进」的落点。
      if (recorded) progressSecured = true;
      return recorded;
    },
    // 熔断档:说出来 + 杀进程。「这一轮失败」这个结论**不在这儿记** —— 看门狗在调 trip 之前
    // 就已经把它钉在回合身份上了(turn-stall-verdict.ts),下面收尾那一段连 `executionFailed` 带
    // 结算用的退出码一起从那一份读。从前这里是 `sawExecutionError = true`:那一位只喂得到
    // 会话行和回合区间,`settleTaskStatus` 压根看不见它(它只收到原始退出码),于是被我们杀掉
    // 的回合照样能落 done —— 被杀的 CLI 多半报不出非零(第 1 轮审查第 2 条)。
    //
    // 不实现 `escalate`:单飞的 `trip` 本身就是硬终止(三层击杀),没有「请求了没人理」那一档。
    trip: (text) => {
      emitTurnError(text);
      a.handle.kill();
    },
    resolve: (facts) => clearSessionStalled(taskId, sessId, facts.since),
  };

  if (a.nativeSteer) {
    bindNativeSteer(taskId, a.handle, {
      agentType,
      prepare: a.nativeSteer.prepare,
      beforeDeliver: async (at) => {
        if (!titleDone && head) await resolveTitle(true);
        const boundary = Date.parse(at);
        flushTraceText(Number.isFinite(boundary) ? new Date(boundary - 1).toISOString() : undefined);
      },
      record: a.nativeSteer.record,
    });
  }

  // 定期把「已消费到哪个字节」写进库。真正重要的是**崩溃/被杀时**那一份——
  // 正常收尾会在下面再写一次终值。1s 一次：最坏情况重启后重放不到 1 秒的输出，
  // 而 offset 永远落在换行边界，所以重放只会重复整行、不会劈坏一行 JSON。
  //
  // **进展记号落盘之前就不推进**(第 2 轮自由审查 F2;第 1 轮自由审查 F1 收紧)。水位推过去
  // 意味着「这段输出下一个进程再也看不到了」,而它正是那一轮「有过进展」的全部凭据。上一版只在
  // 「记号写过、写失败了」时压住水位,漏了另一半:`committed()` 是**读到换行的原始字节**,而语义
  // 事件还隔着增量合并、队列和异步消费 —— 一段不到 240 字的思考停在合并缓冲里,水位已经越过它、
  // 记号却还没人去写(实测 offset=114、进展 none)。这时重启,新进程从 114 读起,那段思考再也
  // 重放不到,又是「证明在、记号不在」= 确证零进展。
  //
  // 「哪个字节是第一条进展」在原始流里认不出来,也不必认:**进展事实单调**,只有第一条要紧。
  // 所以按事实闸住整段 —— 记号落盘之前一个字节都不提交(之前只有握手/身份这类非进展行,重放
  // 无害);落盘之后它覆盖整轮,水位放开追。代价是记号写不进去时会多重放几行(trace 里重复几行,
  // offset 永远落在换行边界),比「误杀一个在干活的 agent」便宜得多。
  const detached = a.handle.detached;
  const committedOffset = (): number | null => (detached && progressSecured ? detached.committed() : null);
  const offsetTimer = detached
    ? setInterval(() => {
        const at = committedOffset();
        if (at === null) return; // 欠着进展记号:这一拍不推进(见上面那段)
        void db
          .update(sessions)
          .set({ agentOffset: at })
          .where(eq(sessions.id, sessId))
          .catch(() => {});
      }, 1000)
    : null;
  (offsetTimer as { unref?: () => void } | null)?.unref?.();

  try {
    // **接管一个仍然存活的回合时,先把尚未兑现的熔断判决装回来,并且接着把它终止掉。**
    //
    // detached 的 agent 活得过 server 重启(executors/detached.ts),而判决原先只活在进程内存
    // 里:熔断已经作出、终止请求还没兑现(codex 的 kill 先发 interrupt,另设 2 秒回收)时 server
    // 退出,重启接管那个还活着的进程,新进程的 Map 空着 —— 上游一恢复,这一轮就按成功结算、
    // 任务落 done,而用户那边早已看到「已自动终止本回合并按失败结算」(审查 F3,已实测)。
    //
    // 装回来只是让结算读得到结论;**终止义务也得接着兑现** —— 判决已经作出、话已经说出去了,
    // 让它继续跑下去就是第二次失信。正常起跑走到这里一律是 null(那一轮没有落盘的判决)。
    //
    // 兑现走 `resumeTrippedTurn`,**不在这里手抄一遍「发句诊断 + 杀一次」**:那四步跟
    // `stallActions.trip` 一模一样,抄一份就会跟它漂;更要紧的是义务本身的语义(终止义务只有
    // 两个出口、宽限回收、退场销账)全住在看门狗那张表里,手动杀一次拿不到(见那个函数的注释)。
    const carried = await restoreStallVerdict(sessId, a.turnStart);
    if (carried && a.turnStart) {
      // 确凿熔断过的 → 接着兑现那份终止义务;只是**核实不了**的 → 只说不杀:我们并不知道它
      // 熔断过没有,拿一个不确定的义务去杀一个可能完全健康的 agent 比让它跑完更糟。登记已经由
      // `restoreStallVerdict` 做完了,结算那一段读的是同一张表,这里不再另写判据。
      if (carried.kind === "tripped") resumeTrippedTurn(sessId, a.handle, a.turnStart, carried, stallActions);
      else emitTurnError(stallUnverifiableText(carried.reason));
    }
    // **静默档**:这一轮到底有没有真的跑起来(判据见 turn-stall.ts 文件头那一节)。必须在这里
    // 显式挂上、而不是等第一条事件来开 —— 它要抓的恰恰是一条事件都不来的回合。
    //
    // 这一句同时覆盖**接管回来的会话**:接管走的是同一条消费链(reattach.ts 调的就是这个函数),
    // 而起点取库里那一轮的真实起点,所以重启前已经静默掉的那段照样算在里面。2026-11-02 那次
    // 1.5 小时零输出就是接管出来的闲置进程,错误档一拍都不会动。
    //
    // **进程外那份进展事实**:本进程开的这一轮由我们落「参与证明」(那张证明才是「记号不在 =
    // 确证没产出」的前提);接管回来的那一轮**只读不写** —— 判据与实测见 turn-progress-mark.ts。
    //
    // 判据只认**事件语义层**那张记号,不认字节(第 2 轮自由审查 F2:握手就能把水位从 0 推到
    // 249,拿它当进展等于把零输出那一轮永久排除在静默档之外)。「记号写不进去」那条缝由上面
    // 那道水位闸补 —— 欠着就不推进,输出留给下一个进程重放。
    if (!a.adopted) openTurnProgress(taskId, sessId, a.turnStart);
    const progressFact = turnProgressFor({
      taskId, sessionId: sessId, turnStartedAt: a.turnStart, watchedFromStart: !a.adopted,
    });
    if (progressFact === "seen") progressSecured = true; // 进程外已经记着「有过」,水位不必再等
    if (a.turnStart && progressFact === "unreadable") {
      // **「说不上来」的独立恢复档**(第 2 轮自由审查 F2)。只有接管这一路会走到这儿:上一个
      // 进程留下的证明读不出来(升级前那一代压根没有这套记号、或者权限/磁盘坏了)。
      //
      // 两边都不许认:认「产出过」= 这一轮永久排除在静默档外,正是原始那个 1.5 小时;认「从未
      // 产出」= 替上一个进程追认,会误杀一个正在跑长工具的健康回合(第 1 轮 F1)。所以只认
      // **我盯得住的那段窗口**,而且**不借「整轮零产出」那一档**(第 1 轮自由审查 F1):从接管
      // 这一刻起盯、到阈值警告并亮红环,但不熔断、不说「没跑起来」—— 接管之后没看到新东西是
      // 亲眼所见,接管之前有没有却仍然不知道(见 turn-stall.ts 的 `watchAdoptedSilence`)。
      //
      // 同时接着重读那张证明(不设上限,见 verify-until-known.ts),两个结论各有出边:读出 `seen`
      // 就把这条观察撤掉;读出 `none` 就换回正常静默档、恢复熔断责任(第 2 轮自由审查 F1)。
      emitTurnError(progressUnreadableText());
      watchAdoptedSilence(sessId, a.handle, a.turnStart, stallActions, new Date().toISOString());
      const watchedTurn = a.turnStart;
      recoverTurnProgress(taskId, sessId, watchedTurn, (progress) => {
        if (progress === "none") {
          if (confirmTurnSilence(sessId, a.handle, watchedTurn)) {
            console.warn(`[ash] 会话 ${sessId} 本轮的进展证明后来读出来了「确证零进展」，`
              + "那条按「核实不了」开的观察换回正常静默档(含熔断)");
          }
          return;
        }
        progressSecured = true;
        if (withdrawTurnSilence(sessId, a.handle, watchedTurn)) {
          console.warn(`[ash] 会话 ${sessId} 本轮的进展证明后来读出来了「有过产出」，`
            + "撤掉那条按「核实不了」开的静默观察");
        }
      }, () => turnLive);
    } else {
      watchTurnSilence(sessId, a.handle, a.turnStart, stallActions, progressFact);
    }
    for await (const event of a.handle.events) {
      // 「此刻还在等上游」只有这里数得准:正文要到下一条非正文事件才冲进 trace,落盘产物
      // 反推不出「这条提示之后有没有新东西来」(见 session-waiting.ts)。
      trackSessionWaiting(sessId, a.handle, a.turnStart, event);
      // 「这一轮还在往前走吗」(turn-stall.ts):同一条事件流、同一个持有者语义,只是它要
      // 回答的不是「此刻在等」而是「等到该动手了没有」。
      trackTurnStall(sessId, a.handle, a.turnStart, event, stallActions);
      if (goalStartPending && a.handle.goalStarted?.()) { await markCliGoalStarted(taskId, agentType, event.kind === "session" ? event.cliSessionId : cliSessionId); goalStartPending = false; }
      if (event.kind === "session") {
        if (event.cliSessionId !== cliSessionId) {
          cliSessionId = event.cliSessionId;
          await db
            .update(sessions)
            .set({ cliSessionId, ...ex.resumeFields(a.cwd, cliSessionId) })
            .where(eq(sessions.id, sessId));
        }
        publishEvent(event);
        continue;
      }
      if (event.kind === "text" && !titleDone) {
        head += event.text;
        await resolveTitle(false); // 还没结论就是继续攒，正文暂不放行
        continue;
      }
      if (event.kind === "text") {
        emitText(event.text);
      } else {
        // 标题窗口正扣着正文，而这条事件（tool/thinking/error/usage/done…）马上就要落盘、
        // 上屏。让它先走，攒着的正文就会排到它后面 —— live 和 trace 里的先后顺序都跟真实
        // 输出对不上（`error` 更明显：writeRunError 会先写进 .md）。所以先给标题窗口一个
        // 结论、把正文放出去，再处理这条事件。
        //
        // head 为空时不收窗口：没有正文被扣着，这条事件本来就该排在前面，顺序天生正确。
        // 开场先读个文件、之后才写标题的那种（库里 XQWuZZwlG_KA 就是），全靠这一条才救
        // 得回来。窗口就此关掉的代价是「tool 之后才出现的标题」认不出来——翻了那 15 个
        // 现场，没有一例长这样（两例「先寒暄一句」的寒暄和标题同在一个 text 事件里），
        // 拿这个换顺序永远正确，划算。
        if (!titleDone && head) await resolveTitle(true);
        // scope:"session" 说的是「这条恢复会话作废了」，不是「本回合失败了」（见
        // executors/codex.ts 推它的地方）。当成普通 error 会把一个 exit 0、正常交卷的回合
        // 记成「执行过程里有异常」；跟 duet/team 一样按 scope 分流（判据共用
        // session-notice.ts 那一个，别再各自内联一份），降成 system 旁注。
        // **落盘要等到 writeTurnEnd 之后**：重建时 agentEnd 只往「最后一段是 agent」的
        // 气泡上盖时间戳（shared/src/index.ts），夹在正文和 agentEnd 之间会让本回合用时失准。
        const emittedEvent = event.kind === "usage"
          ? await recordSessionUsageEvent(sessId, event, agentType, cliSessionId, a.turnStart)
          : event;
        if (emittedEvent.kind === "done") {
          exitStatus = emittedEvent.exitStatus;
          doneEvent = emittedEvent;
          continue;
        }
        if (emittedEvent.kind === "system") {
          noteSessionNotice(emittedEvent.text, emittedEvent.at, emittedEvent.level);
          continue;
        }
        if (emittedEvent.kind === "error" && isSessionScopeNotice(emittedEvent)) {
          sessionFault = mergeSessionResumeFault(sessionFault, emittedEvent.message);
          noteSessionNotice(emittedEvent.message);
          continue;
        }
        persistTrace(emittedEvent);
        // level:"notice" 的 error 只是过程里的一句提示（上游在重试、还在等回话）：照落
        // trace（于是它排在执行过程里它发生的那个位置），但下面三件事一件都不做 ——
        // 写红色诊断块、并进会话恢复故障、把这一轮判成有执行异常。判据见
        // session-notice.ts#isExecutionNotice。
        if (emittedEvent.kind === "error" && emittedEvent.model && isExecutionNotice(emittedEvent)) lastRetryModel = emittedEvent.model;
        if (emittedEvent.kind === "error" && !isExecutionNotice(emittedEvent)) {
          // 有些 error 是需要留在红色诊断块里的旁路故障，但不代表模型回合失败（目前的
          // 实例是 Claude 自动压缩失败：压缩没成，后续 result 仍明确为 success）。
          if (emittedEvent.affectsTurn !== false) { sawExecutionError = true; if (!lastExecutionError?.model || emittedEvent.model) lastExecutionError = emittedEvent; }
          writeRunError(out, emittedEvent.message);
          sessionFault = mergeSessionResumeFault(sessionFault, emittedEvent.message);
        }
        // 水位相反：**覆盖**。它属于整条会话的此刻，不属于某一个回合，所以也不进 trace。
        if (emittedEvent.kind === "context") await setSessionContext(sessId, emittedEvent.context);
        publishEvent(emittedEvent);
      }
    }
  } catch (error) {
    // 先保留异常，等 steering 的两阶段决定：已提交的引导是受控结束，不该冒成 parser
    // 崩溃；预约若撤销，再把原异常交回原来的失败路径。
    streamError = error;
  } finally {
    turnLive = false; // 这一轮不消费了:进展证明的恢复核验到此收手(见上面那段 unreadable)
    // 流异常中断时 done 事件压根不会来,内存里那条等待状态就得在这儿撤(见 session-waiting.ts)。
    clearSessionWaiting(sessId, a.handle);
    // **判决在这一刻就取走,不留到下面去读**(第 2 轮审查 F3,已实测)。流结束了 = 不会再有
    // 新的熔断写进这个回合身份,所以此刻读到的就是最终结论;而从这里到下面结算之间隔着
    // `cleanup()` 和一串写库 await。判决的回收现在只认「读者自己销账」(下面那句
    // `clearStallFailure`),所以这一笔取值已经不是必需的 —— 留着是因为它把「读」和「销」摆成
    // 了同一段里的一对,下一个人改结算顺序时看得见配对关系,不必再去 turn-stall-verdict.ts 确认
    // 回收策略。
    watchdogFailure = stallFailure(sessId, a.turnStart) ?? a.handle.failure?.() ?? null;
    clearTurnStall(sessId, a.handle);
    if (offsetTimer) clearInterval(offsetTimer);
    const cleaned = await a.handle.cleanup?.().catch((error): CleanupResult => {
      console.warn(`[ash] failed to clean descendants after task ${taskId}:`, error);
      // 清理整个抛了:这一轮一个号都没点上来 ⇒ 名单只能是空的,但结论不是空的(见
      // cleanup-result.ts 的闸二:`open` 必填,逼这里显式说一句「我手上没有」)。
      return { kind: "unknown", detail: "cleanup 抛错", open: [] };
    });
    // 进程资源到此已经收干净(cleanup 覆盖根进程与它甩出去的后代),外层那道兜底不必再
    // 补刀;后面结算段再抛错也只是结算的事,不会留下无主进程。
    //
    // **但「收干净了」要它自己说**(本轮审查 F2):上一版连 cleanup 抛错都照样走这一句,
    // 更不用说 `remaining`/`unknown` 两档 —— 于是外层那道「没收干净就再补一刀」的兜底被
    // 一句无条件的声明关掉了。没有句柄时(失败桩,没有真实进程)照旧算收干净。
    // 没有句柄 / 没有 cleanup 这一层(失败桩,没有真实进程)⇒ 没有要收的东西,照旧算收干净。
    if (!a.handle.cleanup || cleanupSettled(cleaned ?? nothingToCollect())) markStreamDrained();
  }
  // 一个换行都没等到就收流了（整轮只吐了一行的那种）。这里补一次 flush 扫描：
  // 老实现直接把缓冲原样吐出去，那一行哪怕就是标准的 `标题：xxx` 也白瞎。
  if (!titleDone && head) await resolveTitle(true);
  flushTraceText();

  // A stop kills the subprocess → the stream ends like a normal exit; settle
  // by the stop kind (manual → canceled, group pause → paused) so it can be
  // re-run / continued.
  const requestedSteer = await takeSteered(taskId);
  const stopped = takeStopped(taskId);
  const steered = requestedSteer && !stopped;
  if (streamError && !steered && !stopped) throw streamError;
  const endIso = now();
  // **这一刻起这个回合就不在写了**,所以注销排在所有写库动作之前：下面的 closeExecution、
  // 会话 UPDATE 都可能抛,抛了就走不到 `recordTurnSpan`,残留的活动登记会让读端把这条会话
  // 当成「还在写」（第 6 轮审查必须修 1）。入口的 finally 还兜一道。
  closeSessionTurns(sessId);
  // 看门狗熔断掉的这一轮:结论由它写下,**上面收流那一刻就取走了**(理由见那里)。
  const executionFailed = !stopped && (exitStatus !== 0 || sawExecutionError || !!watchdogFailure);
  // CLI 否认了这条会话：把失效的 id 连同由它派生的三件套恢复命令一起清掉。清了之后
  // orchestrator 的 `resuming`（判据就是「这条会话行上有没有 cli_session_id」）自然为
  // 假，下一次运行走全新会话那条路 —— 不必在别处再加一个「要不要续」的开关。
  // 普通 lost 仍要求非零退出，防止正文碰巧出现原话；poisoned 是 stderr 诊断生成的
  // error，即使 exit 0 / turn.completed 也必须清掉。
  const dropSession = !steered && shouldDropSession(sessionFault, exitStatus);
  const turnOutcome: TurnOutcome = steered || stopped ? "stopped" : executionFailed ? "failed" : "completed";
  await closeExecution(steered ? "canceled" : stopped ?? (executionFailed ? "failed" : "completed"), endIso);
  await db
    .update(sessions)
    .set({
      exitStatus,
      // **这一轮是被停的，不是它自己崩的**。CLI 吃 SIGTERM 后按 signal 写非零退出，
      // 光看 exitStatus 分不出「我停的」和「它崩了」，而停止事实只在内存里活一次
      // （takeStopped 消费即清）。不落这一列，续聊被手动停止之后，那颗「上一回合崩了
      // 快重试」的按钮就会稳定地把用户刚停下的指令再跑一遍（第 2 轮审查 finding 2）。
      stoppedAs: steered ? "steered" : stopped ?? null,
      endedAt: endIso,
      activeMs: sql`COALESCE(${sessions.activeMs}, 0) + ${Math.max(0, Date.parse(endIso) - Date.parse(a.turnStart))}`,
      // 这一轮结束了，pid 不再有意义——留着会让下次重启去接一个早就没了的
      // 进程（或者更糟：pid 被复用后接到别人身上）。offset 留着供排查。
      //
      // **`agent_unit_token` 刻意不清**(别顺手把它对称地加到这里):它恰恰是「这一轮有没有
      // 漏掉的后代」的唯一线索,而回合收尾正是要查这件事的时刻 —— 清掉就再也查不回来。
      // 留着也不会让重启误接:接回那条路的前提是 pid 非空,而 pid 这就清了。
      // (同一个判据在哨兵那边叫 traceless:只许收档,不许删掉身份行。)
      agentPid: null,
      // 同上面那道闸:进展记号没落盘就**连终值也不写**(留着库里那个更小的值),让下一个进程
      // 仍然重放得到那段输出。`detached` 不存在时照旧清空(这一路没有可接的进程)。
      ...(detached ? (progressSecured ? { agentOffset: detached.committed() } : {}) : { agentOffset: null }),
      ...(dropSession ? LOST_SESSION_PATCH : {}),
      ...settleContextRebuild({ succeeded: !stopped && !steered && !executionFailed && !dropSession, cliSessionId }),
    })
    .where(eq(sessions.id, sessId));
  // 这一回合的区间单独落一行：产物归属要的是「它在写这个目录」的那几段，而上面那行
  // 会话记录跨回合复用，只留得下最后一次收尾时刻（`db/schema.ts` 的 sessionTurns）。
  // **结局跟着落**:口径与上面那次 closeExecution 同一份(被停/被引导 = 受控停止,
  // 「非零退出 **或** 中途报过执行故障」= 失败)。读端据此给失败现场,不再去猜进程退出码
  // —— 单飞这一路恰好是反方向那半边:`exit 0` 却报过执行故障的回合从前一条现场都给不出
  // (第 5 轮审查 F3,见 db/schema-sessions.ts 的 sessionTurns.outcome)。
  await recordTurnSpan({
    sessionId: sessId,
    taskId,
    cwd: a.cwd,
    startedAt: a.turnStart,
    endedAt: endIso,
    outcome: turnOutcome,
  });
  if (steered) {
    // 「引导会话」只截断旧回合：任务仍是 running，新消息已持有 scheduled_messages
    // 投递租约，并排在 releaseTurn 后用同一 cliSessionId 续送。这里若走普通 settle，
    // 会把旧方向误记 failed/canceled、推进队列，还可能触发工作流/审查；若补放旧回合
    // 的 complete_task，又会让新方向一开始就继承一张错误的完成票。
    clearTurnStart(taskId);
    writeTurn(out, { t: "system", agent: agentType, text: STEERED_NOTE }, endIso);
    publishEvent({ kind: "system", text: STEERED_NOTE, at: endIso });
    writeTurnEnd(out, endIso);
    out.end();
    return;
  }
  if (doneEvent) {
    // 结尾带上**同一份**结局:exit 0 却被判失败、留了续跑交代后崩掉(那一支不写结算说明)的回合,
    // 直播那一路只有它说得清(见 AgentEvent 的 done.turnOutcome)。
    const done = { ...doneEvent, turnOutcome };
    persistTrace(done, endIso);
    publishEvent(done);
  }
  if (dropSession) {
    const note = sessionResumeFaultNote(sessionFault!);
    // 只弹一句话不算数：用户看不出 ash 已经替他把坏 id 清了、也看不出重试会丢上下文。
    // 落成持久 system 旁注（.md 原始产物 + SSE），刷新后还在；**不落 error** —— 换会话
    // 不等于这一轮失败，真正的失败自有它自己的 error 和退出码（见 session-notice.ts）。
    // 落盘仍走缓冲：这里已经在收尾链上，正文早写完了，夹在 writeTurnEnd 前面会让重建
    // 出来的回合用时失准（见 noteSessionNotice）。
    // level:"notice" 跟结算说明同档：它也是「系统在旁边说明了一件事」，不是这一轮的输入、
    // 也不是失败。标了之后展示端不必再靠关键词绕开它（conversationNotes 为这条文案专门
    // 写过一段例外），「重跑上一回合」找上一次输入时也会跳过它。
    noteSessionNotice(note, endIso, "notice");
  }
  // 这一轮有没有「交卷时通道断了」的调用：有就替它补录。**必须排在 settleTaskStatus
  // 之前** —— complete_task 的补录要赶在结算读确认标记之前落库，晚一步，一个干完活的
  // 任务就已经被记成 failed 了（详见 mcp-handoff.ts）。
  await replayUndeliveredMcpCalls({
    taskId,
    sessId,
    turnStart: a.turnStart,
    agentType,
  }).catch(() => 0);
  await persistRunGoal(taskId, agentType, a.handle, exitStatus, stopped);
  // **结算看的退出码必须反映熔断**。库里那一列(上面刚写的 `exitStatus`)记真实值不动;
  // 结算这一笔得换成非零,因为被我们杀掉的 CLI 报不出非零 —— claude 走信号退出时
  // `claude-stream.ts` 写的是 `code ?? 0`(信号退出 `code` 为 null,于是 0)。照原样交进去,
  // 一个永远连不上上游的回合会走进「exit 0」那几支:本轮早先交过卷就落 done,名下还有活动
  // 哨兵就落 paused —— 时间线上红着写「按失败结算」,任务却显示完成(第 1 轮审查第 2 条)。
  const settleExit = watchdogFailure && exitStatus === 0 ? 1 : exitStatus;
  // 退出码只够让它**不落 done**;要让它别落成「检查点暂停」,得把原因本身交进去 ——
  // 提问 / 续跑指令 / 持续目标那三支都排在非零退出之前,一个留过续跑指令的回合于是显示
  // 「暂停中 + 继续」,而同一轮区间记 failed(第 3 轮审查 F1,已实测)。落位规则仍然只有
  // 结算那一个单点,这里只负责如实报原因。
  const settled = await settleTaskStatus(taskId, settleExit, stopped, sessId,
    // 原因原样交进去:判决自己带着种类,这里不做翻译 —— 两份同义枚举之间的手工映射,加一种
    // 原因时漏掉就会被 `else` 静默吞掉(上一版就是那个形状)。
    watchdogFailure ? { kind: watchdogFailure.kind, detail: watchdogFailure.reason } : null);
  clearStallFailure(sessId, a.turnStart); // 这一轮结算完了,销账(见那个文件里的水位)
  clearTurnStart(taskId); // 只有「未确认 failed」那一支会读它,别的支路在这儿扔掉残页
  // 这一轮到底改没改东西:账在回合开头就清过了,这里只管「白清了要放回去」——
  // 一个字节没改就把游标/轮数/验收阶段原样放回,屋子是临时搭的还顺手拆掉。
  // 只看照片,confirmedDone 只挑那行时间线的措辞(理由见 turn-baseline.ts)。
  // **必须排在 afterSettlement 之前** —— 那一步会拿着游标把这条线往下推,放回晚一步
  // 就会把纯询问回合的游标推乱(详见 turn-baseline.ts)。
  await reconcileTurnBaseline(taskId, settled.confirmedDone);
  // turnOk = 这一回合本身干净收尾了(没被停、退出码 0、也没有执行器 error 事件)。
  // 跟落位状态不是一回事:旁路
  // 回合(就地验证)的落位是任务原来的终态,只有它说得清这一轮跑成没跑成。
  //
  // 原生命令回合(`/compact`)整段跳过:它是 CLI 本地的一次压缩,没有模型输出、没有
  // 结论 —— 交给结算钩子的话,正在跑的那一轮就地验证会被当成「验完了」收掉(清轮次、
  // 涨轮数、却给不出 verified/verify_failed),自由工作流那边同理。
  if (!settled.nativeTurn) {
    await afterSettlement(
      taskId,
      settled.status,
      settled.confirmedDone,
      !stopped && !executionFailed,
      role,
      !!doneEvent,
      executionFailed,
    );
  }
  // 审查旁路回合没给出结论：把真实原因说出来（中途断了 / 收尾了却没上报，review-channel-gap.ts）。
  // **排在 afterSettlement 之后** —— 那一步里自由工作流才写下「未能正常给出结论，已停止
  // 自动链」，这一句紧跟其后才读得通（先结果、后原因）。说不出来就什么都不说，绝不因此
  // 影响这一轮的落位。
  if (role === "reviewer") {
    // 回合身份在结算期间还占着（orchestrator 在 consumeSingleRun 之后才 releaseTurn），
    // 这一轮绑的是哪一次审查就从那里整份读。
    const review = turnIdentity(taskId)?.review ?? null;
    const failure = executionFailed ? { exitStatus, verdict: watchdogFailure, error: lastExecutionError, retrying: lastRetryModel } : null;
    await noteReviewerChannelGap({ taskId, sessId, turnStart: a.turnStart, agentType, stopped: !!stopped, review, failure })
      .catch((error) => { console.error(`[ash] noteReviewerChannelGap(${taskId}) failed:`, error); return false; });
  }
  if (settled.note) {
    // 结算说明落成**会话旁注**（持久 system 行 + SSE），跟会话轮换旁注同一条道：
    // 它讲的是「这一轮为什么落成这个状态」，不是 agent 干的活，也不是执行器报的错。
    // 从前它是「.md 里一段引用 + trace 里一条 error」，两处毛病都实打实：引用块糊进
    // agent 气泡正文（实时那份还没有，刷新后才冒出来），error 则把回合折叠条整条染红、
    // 计进「N 异常」—— 第一次用 ash 的人看到的是一个红色黑盒，读到的是「它崩了」，而
    // 真相多半只是「忘了调 complete_task」。真出故障时它还会盖住原因（docs/incidents.md
    // 「接力到多用户机器」）。
    // level:"notice" 让展示端直接知道这是提示不是故障，不必再靠关键词猜语气。
    noteSessionNotice(settled.note, endIso, "notice");
  }
  writeTurnEnd(out, endIso); // fence this turn's real end before closing the .md
  flushSessionNotices();
  out.end();
  // 普通回合 exit 0 却没交卷：会话证据点名 ash MCP 没连上时，把原因接在结算说明后面说出来
  // （先结果、后原因；只认确定证据，见 review-channel-gap.ts 的 noteTurnChannelGap）。
  if (role !== "reviewer" && settled.failureReason === "missing_completion_confirmation") {
    await noteTurnChannelGap({ taskId, sessId, turnStart: a.turnStart, agentType })
      .catch((error) => { console.error(`[ash] noteTurnChannelGap(${taskId}) failed:`, error); return false; });
  }
  } finally {
    // 正常路径上上面那句已经把旁注清空了，这里是**异常路径**的保险：清库、重放、结算
    // 任何一步抛错，都不能让「这条会话作废了、下次会丢上下文」只活在实时 SSE 里 ——
    // 用户一刷新就什么都看不到，还会去重试同一条坏会话。flushSessionNotices 先取空再写，
    // 所以正常路径走到这里必然是空的，绝不会往已经 end 掉的流上再写一次（写已 end 的
    // 流会当场打崩 server，见 duet/turn.ts 里同样的告诫）。
    flushSessionNotices();
    await closeExecution("failed", now());
  }
}
