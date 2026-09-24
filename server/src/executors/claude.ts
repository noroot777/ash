import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@ash/shared";
import { cliConfigOverrideEnvPatch, cliConfigOverrideSettings } from "@ash/shared/cli-overrides";
import { cliHostEnv } from "./cli-env.js";
import type { AgentExecutor, RelayConfig, ResidentHandle, ResumeFields, RunHandle, RunOpts } from "./types.js";
import { spawnControllableForRun, spawnForRun, detachedInfo } from "./detached.js";
import { cleanupAfterRun, spawnAgent, resumeFor, resumeInner, shq, killChild, redactSecrets, failedChild } from "./spawn.js";
import { relayRoot } from "../llm.js";
import { anthropicContext1mBaseUrl, modelUsesContext1m, withContext1mSuffix } from "../anthropic-context-1m.js";
import { ClaudeControlBridge } from "./claude-control.js";
import { parseClaudeStream } from "./claude-stream.js";
export { parseClaudeStream } from "./claude-stream.js";
export { claudeEffortUnsupportedMessage, claudeRootBypassMessage, normalizeClaudeCliError, claudeContextUsed, claudeContextWindow, claudeUsage } from "./claude-metadata.js";

type RuntimeSettings = { arg: string | null; cleanup: () => void; error?: string };
const RUNTIME_SETTINGS_RE = /^ash-claude-settings-(\d+)-[0-9a-f-]+\.json$/i;

function removeRuntimeSettings(path: string): void {
  try { rmSync(path, { force: true }); } catch { /* 退出/重启清理只做 best effort */ }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function cleanupStaleRuntimeSettings(): void {
  let names: string[];
  try { names = readdirSync(tmpdir()); } catch { return; }
  for (const name of names) {
    const match = name.match(RUNTIME_SETTINGS_RE);
    if (!match) continue;
    const pid = Number(match[1]);
    if (pid > 0 && processExists(pid)) continue;
    removeRuntimeSettings(join(tmpdir(), name));
  }
}

function runtimeSettingsCleanupFromCommandLine(commandLine: string): () => void {
  const match = commandLine.match(/--settings (.*?ash-claude-settings-\d+-[0-9a-f-]+\.json)(?:\s|$)/i);
  const path = match?.[1];
  return path ? () => removeRuntimeSettings(path) : () => {};
}

function cleanupWithEvents(events: AsyncIterable<AgentEvent>, cleanup: () => void): AsyncIterable<AgentEvent> {
  return (async function* () {
    try {
      for await (const event of events) yield event;
    } finally {
      cleanup();
    }
  })();
}

cleanupStaleRuntimeSettings();

// Drives the real `claude` CLI in headless stream-json mode.
export class ClaudeExecutor implements AgentExecutor {
  readonly type = "claude" as const;
  readonly label: string;
  private bin: string;
  private startupError?: string;
  readonly model?: string;
  private extraArgs: string[];
  readonly reasoningEffort?: string;
  private speed?: "fast";
  private relay?: RelayConfig;
  private configOverrides?: Record<string, number>;
  constructor(opts: { model?: string; extraArgs?: string[]; reasoningEffort?: string; speed?: "fast"; bin?: string; startupError?: string; name?: string; relay?: RelayConfig; configOverrides?: Record<string, number> } = {}) {
    this.model = opts.model;
    this.extraArgs = opts.extraArgs ?? [];
    this.reasoningEffort = opts.reasoningEffort;
    this.speed = opts.speed;
    this.bin = opts.bin ?? "claude";
    this.startupError = opts.startupError;
    this.relay = opts.relay;
    this.configOverrides = opts.configOverrides;
    this.label = opts.name ?? `claude@local${opts.model ? "·" + opts.model : ""}`;
  }

  resumeCommand(cwd: string, sessionId: string): string {
    return this.resumeFields(cwd, sessionId).resumeCommand;
  }

  /** 恢复参数按会话 cwd 现算；构造时提前冻结会漏掉项目 settings。 */
  resumeFields(cwd: string, sessionId: string): ResumeFields {
    const settings = this.settingsPayload(cwd, this.model, this.relay ? "<你的key>" : undefined);
    const resumeArgs = settings ? `--settings ${shq(JSON.stringify(settings))}` : null;
    const inner = resumeInner.claude(sessionId);
    return {
      resumeCommand: resumeFor(
        cwd,
        resumeArgs ? `${inner} ${resumeArgs}` : inner,
        "",
      ),
      resumeEnv: null,
      resumeArgs,
    };
  }

  private relayBaseUrl(model?: string): string | undefined {
    if (!this.relay) return undefined;
    return modelUsesContext1m(model, this.relay.context1mModels)
      ? anthropicContext1mBaseUrl(this.relay.providerId)
      : relayRoot(this.relay.baseUrl);
  }

  /** fastMode、覆盖项、供应商路由与恢复参数共用一份 --settings；多份参数不合并。 */
  private settingsPayload(cwd: string, model?: string, relayAuthToken?: string): Record<string, unknown> | null {
    const settings = {
      ...(this.speed === "fast" ? { fastMode: true } : {}),
      ...cliConfigOverrideSettings(this.type, this.configOverrides, cliHostEnv(cwd)),
    } as Record<string, unknown>;
    const relayBaseUrl = this.relayBaseUrl(model);
    if (relayBaseUrl) {
      const existingEnv = settings.env && typeof settings.env === "object"
        ? settings.env as Record<string, unknown>
        : {};
      settings.env = {
        ...existingEnv,
        ANTHROPIC_BASE_URL: relayBaseUrl,
        // 真密钥只在运行期写入 0600 临时 settings 文件；恢复命令保存的是占位符。
        // 三种凭证变量都在最高优先级钉住，用户/项目 settings 无法再反向覆盖。
        ANTHROPIC_AUTH_TOKEN: relayAuthToken ?? "",
        ANTHROPIC_API_KEY: "",
        CLAUDE_CODE_OAUTH_TOKEN: "",
      };
    }
    return Object.keys(settings).length ? settings : null;
  }

  // 挂了供应商就顶掉 CLI 自己的登录态:BASE_URL 与三种凭证变量由最高优先级的
  // --settings 锁定。运行期 settings 走 0600 临时文件，commandLine 只保存路径；Claude
  // 发出 init(说明配置已读完)就删除，退出再兜底。这样用户层仍完整加载，密钥也不进 argv。
  //
  // configOverrides 落成的那几个变量在这里只是**第二道**:claude 启动时会把各层
  // settings 的 `env` 写回自己的进程环境,用户 `~/.claude/settings.json` 里的同名
  // 变量会反过来盖掉这里注进去的值(第 1 轮审查 finding 1)。真正赢下这一局的是
  // buildArgs 里那个 `--settings` —— 它是优先级最高的一档。留着这一道是因为「没配的
  // 项要从子进程里删掉」只有环境变量这一层做得到(用户 shell / launchd 里 export 过的
  // 同名变量,不删就等于每个 profile 都被那份全局值悄悄盖住),而且 CLI 将来若改成只认
  // env 也还兜得住。两道给的是同一份值,不会打架。哪一项盖掉了谁,声明在
  // shared/src/cli-overrides.ts,并原样显示在执行器设置里。
  // 返回值里允许出现 `undefined`:那是「把这个变量从子进程里删掉」,不是「没配」
  // (见 cliConfigOverrideEnvPatch)。所以这里不能再按 key 数量决定返不返回。
  private env(cwd?: string, model?: string): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = cliConfigOverrideEnvPatch(this.type, this.configOverrides, cliHostEnv(cwd));
    if (this.relay) {
      env.ANTHROPIC_BASE_URL = this.relayBaseUrl(model);
      env.ANTHROPIC_AUTH_TOKEN = this.relay.apiKey;
      env.ANTHROPIC_API_KEY = undefined;
      env.CLAUDE_CODE_OAUTH_TOKEN = undefined;
    }
    return env;
  }

  private runtimeSettings(cwd: string, model?: string): RuntimeSettings {
    const settings = this.settingsPayload(cwd, model, this.relay?.apiKey);
    if (!settings) return { arg: null, cleanup: () => {} };
    if (!this.relay) return { arg: JSON.stringify(settings), cleanup: () => {} };
    const path = join(tmpdir(), `ash-claude-settings-${process.pid}-${randomUUID()}.json`);
    try {
      writeFileSync(path, JSON.stringify(settings), { encoding: "utf8", mode: 0o600, flag: "wx" });
      return { arg: path, cleanup: () => removeRuntimeSettings(path) };
    } catch (error) {
      return {
        arg: null,
        cleanup: () => {},
        error: `无法创建 Claude 临时配置：${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  private compactWindow(): number | null {
    const value = this.configOverrides?.autoCompactWindow;
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : null;
  }

  run(opts: RunOpts): RunHandle {
    const sessionId = opts.sessionId ?? randomUUID();
    const model = opts.model ?? this.model;
    const settings = this.startupError
      ? { arg: null, cleanup: () => {} }
      : this.runtimeSettings(opts.cwd, model);
    const args = this.buildArgs(opts, sessionId, false, model, settings.arg);
    const commandLine = redactSecrets(`${this.bin} ${args.join(" ")} <prompt via stdin>`);
    const child = this.startupError || settings.error
      ? failedChild(this.startupError ?? settings.error!)
      : spawnForRun(opts.cwd, this.bin, args, opts.prompt, { ...this.env(opts.cwd, model), ...opts.env }, opts.detach);
    child.on("close", settings.cleanup);
    return {
      sessionId,
      commandLine,
      events: cleanupWithEvents(
        parseClaudeStream(child, undefined, this.bin, this.type, this.compactWindow(), settings.cleanup),
        settings.cleanup,
      ),
      kill: () => killChild(child),
      cleanup: async () => { settings.cleanup(); await cleanupAfterRun(child); },
      detached: detachedInfo(child),
    };
  }

  // 单飞只把进程保留到当前任务回合结束：引导时 interrupt + send；最终 result 收台。
  runSteerable(opts: RunOpts): RunHandle {
    const sessionId = opts.sessionId ?? randomUUID();
    const model = opts.model ?? this.model;
    const settings = this.startupError
      ? { arg: null, cleanup: () => {} }
      : this.runtimeSettings(opts.cwd, model);
    const args = this.buildArgs(opts, sessionId, true, model, settings.arg);
    const commandLine = redactSecrets(`${this.bin} ${args.join(" ")} <messages via stdin>`);
    const child = this.startupError || settings.error
      ? failedChild(this.startupError ?? settings.error!)
      : spawnControllableForRun(
          opts.cwd,
          this.bin,
          args,
          userLine(opts.prompt),
          { ...this.env(opts.cwd, model), ...opts.env },
          opts.detach,
        );
    child.on("close", settings.cleanup);
    const detached = detachedInfo(child);
    return singleRunFromResident(
      this.residentFromChild(child, sessionId, commandLine, settings.cleanup),
      detached,
    );
  }

  attach(child: ChildProcess, opts: { sessionId: string; commandLine: string }): RunHandle {
    const detached = detachedInfo(child);
    const settingsCleanup = runtimeSettingsCleanupFromCommandLine(opts.commandLine);
    child.on("close", settingsCleanup);
    if (child.stdin && opts.commandLine.includes("--input-format")) {
      return singleRunFromResident(
        this.residentFromChild(child, opts.sessionId, opts.commandLine, settingsCleanup),
        detached,
      );
    }
    return {
      sessionId: opts.sessionId,
      commandLine: opts.commandLine,
      events: cleanupWithEvents(
        parseClaudeStream(child, undefined, this.bin, this.type, this.compactWindow(), settingsCleanup),
        settingsCleanup,
      ),
      kill: () => child.kill(),
      cleanup: async () => { settingsCleanup(); await cleanupAfterRun(child); },
      detached: detachedInfo(child),
    };
  }

  // 常驻会话(§Team 的调度台):一个进程吃多个回合,session_id 全程不变。跟 run()
  // 的差别只有两处 —— `--input-format stream-json`(首条消息和后续插话都是一行
  // JSON)和不关 stdin。实测事实与坑写在 server/src/team/session.ts 头部注释。
  openResident(opts: RunOpts): ResidentHandle {
    const sessionId = opts.sessionId ?? randomUUID();
    const model = opts.model ?? this.model;
    const settings = this.startupError
      ? { arg: null, cleanup: () => {} }
      : this.runtimeSettings(opts.cwd, model);
    const args = this.buildArgs(opts, sessionId, true, model, settings.arg);
    const commandLine = redactSecrets(`${this.bin} ${args.join(" ")} <messages via stdin>`);
    const child = this.startupError || settings.error
      ? failedChild(this.startupError ?? settings.error!)
      : spawnAgent(opts.cwd, this.bin, args, userLine(opts.prompt), { ...this.env(opts.cwd, model), ...opts.env }, {
          keepStdin: true,
        });
    child.on("close", settings.cleanup);
    return this.residentFromChild(child, sessionId, commandLine, settings.cleanup);
  }

  private residentFromChild(
    child: ChildProcess,
    sessionId: string,
    commandLine: string,
    settingsCleanup: () => void = () => {},
  ): ResidentHandle {
    const resident = new ClaudeControlBridge();
    const writeChecked = (data: string): Promise<void> => new Promise((resolve, reject) => {
      const input = child.stdin;
      if (!input || input.destroyed || input.writableEnded || !input.writable) {
        reject(new Error("Claude 当前回合 stdin 已关闭"));
        return;
      }
      input.write(data, (error) => error ? reject(error) : resolve());
    });
    return {
      sessionId,
      commandLine,
      events: cleanupWithEvents(
        parseClaudeStream(child, resident, this.bin, this.type, this.compactWindow(), settingsCleanup),
        settingsCleanup,
      ),
      send: (text: string) => {
        // stdin 没了/已经关掉 = 这条消息一个字都进不去,如实说不(见 ResidentHandle.send)。
        const stdin = child.stdin;
        if (!stdin || stdin.destroyed || stdin.writableEnded) return false;
        stdin.write(userLine(text));
        return true;
      },
      interrupt: () => {
        resident.interruptPending = true;
        child.stdin?.write(resident.request().line);
      },
      steer: async (text: string, onInterrupted, beforeSend) => {
        resident.interruptPending = true;
        const request = resident.request();
        const ack = resident.waitFor(request.requestId);
        let interruptWritten = false;
        try {
          await writeChecked(request.line);
          interruptWritten = true;
          onInterrupted?.();
          await ack.promise;
          await beforeSend?.();
          await writeChecked(userLine(text));
        } catch (error) {
          ack.cancel();
          // interrupt 尚未写出时才撤销；一旦写出，CLI 会产生一个 turnEnd，消费层必须
          // 保留对应计数，即使紧接着的新 user 消息写失败。
          if (!interruptWritten) resident.interruptPending = false;
          throw error;
        }
      },
      close: () => {
        child.stdin?.end();
      },
      kill: () => killChild(child),
      cleanup: async () => { settingsCleanup(); await cleanupAfterRun(child); },
    };
  }

  // 两种形态共用的参数装配。resident 只多一个 --input-format。
  private buildArgs(opts: RunOpts, sessionId: string, resident: boolean, selectedModel = opts.model ?? this.model, settingsArg: string | null = null): string[] {
    const model = this.relay
      ? withContext1mSuffix(selectedModel, this.relay.context1mModels)
      : selectedModel;
    // --include-partial-messages turns on token-level streaming: the CLI emits
    // `stream_event` lines (content_block_delta) AS the model types, instead of
    // only one complete `assistant` message per turn. Without it the mobile/web
    // client sees nothing until a whole message lands, then the entire block
    // appears at once — the "laggy, dumps-in-one-go" feel. See parseClaudeStream.
    const args = ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--dangerously-skip-permissions"];
    // stdin 从「一次性 prompt」变成「一行行 JSON 消息」(CLI help 原文:realtime
    // streaming input),于是同一进程能连吃多个回合。
    if (resident) args.push("--input-format", "stream-json");
    if (opts.sessionId) args.push("--resume", sessionId);
    else args.push("--session-id", sessionId);
    if (model) args.push("--model", model);
    if (this.reasoningEffort) args.push("--effort", this.reasoningEffort);
    // `--settings` 是 claude 优先级最高的一档配置(之上只剩企业策略文件),1.5x 加速档
    // 和「覆盖 CLI 自己的配置」都从这里进;装配在 settingsPayload() 里,恢复命令共用同
    // 一份。放在 extraArgs 之前:用户自带 --settings 时以他那份为准(设置页会警告本覆盖
    // 被顶掉)。
    if (settingsArg) args.push("--settings", settingsArg);
    // 注册表配置的固定参数在前,单次调用的 opts.extraArgs 在后(后者可覆盖前者)。
    if (this.extraArgs.length) args.push(...this.extraArgs);
    if (opts.extraArgs?.length) args.push(...opts.extraArgs);
    return args;
  }
}

export function singleRunFromResident(
  resident: ResidentHandle,
  detached?: RunHandle["detached"],
): RunHandle {
  let intermediateEnds = 0;
  let accepting = true;
  const events = (async function* (): AsyncIterable<AgentEvent> {
    for await (const event of resident.events) {
      if (event.kind === "turnEnd") {
        if (intermediateEnds > 0) {
          intermediateEnds -= 1;
          continue;
        }
        accepting = false;
        resident.close();
        yield { kind: "done", exitStatus: 0 };
        return;
      }
      if (event.kind === "done") accepting = false;
      yield event;
      if (event.kind === "done") return;
    }
  })();
  return {
    sessionId: resident.sessionId,
    commandLine: resident.commandLine,
    events,
    detached,
    async steer(text: string, beforeSend) {
      if (!accepting) throw new Error("Claude 当前回合已经结束");
      intermediateEnds += 1;
      let interrupted = false;
      try {
        if (resident.steer) await resident.steer(text, () => { interrupted = true; }, beforeSend);
        else {
          resident.interrupt();
          interrupted = true;
          resident.send(text);
        }
      } catch (error) {
        if (!interrupted) intermediateEnds = Math.max(0, intermediateEnds - 1);
        else {
          accepting = false;
          resident.kill();
          throw Object.assign(error instanceof Error ? error : new Error(String(error)), { nativeSteerRestart: true });
        }
        throw error;
      }
    },
    kill() {
      accepting = false;
      resident.kill();
    },
    cleanup: resident.cleanup,
  };
}

// stream-json 的入站格式:一条 user 消息 = 一行 JSON。
const userLine = (text: string) =>
  JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } }) + "\n";
