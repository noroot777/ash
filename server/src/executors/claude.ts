import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { NativeWorkTrace } from "./native-work.js";
import { childActivity } from "./native-agent-activity.js";
import { NativeActivityBuffer } from "./native-activity-buffer.js";
import type { AgentEvent, AgentType } from "@ash/shared";
import { guessContextWindow } from "@ash/shared/usage";
import { cliConfigOverrideEnvPatch, cliConfigOverrideSettings } from "@ash/shared/cli-overrides";
import { cliHostEnv } from "./cli-env.js";
import type { AgentExecutor, RelayConfig, ResidentHandle, ResumeFields, RunHandle, RunOpts } from "./types.js";
import { spawnControllableForRun, spawnForRun, detachedInfo } from "./detached.js";
import { cleanupAfterRun, spawnAgent, resumeFor, resumeInner, shq, spawnErrorMessage, killChild, forceFinishOnExit, redactSecrets, failedChild } from "./spawn.js";
import { relayRoot } from "../llm.js";
import { anthropicContext1mBaseUrl, modelUsesContext1m, withContext1mSuffix } from "../anthropic-context-1m.js";
import { calibrateSkills } from "../skills.js";
import { persistMarkdownImages, persistToolResultImages } from "../agent-attachments.js";
import { ClaudeControlBridge } from "./claude-control.js";
import { normalizeClaudeCliError, shortJson, claudeContextUsed, claudeContextWindow, claudeUsage } from "./claude-metadata.js";
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

// resident 非空 = 常驻模式:`result` 行只代表「一个回合说完了」(→ turnEnd),
// 流要一直开着;只有进程真的没了才 done。
// bin 只影响 spawn 报错文案 —— 导出是为了让目录里「输出格式跟 claude 一致」的
// CLI(stream-json 的 --output-format)直接复用这一份解析,不必各写一遍。
// calibrateAs:只有**确知自己是哪种 CLI 的进程**才传(见下面 init 分支)。
// 复用这份 parser 的第三方 CLI 一律不传 —— 它们的技能名跟 claude 的不是一回事,
// 拿 bin 名去猜会把别人的技能塞进 claude 的缓存。
export async function* parseClaudeStream(
  child: ReturnType<typeof spawnAgent>,
  resident?: ClaudeControlBridge,
  bin = "claude",
  calibrateAs?: AgentType,
  compactWindow: number | null = null,
  onInitialized: () => void = () => {},
): AsyncIterable<AgentEvent> {
  const queue: AgentEvent[] = [];
  let resolve: (() => void) | null = null;
  let finished = false;
  const activityBuffer = new NativeActivityBuffer();
  const push = (e: AgentEvent) => {
    const events = activityBuffer.push(e);
    if (!events.length) return;
    queue.push(...events);
    resolve?.();
    resolve = null;
  };

  // Coalesce token-level text_delta into small chunks: flush on a newline or once
  // ~40 chars have accrued, so the client streams smoothly without a re-render per
  // character (a long reply would otherwise fire thousands of setStates). The
  // chunks concatenate downstream with no separator, so the joined text is exactly
  // the model's output. With partial streaming ON, the complete `assistant`
  // message that trails the deltas is used ONLY for tool_use — replaying its text
  // would duplicate everything the deltas already streamed.
  let textBuf = "";
  const flushText = () => {
    if (textBuf) {
      push({ kind: "text", text: textBuf });
      textBuf = "";
    }
  };

  // 上下文水位。**只有 `assistant` 事件里的 `message.usage` 是单次 API 调用的快照**
  // —— 收尾的 `result` 行是整回合累加(几十次调用相加,长会话能到千万级),拿它当水位
  // 会得出「上下文爆了 50 倍」。所以在这里逐条记下最新一次调用的输入规模,回合结束
  // 时发一条 context 事件。窗口(分母)反过来只有 `result` 行有,见 claudeContextWindow。
  let contextUsed = 0;
  let contextModel: string | null = null;
  const seenImages = new Set<string>();
  const childImages = new Map<string, Set<string>>();
  const nativeWork = new NativeWorkTrace();

  const rl = createInterface({ input: child.stdout! });
  rl.on("line", (line) => {
    const t = line.trim();
    if (!t) return;
    let ev: any;
    try {
      ev = JSON.parse(t);
    } catch {
      return;
    }
    for (const activity of nativeWork.claudeMessage(ev)) push(activity);
    if (ev.parent_tool_use_id) {
      const images = childImages.get(ev.parent_tool_use_id) ?? new Set<string>();
      childImages.set(ev.parent_tool_use_id, images);
      for (const block of Array.isArray(ev.message?.content) ? ev.message.content : []) {
        if (block.type === "tool_result") {
          for (const path of persistToolResultImages(block.content, images)) push(childActivity(ev.parent_tool_use_id, { kind: "attachment", path }));
        } else if (block.type === "text" && typeof block.text === "string") {
          for (const path of persistMarkdownImages(block.text, images)) push(childActivity(ev.parent_tool_use_id, { kind: "attachment", path }));
        }
      }
      return;
    }
    if (ev.type === "control_response") {
      resident?.handleResponse(ev);
      return;
    }
    if (ev.type === "stream_event") {
      const se = ev.event;
      if (se?.type === "content_block_delta" && se.delta?.type === "text_delta" && se.delta.text) {
        textBuf += se.delta.text;
        if (textBuf.length >= 40 || textBuf.includes("\n")) flushText();
      }
      return; // deltas drive the live stream; the trailing complete message handles tools
    }
    if (ev.type === "system" && ev.session_id) {
      if (ev.subtype === "init") onInitialized();
      // init 事件白送一份**权威**技能清单(skills / slash_commands / cwd 都在里面),
      // 顺手校准 skills 模块的扫描结果 —— 这是唯一不用额外起一个 CLI 进程就能拿到
      // 「这个 CLI 自己认哪些技能」的机会,别浪费。纯旁路:失败也不能影响事件流。
      if (calibrateAs && ev.subtype === "init" && typeof ev.cwd === "string") {
        try {
          calibrateSkills(calibrateAs, ev.cwd, ev.skills, ev.slash_commands);
        } catch {
          /* 校准是锦上添花,坏了就还用扫描结果 */
        }
      }
      // 压缩(手动 `/compact` 与自动压缩)的过程和成败**只在这条 status 事件里**。
      // 不接住它的代价是压缩失败**看上去和成功一模一样**:收尾的 `result` 照样是
      // `subtype:"success"` + `is_error:false` + 退出码 0,任务状态不动,时间线上只多
      // 出 CLI 合成的一句英文 —— 而压缩失败恰恰是最要紧的一种失败:上下文原地不动,
      // 下一句话照样撞「Prompt is too long」(2026-08-13 实测:中转网关连着三次 503,
      // 手动 `/compact` 和自动压缩都没压成,用户只能得出「这个系统的 /compact 坏了」)。
      // 所以这里把结论抬成显式事件:失败 → error(执行诊断块 + trace + SSE),开始/成功
      // → 一行正文。三者都只管展示,不碰任务状态(原生命令本来就走旁路回合)。
      if (ev.subtype === "status") {
        if (typeof ev.compact_result === "string") {
          if (ev.compact_result === "failed") {
            const detail = typeof ev.compact_error === "string" && ev.compact_error.trim()
              ? ev.compact_error.trim()
              : "CLI 没有给出原因";
            push({ kind: "error", message: `上下文压缩失败，会话大小原地不动：${detail}` });
          } else {
            push({ kind: "text", text: "\n> 上下文已压缩。\n\n" });
          }
        } else if (ev.status === "compacting") {
          push({ kind: "text", text: "\n> 正在压缩上下文…\n\n" });
        }
      }
      push({ kind: "session", cliSessionId: ev.session_id });
    } else if (ev.type === "assistant" && ev.message?.content) {
      flushText(); // settle this message's text-delta tail before its tools
      // 这一次 API 调用装了多少进模型 = 上下文水位(见上面 contextUsed 的注释)。
      // 合成消息不是真调用,它的 usage 不代表上下文,跳过。
      if (ev.message.model && ev.message.model !== "<synthetic>") {
        contextModel = ev.message.model;
        const snapshot = claudeContextUsed(ev.message.usage);
        if (snapshot > 0) contextUsed = snapshot;
      }
      // CLI 本地合成的消息(model `<synthetic>`:模型不存在 / 鉴权失败 / 限流等)
      // **不经过 delta 流** —— 它是 CLI 自己拼出来的,不是模型吐的。所以这一类的
      // text 必须照收,跳过就等于把唯一一句错误说明扔了(见 docs/incidents.md
      // 「空白回合」:404 model_not_found 整个被吞,用户只看到任务停着不动)。
      const synthetic = ev.message.model === "<synthetic>";
      let hadText = false;
      for (const block of ev.message.content) {
        if (block.type === "text") {
          hadText = true; // 真模型的 text 已经由 deltas 流过 —— 不要再 push 一遍
          if (synthetic && block.text) push({ kind: "text", text: block.text });
        } else if (block.type === "tool_use") push(nativeWork.call(block.name, block.input, block.id)
          ?? { kind: "tool", name: block.name, detail: shortJson(block.input) });
      }
      if (hadText) push({ kind: "text", text: "\n\n" }); // paragraph break, identical live & on reload
      for (const block of ev.message.content) {
        if (block.type !== "text" || typeof block.text !== "string") continue;
        for (const path of persistMarkdownImages(block.text, seenImages)) push({ kind: "attachment", path });
      }
    } else if (ev.type === "user" && Array.isArray(ev.message?.content)) {
      flushText();
      for (const block of ev.message.content) {
        if (block?.type !== "tool_result") continue;
        const activity = nativeWork.result(block.tool_use_id, block.content, block.is_error === true);
        if (activity) push(activity);
        for (const path of persistToolResultImages(block.content, seenImages)) push({ kind: "attachment", path });
      }
    } else if (ev.type === "result") {
      flushText();
      if (ev.session_id) push({ kind: "session", cliSessionId: ev.session_id });
      const usage = claudeUsage(ev);
      if (usage) push({ kind: "usage", usage });
      // 水位跟着流水一起发。模型窗口仍优先用 claude 自报的(1M 只有那儿认得出),
      // 但执行器若显式配了自动压缩窗口就另带 compactWindow：模型能力与“先在哪压缩”
      // 是两层数据，界面拿后者算真正的剩余量，不能为了显示 400k 把 1M 上限抹掉。
      if (contextUsed > 0) {
        const model = contextModel ?? ev.model ?? null;
        const reported = claudeContextWindow(ev, model);
        const window = reported ?? guessContextWindow(model);
        push({
          kind: "context",
          context: {
            used: contextUsed,
            window,
            windowEstimated: reported === null && window !== null,
            ...(compactWindow !== null ? { compactWindow } : {}),
          },
        });
      }
      // 我们自己发的 interrupt 会把本回合收成 error_during_execution —— 那是
      // 「用户插话打断」的预期结果,不是故障,不报错。只吞掉紧跟其后的那一个
      // result(标志立即清掉),所以最坏情况也只影响一个回合的错误上报。
      const ownInterrupt = resident?.interruptPending === true;
      if (resident) resident.interruptPending = false;
      // claude CLI 把 **API 层**的失败(404 模型不存在、401、限流…)报成
      // `subtype:"success"` + `is_error:true` + `api_error_status` —— 只看 subtype
      // 会把它整条判成正常结束。两路判据都要算上,否则回合「成功」但一个字没说。
      const apiError = ev.is_error === true || typeof ev.api_error_status === "number";
      if (((ev.subtype && ev.subtype !== "success") || apiError) && !ownInterrupt) {
        // CLI **自己**失败时(会话找不到、启动期崩)`result` 是空的,原因只在
        // `errors[]` 里。不读它就只剩一句 `result: error_during_execution`——用户看不出
        // 发生了什么,`session-lost.ts` 那条「no conversation found」的识别也永远匹配不上,
        // 一条已经失效的 --resume 会被一路重试到底。
        const errors = Array.isArray(ev.errors)
          ? ev.errors.filter((e: unknown): e is string => typeof e === "string" && e.trim() !== "")
          : [];
        const detail = typeof ev.result === "string" && ev.result.trim()
          ? ev.result.trim()
          : errors.length ? errors.join("; ") : `result: ${ev.subtype}`;
        push({
          kind: "error",
          message: ev.api_error_status ? `HTTP ${ev.api_error_status}: ${detail}` : detail,
        });
      }
      // 常驻:回合说完了,进程还活着等下一条消息 —— 流不结束。
      if (resident) push({ kind: "turnEnd" });
      seenImages.clear();
      childImages.clear();
    }
  });

  let stderr = "";
  child.stderr?.on("data", (d) => (stderr += d.toString()));
  child.on("error", (err: NodeJS.ErrnoException) => {
    if (finished) return;
    resident?.failPending(new Error(`Claude 进程错误：${err.message}`));
    push({ kind: "error", message: spawnErrorMessage(bin, err) });
    push({ kind: "done", exitStatus: 1 });
    finished = true;
    resolve?.();
    resolve = null;
  });
  child.on("close", (code) => {
    if (finished) return;
    resident?.failPending(new Error("Claude 进程在 interrupt ACK 前退出"));
    flushText(); // emit any text tail that never hit the flush threshold
    const exit = code ?? 0;
    if (exit !== 0 && stderr.trim()) push({ kind: "error", message: normalizeClaudeCliError(stderr).slice(0, 2000) });
    push({ kind: "done", exitStatus: exit });
    finished = true;
    resolve?.();
    resolve = null;
  });
  forceFinishOnExit(child, () => finished, (exit) => {
    resident?.failPending(new Error("Claude 进程在 interrupt ACK 前异常收尾"));
    flushText();
    push({ kind: "error", message: "进程已退出但输出流未正常收尾(疑有残留子进程占用管道),已强制结束本回合" });
    push({ kind: "done", exitStatus: exit });
    finished = true;
    resolve?.();
    resolve = null;
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
