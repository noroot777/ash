import { createInterface } from "node:readline";
import { codexChildWork, codexNativeWork, codexSubAgentWork, nativeAgentProfile, nativePlanSnapshot, NativeWorkTrace } from "./native-work.js";
import { childActivity, CodexChildActivity } from "./native-agent-activity.js";
import { NativeActivityBuffer } from "./native-activity-buffer.js";
import type { AgentEvent } from "@ash/shared";
import { imageStore, persistToolResultImages, type ImageStore } from "../agent-attachments.js";
import { eventQueue } from "./event-queue.js";
import { markdownImageSink, settleMarkdownImages } from "./markdown-image-stream.js";
import {
  formatFailureForTimeline,
  formatSessionPoisonForTimeline,
  RunTraceRecorder,
} from "./diagnostics.js";
import { detachedInfo, spawnControllableForRun } from "./detached.js";
import { cleanupAfterRun, forceFinishOnExit, killChild, redactSecrets, shq, spawnErrorMessage } from "./spawn.js";
import { codexErrorEvent } from "./codex-error-event.js";
import {
  adoptionDriven, adoptionUnverifiable, CodexRpcRefusal, createTurnInputLedger, wireAdoptionRecovery,
} from "./codex-app-server-adopt.js";
import {
  ADOPT_NEVER_STARTED, CODEX_ADOPT_REREAD_MS, CODEX_TURN_START_ACK_MS, short, usageEvent,
  type CodexAppServerOpts, type ThreadUsage,
} from "./codex-app-server-contract.js";
import type { RunHandle } from "./types.js";
import { resolveSteerText, type SteerText } from "./steer-text.js";
import { findArchivedRollout, findRollout, readCodexContext } from "./codex-rollout.js";
import { archiveCodexThread, codexArchiveNotice, CODEX_ARCHIVE_TIMEOUT_MS } from "./codex-session-archive.js";
import { pruneArchivedCodexDesktopThreads } from "./codex-desktop-catalog.js";
import { CodexNativeCommands } from "./codex-native-commands.js";
import { isGoalExecution } from "@ash/shared/cli-commands";
import { withGlobalBrowserPolicy } from "../browser-verification-policy.js";
/** 一个 app-server 进程承载一个单飞回合，收尾归档后关闭；配置仍来自用户本机。 */
export function openCodexAppServer(opts: CodexAppServerOpts): RunHandle {
  const child = opts.startProcess?.()
    ?? spawnControllableForRun(opts.cwd, opts.bin, opts.args, "", opts.env, opts.detach);
  const trace = new RunTraceRecorder(opts.trace);
  const pending = new Map<string, { method: string; resolve(value: any): void; reject(error: Error): void }>();
  const seenAgentDeltas = new Set<string>();
  const seenReasoningDeltas = new Set<string>();
  const seenImages: ImageStore = imageStore();
  const nativeWork = new NativeWorkTrace();
  let requestId = opts.reattach ? Date.now() : 0;
  let threadId = opts.reattach?.threadId ?? opts.sessionId ?? "";
  let turnId = opts.reattach?.turnId ?? "";
  let turnStartVersion = 0;
  let reviewTurnId = opts.reattach?.reviewTurnId ?? "";
  /**
   * **这一轮有开始凭据、却拿不到身份**:`turn/start` 的应答迟到/不来而 `turn/started` 已经到了,
   * 或者通知里没带 id。身份于此改由完成事件认领(同接管「读不出来」那一档,见 completeTurn)。
   */
  let identityUnclaimed = false;
  const replacingSession = ["fork", "new", "clear"].includes(opts.cliCommand?.name ?? "");
  let sessionEmitted = !!opts.sessionId && !replacingSession;
  let finished = false;
  let settling = false;
  let connectionClosed = false;
  let stopRequested = false;
  let turnCompleted = false;
  let commandCompleted = false;
  let transientThread = false;
  let lastCompletedStatus = "completed";
  const completedTurns = new Set<string>();
  let resolvedModel = opts.model ?? "";
  let resolvedEffort = opts.reasoningEffort ?? null;
  let latestUsage: ThreadUsage | null = null;
  let contextEmitted = false;
  let stderr = "";
  let lastEventType: string | null = null;
  let lastEventSummary: string | null = null;
  let agentMessageCount = 0;
  const childEvents = new CodexChildActivity();
  const childImages = new Map<string, ImageStore>();
  const childModelReads = new Set<string>();
  const childModelVersions = new Map<string, number>();
  const structuredErrors: string[] = [];
  // 正文里的图**不在这份协议解析里收**:一条 agentMessage 只是一片碎片,上一条消息给定义、
  // 下一条引用它时按消息扫压根不认那张图(审查第 4 轮 R2)。主会话与每个子 thread 各一笔
  // 账,统一按「一份文档」记(见 markdown-image-stream.ts)。
  //
  // 队列、唤醒、增量合并、子活动合并和**图片记账的时点**都在这条共用流水线里(见
  // event-queue.ts)。字节在 `delta`/`push` 的那一刻就冻住,交代排在两级缓冲和队列之后 ——
  // 挂反了,短子正文会滞留在 40 字合并缓冲里,期间父步骤把文件重拍,正文写着「修改前是
  // 红色」却存成后来那张蓝图(审查第 5 轮 R1、第 6 轮 R1)。
  //
  // 增量为什么要攒:DeepSeek 一类**把完整 reasoning 正文流回来**的模型,一个词就是一条
  // `item/reasoning/textDelta`(实测一轮 10 万条、平均 3.6 字符);逐条转成 thinking 事件,
  // SSE、trace 落盘和「执行过程」里的行数会跟着放大一百倍 —— 界面上就是一行一个单词的
  // 「思考过程 The」「思考过程 output」。阈值跟 claude 主流同一把尺子,思考取更粗的一档:
  // 它在折叠块里只显示一行摘要,不像正文那样需要逐字顺滑。
  const images = markdownImageSink(opts.cwd, opts.images);
  const outbox = eventQueue({
    images,
    activity: new NativeActivityBuffer(),
    coalesce: { text: 40, thinking: 240 },
  });
  // 攒着的增量必须排在**任何**后到的事件之前,否则思考会漂到它引出的工具调用后面 ——
  // `push` 自己会先收口缓冲,所以既有调用点一个字都不用改。
  const push = (event: AgentEvent) => outbox.push(event);
  const pushDelta = (kind: "text" | "thinking", delta: unknown) => {
    if (typeof delta !== "string" || !delta) return;
    outbox.delta(kind, delta);
  };
  const write = (message: unknown) => {
    if (finished || connectionClosed || !child.stdin || child.stdin.destroyed || child.stdin.writableEnded) {
      throw new Error("Codex App Server 连接已关闭");
    }
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };
  const notify = (method: string, params?: unknown) => write({ method, ...(params === undefined ? {} : { params }) });
  const request = (method: string, params: unknown, timeoutMs?: number): Promise<any> => {
    const id = ++requestId;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
        pending.delete(String(id));
        reject(new Error(`Codex ${method} 超时`));
      }, timeoutMs);
      pending.set(String(id), {
        method,
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      try { write({ id, method, params }); } catch (error) {
        clearTimeout(timer);
        pending.delete(String(id));
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  };

  const closeProcess = () => {
    try { child.stdin?.end(); } catch { /* 已关闭 */ }
    const timer = setTimeout(() => {
      if (child.exitCode === null) killChild(child);
    }, 1_000);
    (timer as { unref?: () => void }).unref?.();
    child.once("close", () => clearTimeout(timer));
  };
  const emitContext = () => {
    if (contextEmitted || (opts.cliCommand && !latestUsage)) return;
    contextEmitted = true;
    push({
      kind: "context",
      context: latestUsage
        ? {
            used: latestUsage.last.totalTokens,
            window: latestUsage.modelContextWindow,
            windowEstimated: false,
          }
        : { used: 0, window: null, windowEstimated: false },
    });
  };
  const finishImmediately = (exitStatus: number, message?: string) => {
    if (finished) return;
    finished = true;
    for (const waiter of pending.values()) waiter.reject(new Error(message ?? "Codex App Server 已结束"));
    pending.clear();
    if (message && !stopRequested) {
      structuredErrors.push(message);
      push({ kind: "error", message });
    }
    const diagnostics = trace.finish({
      exitStatus,
      exitSignal: child.signalCode,
      stopRequested,
      turnCompleted,
      commandCompleted,
      turnFailedMessage: message ?? null,
      structuredErrors,
      lastEventType,
      lastEventSummary,
      agentMessageCount,
    });
    const failure = formatFailureForTimeline(diagnostics);
    if (failure && !stopRequested && failure !== message) push({ kind: "error", message: failure });
    const sessionPoison = formatSessionPoisonForTimeline(diagnostics);
    if (sessionPoison) push({ kind: "error", message: sessionPoison, scope: "session" });
    emitContext();
    push({ kind: "done", exitStatus });
    outbox.close();
  };

  const archivedThreadIds = new Set<string>();
  const finish = (exitStatus: number, message?: string) => {
    if (finished || settling) return;
    settling = true;
    void (async () => {
      try {
        if (threadId && !transientThread) {
          try {
            if (connectionClosed) throw new Error("Codex App Server 连接已关闭");
            await request("thread/archive", { threadId }, CODEX_ARCHIVE_TIMEOUT_MS);
          } catch (error) {
            // 超时/硬停止后先收掉旧进程，再用短连接补归档，避免同一文件仍被旧进程写入。
            await cleanupAfterRun(child);
            if (!(await findArchivedRollout(threadId, opts.env?.CODEX_HOME))) {
              if (!(await findRollout(threadId, opts.env?.CODEX_HOME))) throw error;
              await archiveCodexThread({
                bin: opts.bin,
                args: opts.args,
                cwd: opts.cwd,
                env: opts.env,
              }, threadId);
            }
          }
          await pruneArchivedCodexDesktopThreads([threadId, ...archivedThreadIds], opts.env?.CODEX_HOME);
        }
      } catch (error) {
        push(codexArchiveNotice(error));
      } finally {
        finishImmediately(exitStatus, message);
        closeProcess();
      }
    })();
  };

  const emitSession = (id: string, force = false) => {
    if (!id || sessionEmitted) return;
    threadId = id;
    if (opts.cliCommand && !force) return;
    sessionEmitted = true;
    push({ kind: "session", cliSessionId: id });
  };
  if (opts.reattach && threadId && !sessionEmitted) emitSession(threadId);
  const handleServerRequest = (message: any) => {
    if (message.method === "currentTime/read") {
      write({ id: message.id, result: { currentTimeAt: Math.floor(Date.now() / 1000) } });
    } else if (message.method === "item/commandExecution/requestApproval"
      || message.method === "item/fileChange/requestApproval") {
      write({ id: message.id, result: { decision: "decline" } });
    } else if (message.method === "item/tool/requestUserInput") {
      write({ id: message.id, result: { answers: {} } });
    } else {
      write({ id: message.id, error: { code: -32601, message: `ash 不处理 App Server 请求 ${message.method}` } });
    }
  };

  const handleItemStarted = (item: any) => {
    for (const activity of codexNativeWork(item)) push(activity);
    if (item?.type === "commandExecution") push({ kind: "tool", name: "exec", detail: short(item.command) });
    else if (item?.type === "fileChange") push({ kind: "tool", name: "edit", detail: short(item.changes) });
    else if (item?.type === "mcpToolCall") push({ kind: "tool", name: `${item.server}/${item.tool}`, detail: short(item.arguments) });
    else if (item?.type === "dynamicToolCall") push(nativeWork.call(item.tool, item.arguments, item.id)
      ?? { kind: "tool", name: item.tool, detail: short(item.arguments) });
    else if (item?.type === "imageGeneration") push({ kind: "tool", name: "image_gen", detail: short(item.revisedPrompt) });
  };
  const handleItemCompleted = (item: any) => {
    for (const activity of codexNativeWork(item)) push(activity);
    if (item?.type === "dynamicToolCall") {
      const activity = nativeWork.result(item.id, item.contentItems ?? item.result, item.success === false);
      if (activity) push(activity);
    }
    if (item?.type === "agentMessage" && typeof item.text === "string") {
      agentMessageCount += 1;
      push({ kind: "text", text: seenAgentDeltas.has(item.id) ? "\n\n" : `${item.text}\n\n` });
    } else if (item?.type === "reasoning") {
      const text = [...(item.summary ?? []), ...(item.content ?? [])].join("\n");
      if (seenReasoningDeltas.has(item.id)) push({ kind: "thinking", text: "\n\n" });
      else if (text) push({ kind: "thinking", text: `${text}\n\n` });
    } else if (item?.type === "mcpToolCall") {
      for (const path of persistToolResultImages(item.result ?? item.error, seenImages)) push({ kind: "attachment", path });
    } else if (item?.type === "imageGeneration") {
      for (const path of persistToolResultImages(item.result, seenImages, { allowBareBase64: true })) push({ kind: "attachment", path });
      if (typeof item.savedPath === "string") push({ kind: "attachment", path: item.savedPath });
    }
  };

  const native = new CodexNativeCommands({
    request: (method, params) => request(method, params, 30_000), threadId: () => threadId,
    turnId: () => turnCompleted ? "" : turnId, model: () => resolvedModel, cwd: opts.cwd, prompt: opts.prompt, state: opts.cliState, usage: () => latestUsage, push,
    reasoningEffort: () => resolvedEffort,
    context: () => readCodexContext(threadId, 0, opts.env?.CODEX_HOME),
    turnOptions: {
      ...(opts.reasoningEffort ? { effort: opts.reasoningEffort } : {}),
      ...(opts.cliState?.serviceTier || opts.serviceTier ? { serviceTierForTurn: opts.cliState?.serviceTier ?? opts.serviceTier } : {}),
    },
  });
  if (opts.reattach) native.goalStarted = !!opts.reattach.turnId;
  if (opts.reattach?.goal) { native.goal = opts.reattach.goal; native.goalExecution = true; }
  const completeTurn = async (turn: any) => {
    const completedId = turn?.id ?? turnId;
    if (completedTurns.has(completedId) || settling || finished) return;
    completedTurns.add(completedId);
    // **等的是「身份有凭据可认」,不是那段本地流程返回**(第 3 轮自由审查 F3):`turn/start` 的
    // 应答不回来、而 `turn/started` 通知和 `turn/completed` 都到了,是实测存在的形状 —— 旧代码
    // 在这儿 `await ready`,于是「做完了却永远不结束」,而工具事件早把静默档解除了。
    // `started` 由账本落定:通知/应答哪个先到算哪个,这条路彻底断了也会放行(见下面那道闸)。
    await input.started;
    if (settling || finished) return;
    // **身份未定时认领它**(第 2 轮自由审查 F4):接管时协议日志读不出来,我们手上没有 turnId,
    // 于是这一轮真正的完成事件会在下面那道身份检查上被丢掉 —— 常驻进程还活着、进展记号又是
    // `seen`(重启前确实产出过,静默档按判据不该开),「连答完了都不结算」就成了新的无界等待。
    // 认它是安全的:一个 app-server 进程同一时刻只跑一个回合(这整份文件的前提),而我们接回来
    // 的就是那一个,所以这个 thread 上下一条完成事件只能是它。
    if ((unverifiable || identityUnclaimed) && !turnId && !reviewTurnId && typeof turn?.id === "string" && turn.id) {
      turnId = turn.id;
      console.warn(`[ash] 会话 ${opts.sessionId ?? ""} 这一轮的身份此前无从得知（${unverifiable ? "接管时协议日志读不出来" : "有开始凭据但应答没给出 turnId"}），`
        + `按「这个 thread 上的完成事件就是这一轮」认领（turn=${turnId}）`);
    }
    if (completedId !== (reviewTurnId || turnId)) return;
    turnCompleted = true;
    const status = turn?.status;
    lastCompletedStatus = status;
    const error = typeof turn?.error?.message === "string" ? turn.error.message : null;
    if (status === "failed" && error) {
      structuredErrors.push(error);
      push({ kind: "error", message: error });
    } else if (status === "interrupted" && !stopRequested && !native.expectedInterruption) {
      push({ kind: "error", message: "Codex 当前回合被意外中断" });
    }
    if (!(await native.afterTurn())) return;
    if (!turnCompleted || completedId !== (reviewTurnId || turnId)) return;
    if (latestUsage) {
      push({ kind: "usage", usage: usageEvent(latestUsage.total) });
    }
    finish(status === "completed" || (status === "interrupted" && native.expectedInterruption) ? 0 : 1);
  };

  const handleNotification = (message: any) => {
    if (message.method === "thread/archived" && typeof message.params?.threadId === "string") {
      archivedThreadIds.add(message.params.threadId);
      return;
    }
    if (settling || finished) return;
    const p = message.params ?? {};
    if (p.threadId === threadId && message.method.startsWith("thread/goal/")) {
      native.notification(message.method, p);
      if (native.goalExecution && turnCompleted && native.goal?.status !== "active") finish(lastCompletedStatus === "completed" || (lastCompletedStatus === "interrupted" && native.expectedInterruption) ? 0 : 1);
    }
    // 派出/收回子智能体的记录在父线程上,拿回来的状态挂在子线程 id 上 —— 两条流都要过一遍。
    for (const activity of codexSubAgentWork(message.method, p, threadId)) push(activity);
    if (threadId && p.threadId && p.threadId !== threadId) {
      if (message.method === "turn/started") childModelReads.delete(p.threadId);
      if (!childModelReads.has(p.threadId)) {
        childModelReads.add(p.threadId);
        const version = (childModelVersions.get(p.threadId) ?? 0) + 1;
        childModelVersions.set(p.threadId, version);
        void request("thread/read", { threadId: p.threadId, includeTurns: false }).then((result) => {
          if (finished || result.thread?.id !== p.threadId || childModelVersions.get(p.threadId) !== version) return;
          const spawn = result.thread.source?.subAgent?.thread_spawn ?? result.thread.source?.sub_agent?.thread_spawn;
          const agentPath: unknown = spawn?.agent_path ?? spawn?.agentPath;
          const profile = nativeAgentProfile(p.threadId, {
            model: result.thread.model, effort: result.thread.reasoningEffort ?? result.thread.effort,
            title: typeof agentPath === "string" ? agentPath.split("/").filter(Boolean).at(-1) : undefined,
          });
          if (profile) push(profile);
        }).catch(() => undefined);
      }
      for (const activity of childEvents.notification(message.method, p)) push(activity);
      if (message.method === "item/completed") {
        const item = p.item;
        const seen: ImageStore = childImages.get(p.threadId) ?? imageStore();
        childImages.set(p.threadId, seen);
        // 正文里的图归 withMarkdownImages(子智能体那份抽屉正文是它自己一笔账);这里只收
        // 工具结果里那几张 base64 截图 —— 它们不是正文语法,按 item 交代就是对的。
        if (item?.type !== "agentMessage") {
          const results = persistToolResultImages(item?.result ?? item?.contentItems ?? item?.error, seen, { allowBareBase64: item?.type === "imageGeneration" });
          for (const path of results) push(childActivity(p.threadId, { kind: "attachment", path }));
        }
        if (item?.type === "imageGeneration" && typeof item.savedPath === "string") push(childActivity(p.threadId, { kind: "attachment", path: item.savedPath }));
      }
      for (const activity of codexChildWork(message.method, p)) push(activity);
      return;
    }
    switch (message.method) {
      case "turn/plan/updated": {
        push(nativePlanSnapshot(`plan:${p.turnId}`, p.plan, p.explanation));
        break;
      }
      case "thread/started": emitSession(p.thread?.id); break;
      // `turn/started` 到了就证明**这一轮的输入已经在 agent 手里**(它可能先于 `turn/start`
      // 的应答到达,adapter 自己的 turnStartVersion 就是为这个乱序准备的)。置上之后不许退回:
      // 后面断链只能是 unknown,不能冒充「一个字都没进去」(F4)。
      case "turn/started": turnId = p.turn?.id ?? turnId; turnStartVersion += 1; turnCompleted = false; input.reached(); break;
      case "thread/tokenUsage/updated": latestUsage = p.tokenUsage ?? latestUsage; break;
      case "item/started": handleItemStarted(p.item); break;
      case "item/completed": handleItemCompleted(p.item); break;
      case "item/agentMessage/delta":
        seenAgentDeltas.add(p.itemId);
        pushDelta("text", p.delta);
        break;
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/textDelta":
        seenReasoningDeltas.add(p.itemId);
        pushDelta("thinking", p.delta);
        break;
      case "item/plan/delta":
        if (p.delta) push({ kind: "thinking", text: p.delta });
        break;
      case "error": {
        // 判据(重试中 = notice、重试完了还是错 = 裸 error)在 codex-error-event.ts ——
        // 子智能体那条路(native-agent-activity.ts)读的是同一份,别在这儿再内联一次。
        const reported = codexErrorEvent(p);
        if (!reported) break;
        if (reported.counted) structuredErrors.push(reported.event.message);
        push(reported.event);
        break;
      }
      case "turn/completed": void completeTurn(p.turn).catch((error) => finish(1, String(error))); break;
    }
  };

  const rl = createInterface({ input: child.stdout! });
  rl.on("line", (line) => {
    const text = line.trim();
    if (!text) return;
    trace.event(line);
    let message: any;
    try { message = JSON.parse(text); } catch {
      lastEventType = "unparseable_stdout";
      lastEventSummary = text.slice(0, 500);
      return;
    }
    lastEventType = typeof message.method === "string" ? message.method : "response";
    lastEventSummary = short(message.params ?? message.result ?? message.error).slice(0, 500);
    if (message.id !== undefined && message.method) {
      handleServerRequest(message);
      return;
    }
    if (message.id !== undefined) {
      const waiter = pending.get(String(message.id));
      if (!waiter) return;
      pending.delete(String(message.id));
      // 服务端**明确答了 error**,跟超时/断链分开记(第 1 轮自由审查 F3):输入账本要据此判拒收。
      if (message.error) waiter.reject(new CodexRpcRefusal(waiter.method, short(message.error?.message ?? message.error)));
      else waiter.resolve(message.result);
      return;
    }
    if (message.method) handleNotification(message);
  });
  child.stderr?.on("data", (data) => {
    const text = data.toString();
    stderr += text;
    trace.stderr(text);
  });
  child.on("error", (error: NodeJS.ErrnoException) => finish(1, spawnErrorMessage(opts.bin, error)));
  child.stdin?.on?.("error", (error: Error) => {
    connectionClosed = true;
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
    finish(1, error.message);
  });
  child.on("close", (code, signal) => {
    connectionClosed = true;
    for (const waiter of pending.values()) waiter.reject(new Error("Codex App Server 连接已关闭"));
    pending.clear();
    if (finished) return;
    const detail = stderr.trim().slice(-2_000);
    finish(code ?? (signal ? 1 : 0), detail || "Codex App Server 在回合结束前退出");
  });
  forceFinishOnExit(child, () => finished || settling, (exit) => {
    connectionClosed = true;
    finish(exit, "Codex App Server 输出流未正常收尾");
  });

  // 接管这一轮的身份与回执判定整份住在 ./codex-app-server-adopt.ts(连同「进程还在证明不了
  // 任何事」那段现场、三档各走哪条路、以及「读不出来不许冒充成功」的理由)。
  const input = createTurnInputLedger();
  const adopted = adoptionDriven(opts.reattach);
  const unverifiable = adoptionUnverifiable(opts.reattach);
  // 接管三档**当场落账本**(回执不再由 `ready` 推导,理由见 ./codex-app-server-adopt.ts):
  //   · 有凭据    → 协议日志里就摆着「这一轮开过」= accepted;
  //   · 读不出来  → unknown(投递侧留在在途),身份走下面的持续核验;
  //   · 确证没开过 → 下面的 `ready` 直接 reject,`input.failed()` 把它落成 refused。
  if (adopted) input.reached();
  else if (unverifiable) input.unverifiable();
  if (unverifiable) {
    console.warn(`[ash] 接管会话 ${opts.sessionId ?? ""} 时读不出协议日志，`
      + "这一轮有没有真的启动核实不了：不按失败结算，回执按「说不上来」记，身份走持续核验");
    // 这一档往下全在 ./codex-app-server-adopt.ts 的 `wireAdoptionRecovery`:持续重读协议日志
    // 认回身份、读出否证就收口、两头都读不出来时让它可见且有界(为什么非得有第三条出路、
    // 为什么 notice 就是那个终局责任人,都在那份注释里)。
    wireAdoptionRecovery({
      sessionId: opts.sessionId,
      reread: opts.reattach?.reread,
      settled: () => turnCompleted || finished || settling,
      claimed: () => Boolean(turnId || reviewTurnId),
      claim: (state) => {
        turnId = state.turnId;
        if (state.reviewTurnId) reviewTurnId = state.reviewTurnId;
        // 日志里摆着这一轮的开始凭据 = 那串字确实到了 agent 手里:回执这一刻才拿到肯定依据
        // (已经落定成 unknown 的那一份不翻盘,理由见那份账本)。
        input.reached();
        if (state.completedTurn) void completeTurn(state.completedTurn).catch((error) => finish(1, String(error)));
      },
      neverStarted: () => {
        // 确证输入从未到达 agent:按失败结算、收掉这个闲置进程,原文由投递侧重投。
        input.failed();
        finish(1, ADOPT_NEVER_STARTED);
      },
      voice: (message) => push({ kind: "error", level: "notice", affectsTurn: false, message }),
    }, { everyMs: CODEX_ADOPT_REREAD_MS });
  }

  const ready = opts.reattach ? ((adopted || unverifiable) ? Promise.resolve() : Promise.reject(new Error(ADOPT_NEVER_STARTED))) : (async () => {
    await request("initialize", {
      clientInfo: { name: "ash", title: "ash", version: "0.0.0" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    notify("initialized");
    if (stopRequested) throw new Error("Codex 当前回合已停止");
    if (opts.sessionId && !["new", "clear"].includes(opts.cliCommand?.name ?? "") && await findArchivedRollout(opts.sessionId, opts.env?.CODEX_HOME)) {
      await request("thread/unarchive", { threadId: opts.sessionId }, CODEX_ARCHIVE_TIMEOUT_MS);
    }
    if (stopRequested) throw new Error("Codex 当前回合已停止");
    if (opts.cliCommand?.name === "fork" && !opts.sessionId) throw new Error("当前没有可分叉的会话");
    const thread = opts.cliCommand?.name === "fork" && opts.sessionId
      ? await request("thread/fork", threadParams(opts, { threadId: opts.sessionId }))
      : opts.sessionId && !["new", "clear"].includes(opts.cliCommand?.name ?? "")
      ? await request("thread/resume", threadParams(opts, { threadId: opts.sessionId }))
      : await request("thread/start", threadParams(opts));
    resolvedModel = thread.model ?? resolvedModel;
    resolvedEffort = opts.reasoningEffort ?? thread.reasoningEffort ?? null;
    threadId = thread.thread?.id ?? opts.sessionId ?? "";
    emitSession(threadId);
    if (opts.cliCommand?.name === "fork" && opts.sessionId && threadId !== opts.sessionId) {
      await request("thread/archive", { threadId: opts.sessionId }, CODEX_ARCHIVE_TIMEOUT_MS);
      archivedThreadIds.add(opts.sessionId);
    }
    if (stopRequested) throw new Error("Codex 当前回合已停止");
    if (opts.sessionId || opts.cliCommand) await native.prepare(opts.cliCommand);
    const startVersion = turnStartVersion;
    if (opts.cliCommand) {
      input.wrote();
      const result = await native.start(opts.cliCommand);
      input.reached();
      if (opts.cliCommand.name === "review") reviewTurnId = result.turnId ?? turnId;
      if (turnStartVersion === startVersion) turnId = result.turnId ?? turnId;
      if (result.immediate) {
        commandCompleted = true;
        transientThread = !sessionEmitted && !await findRollout(threadId, opts.env?.CODEX_HOME);
        if (!transientThread) emitSession(threadId, true);
        finish(0);
      } else emitSession(threadId, true);
      return;
    }
    // 这一行之后那串字就交给 stdin 了:断链从此只能是 unknown(见上面 inputWritten)。
    input.wrote();
    // **应答有期限**(第 3 轮自由审查 F3):`turn/start` 的应答是「收下了,这一轮叫这个 id」,
    // 正常几百毫秒就回来 —— 它不回来、连接又不断,就是那条「谁都不会再说话」的缝。超时本身
    // **不是**失败结论:下面按有没有开始凭据分两条路走。
    const started = await request("turn/start", {
      threadId,
      input: textInput(opts.prompt),
      cwd: opts.cwd,
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.reasoningEffort ? { effort: opts.reasoningEffort } : {}),
      collaborationMode: native.collaborationMode(opts.cliState?.plan ? "plan" : "default"),
      ...(opts.cliState?.serviceTier || opts.serviceTier ? { serviceTierForTurn: opts.cliState?.serviceTier ?? opts.serviceTier } : {}),
    }, CODEX_TURN_START_ACK_MS).catch((error: unknown) => {
      // 没有任何开始凭据 → 这确实是「启动失败」,照常抛出去按失败结算。
      if (!input.sawStart()) throw error;
      // 有凭据(`turn/started` 已经到了)→ 这一轮**确实在飞**,应答只是迟到或丢了。杀掉它才是
      // 误杀;身份改由通知/完成事件给(见 identityUnclaimed)。
      console.warn(`[ash] 会话 ${opts.sessionId ?? ""} 的 turn/start 应答没回来，`
        + `但这一轮已有开始凭据：按「它在飞」继续，身份改由后续事件认领（${error instanceof Error ? error.message : String(error)}）`);
      return null;
    });
    if (started && turnStartVersion === startVersion) turnId = started.turn?.id ?? "";
    input.reached();
    if (!threadId) throw new Error("Codex App Server 没有返回 threadId");
    if (!turnId) {
      // 凭据在、身份没拿到:不抛(抛 = 杀一个在跑的回合),交给完成事件认领。
      identityUnclaimed = true;
      console.warn(`[ash] 会话 ${opts.sessionId ?? ""} 这一轮拿不到 turnId，`
        + "身份改由「这个 thread 上下一条完成事件就是这一轮」认领");
    }
  })();
  void ready.catch((error) => {
    // 这条路走不通了:账本按**已掌握的事实**落定(reached⇒accepted / 写出去过⇒unknown,除非
    // 承载输入的那个请求被服务端明确答了 error / 协议从没通⇒refused),并放行等身份的那一路 ——
    // 它绝不许悬在一个已经失败的流程上。
    input.failed(error);
    if (isGoalExecution(opts.cliCommand ?? null) && opts.cliState?.goal) {
      native.goal = { ...opts.cliState.goal, status: "blocked" };
      push({ kind: "system", level: "notice", aside: true, at: new Date().toISOString(), text: "原生目标启动失败，目标已保留；修复执行器配置后可 /goal resume。" });
    }
    finish(1, error instanceof Error ? error.message : String(error));
  });
  if (opts.reattach?.completedTurn) void completeTurn(opts.reattach.completedTurn).catch((error) => finish(1, String(error)));

  let steerTail = Promise.resolve();
  const events = settleMarkdownImages(outbox.drain(), images);
  return {
    cliCommand: opts.cliCommand,
    goal: () => native.goal,
    goalStarted: () => native.goalStarted,
    command: async (command) => {
      await ready;
      if (settling || finished) throw new Error("Codex 当前回合已结束");
      return native.control(command);
    },
    sessionId: replacingSession ? "" : opts.sessionId ?? "",
    // 「协议层面收下了这一轮的输入」的三档回执:判据与单调性整份在
    // ./codex-app-server-adopt.ts(含「`ready` 成功 ≠ 送到了」那一条,以及它为什么不能挂在
    // `ready` 上 —— 协议点过头、本地流程还没返回时,整条投递链会一动不动)。
    inputAccepted: input.acceptance,
    commandLine: opts.commandLine
      ?? redactSecrets(`${opts.bin} ${opts.args.map(shq).join(" ")} <App Server JSONL via stdin>`),
    events,
    detached: detachedInfo(child),
    cleanup: () => cleanupAfterRun(child),
    steer(text: SteerText) {
      const operation = steerTail.then(async () => {
        await ready;
        if (finished || settling || stopRequested) throw new Error("Codex 当前回合已经结束");
        if (!threadId || !turnId) throw new Error("Codex App Server 重连后缺少当前 thread/turn 标识");
        // 正文到这里才定稿(SteerText 可以是惰性函数,见 steer-text.ts):它要现读浏览器授权,
        // 而上面 steerTail 排队 + await ready 可能已经过去一段时间。**漏掉这一步**的后果不是
        // 「授权旧了」而是整条路断掉 —— 函数会被 JSON.stringify 丢掉,请求少了必填的 text,
        // 真实 CLI 回 `Invalid request: missing field text`(第 8 链第 2 轮审查 P1)。
        const body = await resolveSteerText(text);
        // 定稿本身也是一次 await:排在它之后再复查一遍,别把新正文送进已经收尾的回合。
        if (finished || settling || stopRequested) throw new Error("Codex 当前回合已经结束");
        if (!threadId || !turnId) throw new Error("Codex App Server 重连后缺少当前 thread/turn 标识");
        const startVersion = turnStartVersion;
        const result = await request("turn/steer", {
          threadId,
          expectedTurnId: turnId,
          input: textInput(body),
        });
        if (turnStartVersion === startVersion) turnId = result.turnId ?? turnId;
      });
      steerTail = operation.catch(() => undefined);
      return operation;
    },
    kill() {
      if (finished || settling || stopRequested) return;
      stopRequested = true;
      if (!threadId || !turnId) {
        killChild(child);
        return;
      }
      void (async () => {
        if (native.goalExecution && native.goal?.status === "active") await request("thread/goal/set", { threadId, status: "paused" }, 1_000).catch(() => undefined);
        if (!turnCompleted) await request("turn/interrupt", { threadId, turnId }).catch(() => undefined);
      })();
      const timer = setTimeout(() => {
        if (!finished && !settling) killChild(child);
      }, 2_000);
      (timer as { unref?: () => void }).unref?.();
    },
  };
}

const textInput = (text: string) => [{ type: "text", text, text_elements: [] }];

function threadParams(opts: CodexAppServerOpts, base: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...base,
    cwd: opts.cwd,
    approvalPolicy: "never",
    sandbox: "danger-full-access",
    developerInstructions: withGlobalBrowserPolicy("", "full"),
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.cliState?.serviceTier || opts.serviceTier ? { serviceTier: opts.cliState?.serviceTier ?? opts.serviceTier } : {}),
    ...(opts.cliState?.personality || opts.reasoningEffort ? { config: {
      ...(opts.cliState?.personality ? { personality: opts.cliState.personality } : {}),
      ...(opts.reasoningEffort ? { model_reasoning_effort: opts.reasoningEffort } : {}),
    } } : {}),
  };
}
