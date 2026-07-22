import { createInterface } from "node:readline";
import type { AgentEvent, ExecTarget } from "@harness/shared";
import type { AgentExecutor, RunHandle, RunOpts } from "./types.js";
import { spawnAgent, resumeFor, resumeInner, spawnErrorMessage, killChild, forceFinishOnExit } from "./spawn.js";
import { formatFailureForTimeline, RunTraceRecorder, type RunTracePaths } from "./diagnostics.js";

// Drives the real `codex` CLI in non-interactive JSON mode (prompt via stdin, `-`).
//   first:  codex exec --json --skip-git-repo-check -C <cwd>
//             --dangerously-bypass-approvals-and-sandbox [-m model] -
//   resume: codex exec resume [opts] <session_id> -
export class CodexExecutor implements AgentExecutor {
  readonly type = "codex" as const;
  readonly label: string;
  private target: ExecTarget;
  private bin: string;
  private model?: string;
  private extraArgs: string[];
  private reasoningEffort?: string;
  private speed?: "fast";
  constructor(opts: { model?: string; extraArgs?: string[]; reasoningEffort?: string; speed?: "fast"; bin?: string; target?: ExecTarget; name?: string } = {}) {
    this.model = opts.model;
    this.extraArgs = opts.extraArgs ?? [];
    this.reasoningEffort = opts.reasoningEffort;
    this.speed = opts.speed;
    this.bin = opts.bin ?? "codex";
    this.target = opts.target ?? { kind: "local" };
    const where = this.target.kind === "ssh" ? this.target.host : "local";
    this.label = opts.name ?? `codex@${where}${opts.model ? "·" + opts.model : ""}`;
  }

  resumeCommand(cwd: string, sessionId: string): string {
    // Human-friendly copy command: interactive resume (shows the session + lets
    // you continue). The harness's own headless resume uses `exec resume` in run().
    return resumeFor(this.target, cwd, resumeInner.codex(sessionId));
  }

  run(opts: RunOpts): RunHandle {
    const model = opts.model ?? this.model;
    const common = ["--json", "--skip-git-repo-check", "-C", opts.cwd, "--dangerously-bypass-approvals-and-sandbox"];
    if (model) common.push("-m", model);
    // 结构化档位(-c 值按 TOML 解析,须带引号成字符串)。放在 extraArgs 之前,
    // 同 key 时用户参数在后覆盖。
    if (this.reasoningEffort) common.push("-c", `model_reasoning_effort="${this.reasoningEffort}"`);
    if (this.speed === "fast") common.push("-c", 'service_tier="priority"');
    // 注册表配置的固定参数在前,单次调用的 opts.extraArgs 在后(后者可覆盖前者)。
    if (this.extraArgs.length) common.push(...this.extraArgs);
    if (opts.extraArgs?.length) common.push(...opts.extraArgs);
    // `-C`/`--json`/`-m`/sandbox are `codex exec` options; `resume` is a
    // subcommand that takes only its own flags + [SESSION_ID] [PROMPT]. So the
    // exec options must precede `resume`, not follow it (else: "unexpected argument '-C'").
    const args = opts.sessionId
      ? ["exec", ...common, "resume", opts.sessionId, "-"]
      : ["exec", ...common, "-"];

    const commandLine = `${this.bin} ${args.join(" ")} <prompt via stdin>`;
    const child = spawnAgent(this.target, opts.cwd, this.bin, args, opts.prompt);
    const lifecycle = { stopRequested: false };
    return {
      sessionId: opts.sessionId ?? "",
      commandLine,
      events: parseCodexStream(child, opts.trace, lifecycle),
      kill: () => {
        lifecycle.stopRequested = true;
        killChild(child);
      },
    };
  }
}

async function* parseCodexStream(
  child: ReturnType<typeof spawnAgent>,
  tracePaths: RunTracePaths | undefined,
  lifecycle: { stopRequested: boolean },
): AsyncIterable<AgentEvent> {
  const queue: AgentEvent[] = [];
  let resolve: (() => void) | null = null;
  let finished = false;
  let turnCompleted = false;
  let turnFailedMessage: string | null = null;
  let lastEventType: string | null = null;
  let lastEventSummary: string | null = null;
  let agentMessageCount = 0;
  const structuredErrors: string[] = [];
  const trace = new RunTraceRecorder(tracePaths);
  const push = (e: AgentEvent) => {
    queue.push(e);
    resolve?.();
    resolve = null;
  };

  const rl = createInterface({ input: child.stdout! });
  rl.on("line", (line) => {
    const t = line.trim();
    if (!t) return;
    trace.event(line);
    let ev: any;
    try {
      ev = JSON.parse(t);
    } catch {
      lastEventType = "unparseable_stdout";
      lastEventSummary = t.slice(0, 500);
      return;
    }
    lastEventType = codexEventType(ev);
    lastEventSummary = codexEventSummary(ev);
    if (ev.type === "thread.started" && ev.thread_id) {
      push({ kind: "session", cliSessionId: ev.thread_id });
    } else if (ev.type === "turn.completed") {
      turnCompleted = true;
    } else if (ev.type === "turn.failed") {
      turnFailedMessage = eventErrorMessage(ev) ?? "Codex 返回 turn.failed，但没有附带错误说明。";
      structuredErrors.push(turnFailedMessage);
      push({ kind: "error", message: turnFailedMessage });
    } else if (ev.type === "item.completed" && ev.item) {
      const it = ev.item;
      // codex emits one complete agent_message / reasoning per turn (not token
      // deltas). The orchestrator no longer appends newlines — text pieces are
      // concatenated verbatim downstream — so carry the paragraph break here.
      if (it.type === "agent_message" && it.text) {
        agentMessageCount += 1;
        push({ kind: "text", text: it.text + "\n\n" });
      }
      else if (it.type === "reasoning" && it.text) push({ kind: "thinking", text: it.text + "\n\n" });
      else if (it.type === "command_execution") push({ kind: "tool", name: "exec", detail: shortStr(it.command) });
      else if (it.type === "file_change" || it.type === "patch") push({ kind: "tool", name: "edit", detail: shortStr(it.path ?? it.summary) });
    } else if (ev.type === "error") {
      const message = eventErrorMessage(ev) ?? "Codex 返回 error 事件，但没有附带错误说明。";
      structuredErrors.push(message);
      push({ kind: "error", message });
    }
  });

  child.stderr?.on("data", (d) => trace.stderr(d.toString()));
  const finish = (opts: {
    exitStatus: number;
    exitSignal: NodeJS.Signals | null;
    spawnError?: string | null;
    forceFinished?: boolean;
  }) => {
    if (finished) return;
    finished = true;
    const diagnostics = trace.finish({
      ...opts,
      stopRequested: lifecycle.stopRequested,
      turnCompleted,
      turnFailedMessage,
      structuredErrors,
      lastEventType,
      lastEventSummary,
      agentMessageCount,
    });
    const failure = formatFailureForTimeline(diagnostics);
    if (failure && !lifecycle.stopRequested) push({ kind: "error", message: failure });
    push({ kind: "done", exitStatus: opts.exitStatus });
    resolve?.();
    resolve = null;
  };
  child.on("error", (err: NodeJS.ErrnoException) => {
    finish({ exitStatus: 1, exitSignal: null, spawnError: spawnErrorMessage("codex", err) });
  });
  child.on("close", (code, signal) => {
    finish({ exitStatus: code ?? (signal ? 1 : 0), exitSignal: signal });
  });
  forceFinishOnExit(child, () => finished, (exit) => {
    finish({ exitStatus: exit, exitSignal: child.signalCode, forceFinished: true });
  });

  while (true) {
    if (queue.length) {
      yield queue.shift()!;
      continue;
    }
    if (finished) return;
    await new Promise<void>((r) => (resolve = r));
  }
}

const eventErrorMessage = (ev: any): string | null => {
  const value = ev?.message ?? ev?.error?.message ?? ev?.error ?? ev?.detail;
  if (value === undefined || value === null) return null;
  return shortStr(value).slice(0, 2000);
};

const codexEventType = (ev: any): string => {
  const base = typeof ev?.type === "string" ? ev.type : "unknown";
  const item = typeof ev?.item?.type === "string" ? ev.item.type : null;
  return item ? `${base}:${item}` : base;
};

const codexEventSummary = (ev: any): string => {
  const it = ev?.item;
  if (it?.type === "command_execution") return shortStr(it.command).slice(0, 500);
  if (it?.type === "mcp_tool_call") return shortStr({ server: it.server, tool: it.tool, status: it.status }).slice(0, 500);
  if (it?.type === "agent_message") return shortStr(it.text).slice(0, 500);
  return shortStr(eventErrorMessage(ev) ?? codexEventType(ev)).slice(0, 500);
};

const shortStr = (v: unknown) => {
  const s = typeof v === "string" ? v : JSON.stringify(v ?? "");
  return s.length > 1500 ? s.slice(0, 1497) + "…" : s;
};
