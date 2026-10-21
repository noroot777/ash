// 单飞任务「跑一回合」:**消费事件流**,以及结算之后的那些钩子。
//
// 从 orchestrator.ts 拆出来（那边已经超过 700 行的单文件上限）。依赖方向是
// 单向的：orchestrator / reattach 都 import 这里，这里不回头 import 它们 ——
// 结算规则是全局单点，谁也不该另造一份。
//
// **「这一笔该落成哪个状态」已经搬到 `settle-status.ts`**（同一条上限）:那一段自成一块
// 职责（续聊/原生/手停/提问/检查点/严格完成协议/哨兵闸），而且被引导、重试、测试直接调。
import type { WriteStream } from "node:fs";
import type { AgentEvent, AgentType, SessionRole } from "@ash/shared";
import { and, eq, sql } from "drizzle-orm";
import { db } from "./db/index.js";
import { tasks, sessions } from "./db/schema.js";
import { bus } from "./bus.js";
import { closeSessionTurns, recordTurnSpan } from "./session-turns.js";
import { scanForTitle } from "./auto-title.js";
import {
  adoptRun, bindNativeSteer, finalizeAbandonedRun, takeSteered, takeStopped,
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
import { isSessionScopeNotice } from "./session-notice.js";
import { createExecutionCloser, recordFreeTaskExecutionStartIfFree } from "./free-workflow-events.js";
import { reconcileTurnBaseline } from "./turn-baseline.js";
import { clearTurnStart } from "./turn-output.js";
import { replayUndeliveredMcpCalls } from "./mcp-handoff.js";
import { afterSettlement, settleTaskStatus } from "./settle-status.js";
import { recordSessionUsageEvent, setSessionContext } from "./usage.js";
import { markCliGoalStarted, persistRunGoal } from "./task-cli-state.js";

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
  let doneEvent: AgentEvent | null = null;
  let streamError: unknown = null;
  // CLI 有时把 API 层失败报成 error 事件后仍以 exit 0 收尾（Claude 的
  // is_error/api_error_status 就是这种）。退出码只能说明进程活着走完，不能证明这一轮
  // 执行成功；自由工作流据此决定是否继续自动复审链。
  let sawExecutionError = false;
  // CLI 否认过这条会话，或 Codex stderr 证明 thread 已 poisoned 吗（见
  // executors/session-lost.ts）。认下来的话这一轮收尾时要把失效 id 从库里清掉，
  // 否则每一次重试都在 --resume 同一条坏会话。
  let sessionFault: SessionResumeFault | null = null;
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
    type: "agent.event", taskId, sessionId: sessId, role, agentType, ...runMeta, event,
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
  // 智能体自己起的标题（见 auto-title.ts）。没解析到就什么也不做：任务留着建它时那个
  // 临时名（body 首行），下一次 fresh run 还会再试一次——autoTitle 只在真的改成时才关。
  const applyAutoTitle = async (newTitle: string | null) => {
    if (!newTitle) return;
    const updatedAt = now();
    // 条件里带上 auto_title=1:**这一轮跑到一半时任务可能已经被显式改过名了** —— 用户在
    // 界面上改，或者 agent 自己调 patch_task 改。那句改名的语义是「这就是标题」，不该被
    // 随后吐出来的 `标题：xxx` 盖回去。titleDone 是回合开头读的快照，答不了「此刻库里
    // 还允不允许自动命名」，只有库自己答得了。没更新到行就当什么都没发生，连事件也不发。
    const hit = await db
      .update(tasks)
      .set({ title: newTitle, autoTitle: false, updatedAt })
      .where(and(eq(tasks.id, taskId), eq(tasks.autoTitle, true)))
      .returning({ id: tasks.id });
    if (!hit.length) return;
    bus.publish({ type: "task.title", taskId, title: newTitle, updatedAt });
  };
  // 给标题窗口一个结论：命中就改名并把标题行摘掉，没命中就把攒下的正文原样放出去。
  // 返回 false = 还没有结论（窗口没走完），继续攒。
  const resolveTitle = async (flush: boolean) => {
    const scan = scanForTitle(head, flush);
    if (scan.kind === "buffer") return false;
    await applyAutoTitle(scan.title);
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
  const detached = a.handle.detached;
  const offsetTimer = detached
    ? setInterval(() => {
        void db
          .update(sessions)
          .set({ agentOffset: detached.committed() })
          .where(eq(sessions.id, sessId))
          .catch(() => {});
      }, 1000)
    : null;
  (offsetTimer as { unref?: () => void } | null)?.unref?.();

  try {
    for await (const event of a.handle.events) {
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
          ? await recordSessionUsageEvent(sessId, event, agentType, cliSessionId)
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
        if (emittedEvent.kind === "error") {
          // 有些 error 是需要留在红色诊断块里的旁路故障，但不代表模型回合失败（目前的
          // 实例是 Claude 自动压缩失败：压缩没成，后续 result 仍明确为 success）。
          if (emittedEvent.affectsTurn !== false) sawExecutionError = true;
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
    if (offsetTimer) clearInterval(offsetTimer);
    await a.handle.cleanup?.().catch((error) => {
      console.warn(`[ash] failed to clean descendants after task ${taskId}:`, error);
    });
    // 进程资源到此已经收干净(cleanup 覆盖根进程与它甩出去的后代),外层那道兜底不必再
    // 补刀;后面结算段再抛错也只是结算的事,不会留下无主进程。
    markStreamDrained();
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
  const executionFailed = !stopped && (exitStatus !== 0 || sawExecutionError);
  // CLI 否认了这条会话：把失效的 id 连同由它派生的三件套恢复命令一起清掉。清了之后
  // orchestrator 的 `resuming`（判据就是「这条会话行上有没有 cli_session_id」）自然为
  // 假，下一次运行走全新会话那条路 —— 不必在别处再加一个「要不要续」的开关。
  // 普通 lost 仍要求非零退出，防止正文碰巧出现原话；poisoned 是 stderr 诊断生成的
  // error，即使 exit 0 / turn.completed 也必须清掉。
  const dropSession = !steered && shouldDropSession(sessionFault, exitStatus);
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
      agentPid: null,
      agentOffset: detached ? detached.committed() : null,
      ...(dropSession ? LOST_SESSION_PATCH : {}),
    })
    .where(eq(sessions.id, sessId));
  // 这一回合的区间单独落一行：产物归属要的是「它在写这个目录」的那几段，而上面那行
  // 会话记录跨回合复用，只留得下最后一次收尾时刻（`db/schema.ts` 的 sessionTurns）。
  await recordTurnSpan({ sessionId: sessId, taskId, cwd: a.cwd, startedAt: a.turnStart, endedAt: endIso });
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
    persistTrace(doneEvent, endIso);
    publishEvent(doneEvent);
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
  const settled = await settleTaskStatus(taskId, exitStatus, stopped, sessId);
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
