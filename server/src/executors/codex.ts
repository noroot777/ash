import type { ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { AgentEvent, ExecTarget, TokenUsage } from "@harness/shared";
import { cliConfigOverrideEnvPatch } from "@harness/shared/cli-overrides";
import { cliHostEnv, resumeEnvHint } from "./cli-env.js";
import type { AgentExecutor, RelayConfig, ResidentHandle, RunHandle, RunOpts } from "./types.js";
import { openCodexResident } from "./codex-resident.js";
import { readCodexContext } from "./codex-rollout.js";
import { spawnForRun, detachedInfo } from "./detached.js";
import { spawnAgent, resumeFor, resumeInner, spawnErrorMessage, killChild, forceFinishOnExit, redactSecrets } from "./spawn.js";
import { relayApi } from "../llm.js";
import { protocolConverterBaseUrl } from "../openai-converter/common.js";
import { formatFailureForTimeline, RunTraceRecorder, type RunTracePaths } from "./diagnostics.js";
import { persistMarkdownImages, persistToolResultImages } from "../agent-attachments.js";

// 供应商的 key 走环境变量,不进命令行 —— `-c` 参数会原样进 commandLine,而后者存进
// sessions.command_line 并在 UI 展示。codex 的 model_providers 正好支持 env_key
// 指向一个环境变量名,于是 TOML 里只出现变量名,真 key 只活在进程环境里。
const RELAY_ENV_KEY = "HARNESS_RELAY_KEY";
const RELAY_PROVIDER_ID = "harness_relay";

// Drives the real `codex` CLI in non-interactive JSON mode (prompt via stdin, `-`).
//   first:  codex exec --json --skip-git-repo-check -C <cwd>
//             --dangerously-bypass-approvals-and-sandbox [-m model] -
//   resume: codex exec resume [opts] <session_id> -
export class CodexExecutor implements AgentExecutor {
  readonly type = "codex" as const;
  readonly label: string;
  // 恢复命令要带的 env 前缀:覆盖项 + 供应商(token 已换成占位符)。存进 sessions。
  readonly resumeEnvHint?: string;
  readonly target: ExecTarget;
  private bin: string;
  readonly model?: string;
  private extraArgs: string[];
  readonly reasoningEffort?: string;
  private speed?: "fast";
  private relay?: RelayConfig;
  private configOverrides?: Record<string, number>;
  constructor(opts: { model?: string; extraArgs?: string[]; reasoningEffort?: string; speed?: "fast"; bin?: string; target?: ExecTarget; name?: string; relay?: RelayConfig; configOverrides?: Record<string, number> } = {}) {
    this.model = opts.model;
    this.extraArgs = opts.extraArgs ?? [];
    this.reasoningEffort = opts.reasoningEffort;
    this.speed = opts.speed;
    this.bin = opts.bin ?? "codex";
    this.target = opts.target ?? { kind: "local" };
    this.relay = opts.relay;
    this.configOverrides = opts.configOverrides;
    this.resumeEnvHint = resumeEnvHint(
      this.type,
      this.configOverrides,
      this.relay ? `${RELAY_ENV_KEY}=<你的key> ` : undefined,
      this.target,
    );
    const where = this.target.kind === "ssh" ? this.target.host : "local";
    this.label = opts.name ?? `codex@${where}${opts.model ? "·" + opts.model : ""}`;
  }

  resumeCommand(cwd: string, sessionId: string): string {
    // Human-friendly copy command: interactive resume (shows the session + lets
    // you continue). The harness's own headless resume uses `exec resume` in run().
    return resumeFor(this.target, cwd, resumeInner.codex(sessionId), this.resumeEnvHint ?? "");
  }

  // 挂了供应商就临时注册一个 provider 并切过去(-c 值按 TOML 解析,字符串须带引号)。
  // base_url 要带版本段,交给 relayApi 归一(库里存的可能是根地址、也可能历史数据自带
  // /v1,硬拼会拼出 /v1/v1);key 只通过 env_key 间接引用,不出现在命令行。
  private relayArgs(): string[] {
    if (!this.relay) return [];
    const p = `model_providers.${RELAY_PROVIDER_ID}`;
    const baseUrl = this.relay.protocolConversionEnabled
      ? relayApi(protocolConverterBaseUrl(this.relay.providerId))
      : relayApi(this.relay.baseUrl);
    return [
      "-c", `model_provider="${RELAY_PROVIDER_ID}"`,
      "-c", `${p}.name="${this.relay.name.replace(/"/g, "")}"`,
      "-c", `${p}.base_url="${baseUrl}"`,
      // codex 0.14x 起废弃了 wire_api="chat"(启动直接报错退出),只认 Responses API。
      // 供应商只有 /chat/completions 时，protocolConversionEnabled 会把 base_url 指到
      // harness 内置转换端点，再由它转换请求、流式事件与最终响应。
      "-c", `${p}.wire_api="responses"`,
      "-c", `${p}.env_key="${RELAY_ENV_KEY}"`,
    ];
  }

  // 供应商的 key + 盖过 CLI 自己配置文件的那几项(声明见 shared/src/cli-overrides.ts;
  // codex 目前一项都没声明,这里接住是为了「声明表加一项就生效」这句话是真的)。
  // `undefined` 值 = 从子进程环境里删掉那个变量(见 cliConfigOverrideEnvPatch)。
  private env(): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = cliConfigOverrideEnvPatch(this.type, this.configOverrides, cliHostEnv(this.target));
    if (this.relay) env[RELAY_ENV_KEY] = this.relay.apiKey;
    return env;
  }

  // 一次性 run 与常驻回合共用的参数装配。`-C`/`--json`/`-m`/sandbox 是
  // `codex exec` 的选项;`resume` 是子命令,只吃自己的 flag + [SESSION_ID]
  // [PROMPT] —— 所以 exec 选项必须排在 `resume` **前面**(否则 "unexpected
  // argument '-C'")。
  private execArgs(opts: { cwd: string; model?: string; extraArgs?: string[] }, sessionId: string): string[] {
    const model = opts.model ?? this.model;
    const common = ["--json", "--skip-git-repo-check", "-C", opts.cwd, "--dangerously-bypass-approvals-and-sandbox"];
    if (model) common.push("-m", model);
    // 结构化档位(-c 值按 TOML 解析,须带引号成字符串)。放在 extraArgs 之前,
    // 同 key 时用户参数在后覆盖。
    if (this.reasoningEffort) common.push("-c", `model_reasoning_effort="${this.reasoningEffort}"`);
    if (this.speed === "fast") common.push("-c", 'service_tier="priority"');
    common.push(...this.relayArgs());
    // 注册表配置的固定参数在前,单次调用的 opts.extraArgs 在后(后者可覆盖前者)。
    if (this.extraArgs.length) common.push(...this.extraArgs);
    if (opts.extraArgs?.length) common.push(...opts.extraArgs);
    return sessionId ? ["exec", ...common, "resume", sessionId, "-"] : ["exec", ...common, "-"];
  }

  run(opts: RunOpts): RunHandle {
    const contextNotBeforeMs = Date.now();
    const args = this.execArgs(opts, opts.sessionId ?? "");
    const commandLine = redactSecrets(`${this.bin} ${args.join(" ")} <prompt via stdin>`);
    const child = spawnForRun(this.target, opts.cwd, this.bin, args, opts.prompt, this.env(), opts.detach);
    const lifecycle = { stopRequested: false };
    return {
      sessionId: opts.sessionId ?? "",
      commandLine,
      events: parseCodexStream(child, opts.trace, lifecycle, {
        initialThreadId: opts.sessionId ?? "",
        contextNotBeforeMs,
      }),
      kill: () => {
        lifecycle.stopRequested = true;
        killChild(child);
      },
      detached: detachedInfo(child),
    };
  }

  attach(child: ChildProcess, opts: { sessionId: string; commandLine: string }): RunHandle {
    const lifecycle = { stopRequested: false };
    return {
      sessionId: opts.sessionId,
      commandLine: opts.commandLine,
      // 接管的是上一轮留下的进程，trace 那份诊断在它自己那一轮已经写过了。
      // 重启接管拿不到原回合起点；从接管时刻算下界，宁可少一轮水位也不复用旧值。
      events: parseCodexStream(child, undefined, lifecycle, {
        initialThreadId: opts.sessionId,
        contextNotBeforeMs: Date.now(),
      }),
      kill: () => {
        lifecycle.stopRequested = true;
        child.kill();
      },
      detached: detachedInfo(child),
    };
  }

  // 常驻会话(§Team 的调度台)。codex 没有 claude 那种 stdin 注入通道,所以这里
  // 是**会话级常驻**:每个回合起一个 `codex exec resume <thread_id>` 进程,会话
  // 在 codex 自己的 thread 里连着。取舍、实测结论与两处可见差异写在
  // executors/codex-resident.ts 头部。
  openResident(opts: RunOpts): ResidentHandle {
    return openCodexResident({
      initialSessionId: opts.sessionId ?? "",
      initialPrompt: opts.prompt,
      startTurn: (prompt, sessionId) => {
        const contextNotBeforeMs = Date.now();
        const args = this.execArgs(opts, sessionId);
        const lifecycle = { stopRequested: false };
        // 常驻的每一轮都是**新进程**,所以 stdin 照旧读完即关(keepStdin 是
        // claude 那种「一个进程吃多个回合」才需要的)。
        const child = spawnAgent(this.target, opts.cwd, this.bin, args, prompt, this.env());
        return {
          child,
          commandLine: redactSecrets(`${this.bin} ${args.join(" ")} <prompt via stdin>`),
          lifecycle,
          events: parseCodexStream(child, undefined, lifecycle, {
            initialThreadId: sessionId,
            contextNotBeforeMs,
          }),
        };
      },
      killTurn: (child) => killChild(child),
    });
  }
}

export async function* parseCodexStream(
  child: ReturnType<typeof spawnAgent>,
  tracePaths: RunTracePaths | undefined,
  lifecycle: { stopRequested: boolean },
  contextOptions: { initialThreadId: string; contextNotBeforeMs: number },
): AsyncIterable<AgentEvent> {
  const queue: AgentEvent[] = [];
  let resolve: (() => void) | null = null;
  let finished = false;
  let turnCompleted = false;
  let turnFailedMessage: string | null = null;
  let lastEventType: string | null = null;
  let lastEventSummary: string | null = null;
  let agentMessageCount = 0;
  let threadId = contextOptions.initialThreadId;
  const seenImages = new Set<string>();
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
      threadId = ev.thread_id;
      push({ kind: "session", cliSessionId: ev.thread_id });
    } else if (ev.type === "turn.completed") {
      turnCompleted = true;
      const usage = codexUsage(ev.usage);
      if (usage) push({ kind: "usage", usage });
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
        for (const path of persistMarkdownImages(it.text, seenImages)) push({ kind: "attachment", path });
      }
      else if (it.type === "reasoning" && it.text) push({ kind: "thinking", text: it.text + "\n\n" });
      else if (it.type === "command_execution") push({ kind: "tool", name: "exec", detail: shortStr(it.command) });
      else if (it.type === "file_change" || it.type === "patch") push({ kind: "tool", name: "edit", detail: shortStr(it.path ?? it.summary) });
      else if (it.type === "mcp_tool_call") {
        for (const path of persistToolResultImages(it.result, seenImages)) push({ kind: "attachment", path });
      }
      else if (it.type === "image_generation_call") {
        for (const path of persistToolResultImages(it.result, seenImages, { allowBareBase64: true })) push({ kind: "attachment", path });
      }
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

  // stdout 没有水位；在 done 前 best-effort 读取本回合 rollout。私有格式变化时读取器
  // 返回 null，界面自然不显示，任务结算仍照常进行。
  let contextDone = false;
  while (true) {
    if (queue.length) {
      const next = queue.shift()!;
      if (next.kind === "done" && !contextDone) {
        contextDone = true;
        const context = await readCodexContext(threadId, contextOptions.contextNotBeforeMs);
        // used=0 的哨兵也必须发：它会清掉 sessions 行上的上一轮旧水位。否则私有格式
        // 变化后读取器虽已失败关闭，界面却仍拿数据库里的陈旧数字冒充当前值。
        yield {
          kind: "context",
          context: context ?? { used: 0, window: null, windowEstimated: false },
        };
      }
      yield next;
      continue;
    }
    if (finished) return;
    await new Promise<void>((r) => (resolve = r));
  }
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

// `turn.completed` 在 resume 后报的是**整条 Codex 线程累计账**，不是本轮增量：
//   {"usage":{"input_tokens":N,"cached_input_tokens":N,"output_tokens":N,"reasoning_output_tokens":N}}
// 这里只做供应商字段归一；server/usage.ts 按 cli_session_id 跟上一份累计快照求差，
// 才得到真正的本轮账。另一个口径差异是 input_tokens 已含缓存命中，必须先减出来。
// codex 不报价 → costUsd 恒 null(不是 0)。
export function codexUsage(u: any): TokenUsage | null {
  if (!u || typeof u !== "object") return null;
  const cacheRead = num(u.cached_input_tokens);
  return {
    input: Math.max(0, num(u.input_tokens) - cacheRead),
    output: num(u.output_tokens),
    cacheRead,
    cacheWrite: 0, // codex 不区分缓存写入
    reasoning: num(u.reasoning_output_tokens),
    costUsd: null,
    turns: 1,
  };
}

const eventErrorMessage = (ev: any): string | null => {  const value = ev?.message ?? ev?.error?.message ?? ev?.error ?? ev?.detail;
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
