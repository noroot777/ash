import type { ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import type { AgentEvent, TokenUsage } from "@ash/shared";
import { persistMarkdownImages, persistToolResultImages } from "../agent-attachments.js";
import {
  formatFailureForTimeline,
  formatSessionPoisonForTimeline,
  RunTraceRecorder,
  type RunTracePaths,
} from "./diagnostics.js";
import { detachedInfo, spawnControllableForRun, type DetachedPaths } from "./detached.js";
import { cleanupAfterRun, forceFinishOnExit, killChild, redactSecrets, shq, spawnErrorMessage } from "./spawn.js";
import type { RunHandle } from "./types.js";

type TokenBreakdown = {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
};

type ThreadUsage = {
  total: TokenBreakdown;
  last: TokenBreakdown;
  modelContextWindow: number | null;
};

export type CodexAppServerOpts = {
  bin: string;
  args: string[];
  cwd: string;
  prompt: string;
  sessionId?: string;
  model?: string;
  reasoningEffort?: string;
  serviceTier?: string;
  env?: Record<string, string | undefined>;
  trace?: RunTracePaths;
  detach?: DetachedPaths;
  commandLine?: string;
  reattach?: { threadId: string; turnId: string };
  startProcess?: () => ChildProcess;
};

/** 一个 app-server 进程只承载当前单飞回合；turn/completed 后立即关闭。 */
export function openCodexAppServer(opts: CodexAppServerOpts): RunHandle {
  const child = opts.startProcess?.()
    ?? spawnControllableForRun(opts.cwd, opts.bin, opts.args, "", opts.env, opts.detach);
  const trace = new RunTraceRecorder(opts.trace);
  const queue: AgentEvent[] = [];
  const pending = new Map<string, { resolve(value: any): void; reject(error: Error): void }>();
  const seenAgentDeltas = new Set<string>();
  const seenReasoningDeltas = new Set<string>();
  const seenImages = new Set<string>();
  let wake: (() => void) | null = null;
  let requestId = opts.reattach ? Date.now() : 0;
  let threadId = opts.reattach?.threadId ?? opts.sessionId ?? "";
  let turnId = opts.reattach?.turnId ?? "";
  let sessionEmitted = !!opts.sessionId;
  let finished = false;
  let stopRequested = false;
  let turnCompleted = false;
  let latestUsage: ThreadUsage | null = null;
  let contextEmitted = false;
  let stderr = "";
  let lastEventType: string | null = null;
  let lastEventSummary: string | null = null;
  let agentMessageCount = 0;
  const structuredErrors: string[] = [];

  const push = (event: AgentEvent) => {
    queue.push(event);
    wake?.();
    wake = null;
  };
  const write = (message: unknown) => {
    if (finished || !child.stdin || child.stdin.destroyed || child.stdin.writableEnded) {
      throw new Error("Codex App Server 连接已关闭");
    }
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };
  const notify = (method: string, params?: unknown) => write({ method, ...(params === undefined ? {} : { params }) });
  const request = (method: string, params: unknown): Promise<any> => {
    const id = ++requestId;
    return new Promise((resolve, reject) => {
      pending.set(String(id), { resolve, reject });
      try { write({ id, method, params }); } catch (error) {
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
    if (contextEmitted) return;
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
  const finish = (exitStatus: number, message?: string) => {
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
  };

  const emitSession = (id: string) => {
    if (!id || sessionEmitted) return;
    sessionEmitted = true;
    threadId = id;
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
    if (item?.type === "commandExecution") push({ kind: "tool", name: "exec", detail: short(item.command) });
    else if (item?.type === "fileChange") push({ kind: "tool", name: "edit", detail: short(item.changes) });
    else if (item?.type === "mcpToolCall") push({ kind: "tool", name: `${item.server}/${item.tool}`, detail: short(item.arguments) });
    else if (item?.type === "dynamicToolCall") push({ kind: "tool", name: item.tool, detail: short(item.arguments) });
    else if (item?.type === "imageGeneration") push({ kind: "tool", name: "image_gen", detail: short(item.revisedPrompt) });
  };
  const handleItemCompleted = (item: any) => {
    if (item?.type === "agentMessage" && typeof item.text === "string") {
      agentMessageCount += 1;
      push({ kind: "text", text: seenAgentDeltas.has(item.id) ? "\n\n" : `${item.text}\n\n` });
      for (const path of persistMarkdownImages(item.text, seenImages)) push({ kind: "attachment", path });
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

  const completeTurn = (turn: any) => {
    turnCompleted = true;
    const status = turn?.status;
    const error = typeof turn?.error?.message === "string" ? turn.error.message : null;
    if (status === "failed" && error) {
      structuredErrors.push(error);
      push({ kind: "error", message: error });
    } else if (status === "interrupted" && !stopRequested) {
      push({ kind: "error", message: "Codex 当前回合被意外中断" });
    }
    if (latestUsage) {
      push({ kind: "usage", usage: usageEvent(latestUsage.total) });
    }
    finish(status === "completed" ? 0 : 1);
    closeProcess();
  };

  const handleNotification = (message: any) => {
    const p = message.params ?? {};
    switch (message.method) {
      case "thread/started": emitSession(p.thread?.id); break;
      case "turn/started": turnId = p.turn?.id ?? turnId; break;
      case "thread/tokenUsage/updated": latestUsage = p.tokenUsage ?? latestUsage; break;
      case "item/started": handleItemStarted(p.item); break;
      case "item/completed": handleItemCompleted(p.item); break;
      case "item/agentMessage/delta":
        seenAgentDeltas.add(p.itemId);
        if (p.delta) push({ kind: "text", text: p.delta });
        break;
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/textDelta":
        seenReasoningDeltas.add(p.itemId);
        if (p.delta) push({ kind: "thinking", text: p.delta });
        break;
      case "item/plan/delta":
        if (p.delta) push({ kind: "thinking", text: p.delta });
        break;
      case "error":
        if (!p.willRetry && p.error?.message) {
          structuredErrors.push(p.error.message);
          push({ kind: "error", message: p.error.message });
        }
        break;
      case "turn/completed": completeTurn(p.turn); break;
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
      if (message.error) waiter.reject(new Error(short(message.error?.message ?? message.error)));
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
  child.on("close", (code, signal) => {
    if (finished) return;
    const detail = stderr.trim().slice(-2_000);
    finish(code ?? (signal ? 1 : 0), detail || "Codex App Server 在回合结束前退出");
  });
  forceFinishOnExit(child, () => finished, (exit) => finish(exit, "Codex App Server 输出流未正常收尾"));

  const ready = opts.reattach ? Promise.resolve() : (async () => {
    await request("initialize", {
      clientInfo: { name: "ash", title: "ash", version: "0.0.0" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    notify("initialized");
    const thread = opts.sessionId
      ? await request("thread/resume", threadParams(opts, { threadId: opts.sessionId }))
      : await request("thread/start", threadParams(opts));
    emitSession(thread.thread?.id ?? opts.sessionId ?? "");
    const started = await request("turn/start", {
      threadId,
      input: textInput(opts.prompt),
      cwd: opts.cwd,
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.reasoningEffort ? { effort: opts.reasoningEffort } : {}),
      ...(opts.serviceTier ? { serviceTier: opts.serviceTier } : {}),
    });
    turnId = started.turn?.id ?? "";
    if (!threadId || !turnId) throw new Error("Codex App Server 没有返回 threadId/turnId");
  })();
  void ready.catch((error) => {
    finish(1, error instanceof Error ? error.message : String(error));
    closeProcess();
  });

  let steerTail = Promise.resolve();
  const events = (async function* (): AsyncIterable<AgentEvent> {
    while (true) {
      if (queue.length) {
        yield queue.shift()!;
        continue;
      }
      if (finished) return;
      await new Promise<void>((resolve) => { wake = resolve; });
    }
  })();
  return {
    sessionId: opts.sessionId ?? "",
    commandLine: opts.commandLine
      ?? redactSecrets(`${opts.bin} ${opts.args.map(shq).join(" ")} <App Server JSONL via stdin>`),
    events,
    detached: detachedInfo(child),
    cleanup: () => cleanupAfterRun(child),
    steer(text: string) {
      const operation = steerTail.then(async () => {
        await ready;
        if (finished || stopRequested) throw new Error("Codex 当前回合已经结束");
        if (!threadId || !turnId) throw new Error("Codex App Server 重连后缺少当前 thread/turn 标识");
        const result = await request("turn/steer", {
          threadId,
          expectedTurnId: turnId,
          input: textInput(text),
        });
        turnId = result.turnId ?? turnId;
      });
      steerTail = operation.catch(() => undefined);
      return operation;
    },
    kill() {
      if (finished || stopRequested) return;
      stopRequested = true;
      if (!threadId || !turnId) {
        killChild(child);
        return;
      }
      void request("turn/interrupt", { threadId, turnId }).catch(() => undefined);
      const timer = setTimeout(() => {
        if (!finished) killChild(child);
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
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.serviceTier ? { serviceTier: opts.serviceTier } : {}),
  };
}

function usageEvent(value: TokenBreakdown): TokenUsage {
  return {
    input: Math.max(0, value.inputTokens - value.cachedInputTokens),
    output: value.outputTokens,
    cacheRead: value.cachedInputTokens,
    cacheWrite: 0,
    reasoning: value.reasoningOutputTokens,
    costUsd: null,
    turns: 1,
  };
}

const short = (value: unknown): string => {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return text.length > 1_500 ? `${text.slice(0, 1_497)}…` : text;
};

/** 重启接管时从完整协议日志找回当前 turn id；stdout offset 可能早已越过启动通知。 */
export function readCodexAppServerState(
  path: string,
  knownThreadId = "",
): { threadId: string | null; turnId: string | null } {
  let threadId: string | null = knownThreadId || null;
  let turnId: string | null = null;
  let raw = "";
  try { raw = readFileSync(path, "utf8"); } catch { return { threadId, turnId }; }
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let message: any;
    try { message = JSON.parse(line); } catch { continue; }
    if (message.method === "thread/started" && typeof message.params?.thread?.id === "string") {
      threadId = message.params.thread.id;
    } else if (message.method === "turn/started"
      && (!threadId || message.params?.threadId === threadId)
      && typeof message.params?.turn?.id === "string") {
      threadId = message.params?.threadId ?? threadId;
      turnId = message.params.turn.id;
    }
  }
  return { threadId, turnId };
}
