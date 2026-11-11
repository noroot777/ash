import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@ash/shared";
import {
  cliConfigOverrideConflict,
  cliConfigOverrideEnvPatch,
  cliConfigOverrideSettings,
} from "@ash/shared/cli-overrides";
import { type CompactSnapshot, UNKNOWN_COMPACT_SNAPSHOT } from "@ash/shared/usage";
import { claudeLaunchCompact, cliHostEnv } from "./cli-env.js";
import type { AgentExecutor, ConsumedOutput, RelayConfig, ResidentHandle, ResumeFields, RunHandle, RunOpts } from "./types.js";
import type { MarkdownImageAccounting } from "./markdown-image-stream.js";
import type { StallVerdict } from "../turn-stall-verdict.js";
import { resolveSteerText, type SteerText } from "./steer-text.js";
import { spawnControllableForRun, spawnForRun, detachedInfo } from "./detached.js";
import { cleanupAfterRun, spawnAgent, resumeFor, resumeInner, shq, killChild, redactSecrets, failedChild } from "./spawn.js";
import { relayRoot } from "../llm.js";
import { monitorRedirectHook } from "../claude-monitor-hook.js";
import { anthropicContext1mBaseUrl, modelUsesContext1m, withContext1mSuffix } from "../anthropic-context-1m.js";
import { ClaudeControlBridge } from "./claude-control.js";
import { parseClaudeStream } from "./claude-stream.js";
import { claudeGoalInvocation, cleanupClaudeGoalContext } from "./claude-goal.js";
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
    // **不含 Monitor 改道那段钩子**:那条命令是给人复制到自己终端里手跑的,钩子头上那两个
    // `$ASH_TASK_ID` / `$ASH_TURN_TOKEN` 只在 ash 起的进程里有(auth/run-env.ts),手跑时它们
    // 是空的 —— 于是那一次会话里每一次 Monitor 调用都会拿空身份去敲 ash 的回调端点,既帮不上
    // 他,还得靠服务端那道兜底把它挡回去。这一截也不是他的「覆盖项」:界面上那条命令是用来
    // 说明「要带上哪些配置才跟 ash 里跑的一样」的,ash 自己的观测钩子不属于这个范围。
    const settings = this.settingsPayload(cwd, this.model, this.relay ? "<你的key>" : undefined, true);
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

  /** fastMode、覆盖项、供应商路由、Monitor 改道与恢复参数共用一份 --settings；多份参数不合并。 */
  private settingsPayload(
    cwd: string,
    model?: string,
    relayAuthToken?: string,
    // 把 Monitor 改道那段钩子**省掉**。两处要省的理由不同,但都不是「用户配了什么」:
    // 进程真能活过这一回合时内置 Monitor 本来就好用(claude-monitor-hook.ts 文件头),
    // 而恢复命令是给人手跑的(见 resumeFields)。
    omitMonitorHook = false,
  ): Record<string, unknown> | null {
    const settings = {
      ...(this.speed === "fast" ? { fastMode: true } : {}),
      ...cliConfigOverrideSettings(this.type, this.configOverrides, cliHostEnv(cwd)),
      ...monitorRedirectHook(omitMonitorHook),
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

  private runtimeSettings(cwd: string, model?: string, crossTurn = false): RuntimeSettings {
    const settings = this.settingsPayload(cwd, model, this.relay?.apiKey, crossTurn);
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

  /**
   * 这次起跑 CLI **最终生效**的压缩配置,解成启动快照带在每条水位上、随 commandLine 落库。
   * 各层配置的继承与企业策略层由 claudeLaunchCompact 判(cli-env.ts);这里补额外参数那条:buildArgs 会把
   * profile 与本次调用的额外参数排在 ash 那份 `--settings` **之后**,里面若自带 `--settings`
   * 就整份胜出(cliConfigOverrideConflict 那条),ash 注入的数一个都到不了 CLI —— 这时只能
   * 说「不知道」,不能发布被盖掉的那组(第 3 轮审查 F1)。判据跟 buildArgs 用同一份参数。
   * **只在起跑时调**:接管旧进程用会话存下的那份(attach 的 opts.compact)。
   */
  private launchCompactSnapshot(cwd: string | undefined, callExtraArgs: readonly string[] | undefined): CompactSnapshot {
    if (cliConfigOverrideConflict(this.type, [...this.extraArgs, ...(callExtraArgs ?? [])])) return UNKNOWN_COMPACT_SNAPSHOT;
    return claudeLaunchCompact(this.configOverrides, cwd);
  }

  run(opts: RunOpts): RunHandle {
    const sessionId = opts.sessionId ?? randomUUID();
    const model = opts.model ?? this.model;
    const settings = this.startupError
      ? { arg: null, cleanup: () => {} }
      : this.runtimeSettings(opts.cwd, model);
    const args = this.buildArgs(opts, sessionId, false, model, settings.arg);
    const goal = claudeGoalInvocation(opts);
    args.push(...goal.args);
    const commandLine = redactSecrets(`${this.bin} ${args.join(" ")} <prompt via stdin>${goal.marker}`);
    const child = this.startupError || settings.error
      ? failedChild(this.startupError ?? settings.error!)
      : spawnForRun(opts.cwd, this.bin, args, goal.input, { ...this.env(opts.cwd, model), ...opts.env }, opts.detach);
    child.on("close", goal.cleanup);
    child.on("close", settings.cleanup);
    let goalStarted = false;
    const launchCompact = this.launchCompactSnapshot(opts.cwd, opts.extraArgs);
    const events = cleanupWithEvents(parseClaudeStream(child, undefined, this.bin, this.type, launchCompact, settings.cleanup, undefined, sessionId, opts.cwd, opts.images), settings.cleanup);
    return {
      cliCommand: opts.cliCommand,
      goalStarted: () => goalStarted,
      sessionId,
      commandLine,
      launchCompact,
      events: (async function* () {
        for await (const event of events) {
          if (event.kind === "text" || event.kind === "tool" || event.kind === "thinking") goalStarted = true;
          yield event;
        }
      })(),
      kill: () => killChild(child),
      cleanup: async () => { settings.cleanup(); goal.cleanup(); return cleanupAfterRun(child); },
      detached: detachedInfo(child),
    };
  }

  // 单飞只把进程保留到当前任务回合结束：引导时 interrupt + send；最终 result 收台。
  runSteerable(opts: RunOpts): RunHandle {
    if (opts.cliCommand?.name === "goal") return this.run(opts);
    const sessionId = opts.sessionId ?? randomUUID();
    const model = opts.model ?? this.model;
    // **`--input-format stream-json` ≠ 跨回合**：这一路的进程照样在本回合的 `result`
    // 之后就被收台（见下面的 `singleRunFromResident`），所以 Monitor 改道必须照挂 ——
    // 第三个参数给 `false`，而 `buildArgs` 那个 `true` 只是在要 stdin 的那个参数。
    const settings = this.startupError
      ? { arg: null, cleanup: () => {} }
      : this.runtimeSettings(opts.cwd, model, false);
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
      this.residentFromChild(child, sessionId, commandLine, this.launchCompactSnapshot(opts.cwd, opts.extraArgs), settings.cleanup, opts.cwd, opts.images, true),
      detached,
    );
  }

  attach(child: ChildProcess, opts: { sessionId: string; commandLine: string; cwd?: string; images?: MarkdownImageAccounting; consumed?: ConsumedOutput; compact?: CompactSnapshot | null }): RunHandle {
    // 接回的是**旧进程**:压缩快照只能用它起跑时那份(调用方从会话行里取),此刻的执行器配置
    // 可能早改过了(第 2 轮审查)。没给 = 不知道,水位上就不带压缩字段,不编。
    const compact = opts.compact ?? null;
    child.on("close", () => cleanupClaudeGoalContext(opts.commandLine));
    const detached = detachedInfo(child);
    const settingsCleanup = runtimeSettingsCleanupFromCommandLine(opts.commandLine);
    child.on("close", settingsCleanup);
    if (child.stdin && opts.commandLine.includes("--input-format")) {
      return singleRunFromResident(
        this.residentFromChild(child, opts.sessionId, opts.commandLine, compact, settingsCleanup, opts.cwd, opts.images, true, opts.consumed),
        detached,
      );
    }
    return {
      sessionId: opts.sessionId,
      commandLine: opts.commandLine,
      launchCompact: compact,
      events: cleanupWithEvents(
        // **接管必须把会话身份传下去**：这条流是从已消费的 offset 之后接着读的，`init`
        // 早在上一轮消费掉了，内置 Monitor 的投影靠「等下一条 system 事件」永远认领不回来
        // （见 claude-monitors.ts 构造函数）。
        parseClaudeStream(child, undefined, this.bin, this.type, compact, settingsCleanup, undefined, opts.sessionId, opts.cwd, opts.images),
        settingsCleanup,
      ),
      kill: () => child.kill(),
      cleanup: async () => { settingsCleanup(); return cleanupAfterRun(child); },
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
      : this.runtimeSettings(opts.cwd, model, true);
    const args = this.buildArgs(opts, sessionId, true, model, settings.arg);
    const commandLine = redactSecrets(`${this.bin} ${args.join(" ")} <messages via stdin>`);
    const child = this.startupError || settings.error
      ? failedChild(this.startupError ?? settings.error!)
      : spawnAgent(opts.cwd, this.bin, args, userLine(opts.prompt), { ...this.env(opts.cwd, model), ...opts.env }, {
          keepStdin: true,
        });
    child.on("close", settings.cleanup);
    return this.residentFromChild(child, sessionId, commandLine, this.launchCompactSnapshot(opts.cwd, opts.extraArgs), settings.cleanup, opts.cwd, opts.images);
  }

  private residentFromChild(
    child: ChildProcess,
    sessionId: string,
    commandLine: string,
    // 必填:三条起跑路径与接管各自给出这个进程的启动快照,漏传就编译不过。
    compact: CompactSnapshot | null,
    settingsCleanup: () => void = () => {},
    cwd?: string,
    images?: MarkdownImageAccounting,
    reapsAtTurnEnd = false,
    consumed?: ConsumedOutput,
  ): ResidentHandle {
    // 打断/发送记录只给单飞落:接管(attach)只接单飞,常驻调度台重启是另开一台,不重放。
    const resident = new ClaudeControlBridge(reapsAtTurnEnd, reapsAtTurnEnd ? (child as { ashPaths?: { out?: string } }).ashPaths?.out : undefined);
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
      launchCompact: compact,
      events: cleanupWithEvents(
        // 同 attach：可引导流接管回来时同样没有新的 init。
        parseClaudeStream(child, resident, this.bin, this.type, compact, settingsCleanup, undefined, sessionId, cwd, images, consumed),
        settingsCleanup,
      ),
      send: (text: string) => {
        // stdin 没了/已经关掉 = 这条消息一个字都进不去,如实说不(见 ResidentHandle.send)。
        const stdin = child.stdin;
        if (!stdin || stdin.destroyed || stdin.writableEnded) return false;
        // 先记下「送过一条」再写(同一个同步段):重启接管靠它认出这个会话在忙,见 noteSend。
        try {
          resident.noteSend();
        } catch (error) {
          console.warn("[ash] 记不下这条消息的发送记录，先不送:", error);
          return false;
        }
        stdin.write(userLine(text));
        resident.beginTurn(true);
        return true;
      },
      turnActive: () => resident.turnActive,
      epoch: () => resident.epoch,
      backgroundPending: () => resident.backgroundPending(),
      interrupt: () => {
        const request = resident.request();
        resident.claimInterrupt(request.requestId, false);
        child.stdin?.write(request.line);
      },
      steer: async (text: SteerText, onInterrupted, beforeSend) => {
        const request = resident.request();
        // 认领先落盘、再写 stdin(同一个同步段):重启接管靠它认出被打断的结尾,见 claimInterrupt。
        resident.claimInterrupt(request.requestId, true);
        const ack = resident.waitFor(request.requestId);
        let interruptWritten = false;
        try {
          await writeChecked(request.line);
          interruptWritten = true;
          onInterrupted?.();
          await ack.promise;
          await beforeSend?.();
          // **正文在这里才定稿**(惰性正文见 steer-text.ts)。
          const line = userLine(await resolveSteerText(text));
          resident.markSent(request.requestId); // 与下面那次写在同一个同步段里
          await writeChecked(line);
          resident.beginTurn(true); // 同 send:消息一送进去会话就在忙,别等模型先开口
        } catch (error) {
          ack.cancel();
          // interrupt 尚未写出时才撤销；一旦写出，CLI 会产生一个 turnEnd，消费层必须
          // 保留对应认领，即使紧接着的新 user 消息写失败。
          if (!interruptWritten) resident.withdraw(request.requestId);
          throw error;
        }
      },
      close: () => {
        child.stdin?.end();
      },
      kill: () => killChild(child),
      cleanup: async () => { settingsCleanup(); return cleanupAfterRun(child); },
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

/**
 * 单飞等后台工作最多等多久。工作流跑半小时到一小时很常见；到点还没跑完就收台，被收走的那几个
 * 照常记进时间线（claude-background-reaped.ts）。只认有限正数且不超过 setTimeout 的上限
 * （超了 Node 会按 1ms 触发，等于一进入等待就收台），坏值退回缺省。
 */
const BACKGROUND_HOLD_MS = (() => {
  const fallback = 2 * 60 * 60_000;
  const raw = process.env.ASH_BACKGROUND_HOLD_MS?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (Number.isFinite(value) && value > 0 && value <= 2 ** 31 - 1) return value;
  console.warn(`[ash] ASH_BACKGROUND_HOLD_MS=${raw} 不是有效的毫秒数，按缺省 ${fallback} 处理`);
  return fallback;
})();

/**
 * 后台都跑完之后最多等多久让 CLI 开回合收尾。正常是立刻开(完成通知一到就开);等这么久还没开,
 * 就是主智能体这边出了问题,不再算后台的账。
 */
const WRAPUP_START_MS = 10 * 60_000;

/**
 * 单飞：一个回合 = 一个进程。回合 `result` 一到就关 stdin 收台 —— **除非名下还有后台子代理 /
 * 工作流没跑完**（turnEnd 带 `background`）。它们寄生在这个进程里，收了台就白跑了；而 CLI
 * 自己的口径是「后台的活没完，这一回合就没完」：`claude -p` 会一直压着结果，直到它们跑完、
 * 拿完成通知自己开一回合收尾（2026-11-06 实测）。所以这里照着等：进程留着、流接着读，任务
 * 仍是运行中，下一个不再带 `background` 的回合结尾才收台。等待期间插话照常送达（没有回合可
 * 打断，就直接送进去），停止照常杀进程；最多等 `BACKGROUND_HOLD_MS`。
 *
 * 等后台的期限只管「回合之间在等后台」这一段：开了下一回合（完成通知到了、主智能体开始整理
 * 结果，或者插话送进去）它就作废，那之后慢不慢归停滞看门狗管；那一回合结尾还有没跑完的再重新
 * 起算。作废靠回合身份（`resident.epoch` 对 turnEnd.epoch），不靠「新回合开始时回调一声」——
 * 结尾要排队才到这里，回调可能先跑，清掉的是还没建起来的那个定时器。同理，过期的结尾也不收台。
 *
 * 「后台跑完了」和「下一回合开始了」是两件事（自由审查 i8RAcPM3zvgD R2）：账本归零（最后一个
 * 完成通知到了）等后台的责任就结束，改成等 CLI 开回合收尾，最多 `wrapupMs`；判后台超时/丢失之前
 * 一律核对实时账本（`resident.backgroundPending`），跑完了就不能说成没跑完。
 *
 * 等到点还没跑完 = 这一轮的活没干完：硬杀进程（关 stdin 只是请它退出，它可以接着等自己的
 * 后台、一直不走），报一条真错误，并经 `failure()` 把「ash 判这一轮未完成」交给结算 —— 智能体
 * 可能早在发起后台工作那一回合就交过卷，不能让它落成完成。后台还没跑完进程就自己退了（哪怕
 * exit 0）同理，见 `done.unfinished`；后台跑完了却一直没开回合收尾（或者没开就退了）也同理，
 * 只是原因如实说成后者。
 */
export function singleRunFromResident(
  resident: ResidentHandle,
  detached?: RunHandle["detached"],
  holdMs = BACKGROUND_HOLD_MS,
  wrapupMs = WRAPUP_START_MS,
): RunHandle {
  let intermediateEnds = 0;
  let accepting = true;
  // 在等什么:`background` = 后台还有没跑完的;`wrapup` = 后台都跑完了,等 CLI 开回合收尾。
  // `epoch` 是开始等的那个结尾的回合身份,之后开了新回合这份等待就作废。
  let hold: { phase: "background" | "wrapup"; epoch: number | undefined; timer: ReturnType<typeof setTimeout> } | null = null;
  let verdict: StallVerdict | null = null;
  let stopped = false; // 用户停止:不另外判「后台没跑完」,停止自有它的结算
  const clearHold = () => {
    if (hold) clearTimeout(hold.timer);
    hold = null;
  };
  const stale = (epoch: number | undefined) => epoch !== undefined && resident.epoch !== undefined && resident.epoch() !== epoch;
  // 这一刻还在等:等的那个回合之后没再开新回合。
  const holding = () => !!hold && !stale(hold.epoch);
  // 后台账本此刻怎么样。没有实时账本的常驻答不上来,按还在跑。
  const ledger = (): "pending" | "unknown" | "settled" => {
    const pending = resident.backgroundPending?.();
    if (!pending || pending.agent + pending.workflow > 0) return "pending";
    return pending.unknown ? "unknown" : "settled";
  };
  const judge = (kind: StallVerdict["kind"], reason: string): StallVerdict => {
    const at = new Date().toISOString();
    return { kind, reason, at, since: at, durable: false };
  };
  const fail = (failed: StallVerdict) => {
    verdict = failed;
    accepting = false;
    resident.kill();
  };
  const wait = (phase: "background" | "wrapup", epoch: number | undefined, ms: number) => {
    clearHold();
    const timer = setTimeout(() => {
      const current = hold;
      hold = null;
      if (stopped || !accepting || !current || stale(current.epoch)) return; // 已经不在等了
      if (current.phase === "wrapup") return fail(judge("wrapup_missing", wrapupTimeoutMessage(wrapupMs)));
      const state = ledger();
      if (state === "settled") return wait("wrapup", current.epoch, wrapupMs);
      fail(state === "unknown"
        ? judge("background_unverified", holdUnverifiedMessage(holdMs))
        : judge("background_timeout", holdTimeoutMessage(holdMs)));
    }, ms);
    timer.unref?.();
    hold = { phase, epoch, timer };
  };
  // 最后一个完成通知到了:等后台的责任到此为止,改等收尾。
  const reassess = () => {
    if (hold?.phase === "background" && holding() && ledger() === "settled") wait("wrapup", hold.epoch, wrapupMs);
  };
  const events = (async function* (): AsyncIterable<AgentEvent> {
    try {
      for await (const event of resident.events) {
        if (event.kind === "turnEnd") {
          // 插话打断出来的结尾:进程还要接着跑插话开的那一回合。接管回来的这一代没发过那次打断
          // (计数是 0),只能靠这个标记认。
          if (event.interrupted) {
            intermediateEnds = Math.max(0, intermediateEnds - 1);
            continue;
          }
          // 消费到它时已经开了新回合(CLI 自己开的,或者插话送进去了):这个结尾过期了,既不收台
          // 也不开始等,新回合的结尾再定。
          if (stale(event.epoch)) continue;
          if (intermediateEnds > 0) {
            intermediateEnds -= 1;
            continue;
          }
          clearHold();
          if (event.background) {
            // 期限从开始等的那一刻算,不随重启接管重新给满(起点由解析层落盘,见 claude-recovery.ts)。
            const since = Date.parse(event.background.since ?? "");
            wait("background", event.epoch, Number.isFinite(since) ? Math.max(0, holdMs - (Date.now() - since)) : holdMs);
            reassess(); // 排队到这里的这段时间里,它们可能已经全跑完了
            continue;
          }
          accepting = false;
          resident.close();
          yield { kind: "done", exitStatus: 0 };
          return;
        }
        if (event.kind === "done") {
          accepting = false;
          // 进程没了的那一刻账上还有没跑完的、跑没跑完说不准的:都不是跑完了。在等着的时候没了、
          // 账上却都跑完了:是没开回合收尾,不是后台丢了。
          if (!verdict && !stopped) {
            if (event.unfinished) {
              verdict = event.unfinished.unknown
                ? judge("background_unverified", BACKGROUND_UNVERIFIED_MESSAGE)
                : judge("background_lost", backgroundLostMessage(event.unfinished));
            } else if (holding()) {
              verdict = resident.backgroundPending
                ? judge("wrapup_missing", WRAPUP_LOST_MESSAGE)
                : judge("background_lost", backgroundLostMessage());
            }
          }
          const failed = verdict as StallVerdict | null; // 定时器回调里也会写,控制流分析看不见
          if (failed) yield { kind: "error", message: failed.reason };
        } else reassess();
        yield event;
        if (event.kind === "done") return;
      }
    } finally {
      clearHold();
    }
  })();
  return {
    sessionId: resident.sessionId,
    commandLine: resident.commandLine,
    launchCompact: resident.launchCompact,
    events,
    detached,
    failure: () => verdict,
    async steer(text: SteerText, beforeSend) {
      if (!accepting) throw new Error("Claude 当前回合已经结束");
      // 等后台工作的空档:没有回合可打断(打断一个空闲会话不会再吐 result,计数就错位了),
      // 消息直接送进去自己开一回合;那一回合的结尾照常判要不要接着等。
      if (resident.turnActive?.() === false) {
        await beforeSend?.();
        const body = await resolveSteerText(text);
        // 准备正文的这段 await 里,完成通知可能已经让 CLI 自己开了一回合:那就照忙碌那条路打断
        // 再送,而不是排在它后面(beforeSend 已经跑过,不再跑第二遍)。
        if (resident.turnActive?.() === false) {
          if (!resident.send(body)) throw new Error("Claude 没收下这条消息（stdin 已关闭，或记不下发送记录）");
          clearHold();
          return;
        }
        text = body;
        beforeSend = undefined;
      }
      intermediateEnds += 1;
      let interrupted = false;
      try {
        if (resident.steer) await resident.steer(text, () => { interrupted = true; }, beforeSend);
        else {
          resident.interrupt();
          interrupted = true;
          resident.send(await resolveSteerText(text));
        }
      } catch (error) {
        if (!interrupted) intermediateEnds = Math.max(0, intermediateEnds - 1);
        else {
          accepting = false;
          stopped = true; // 为了带着插话重开而杀,不是后台工作丢了
          clearHold();
          resident.kill();
          throw Object.assign(error instanceof Error ? error : new Error(String(error)), { nativeSteerRestart: true });
        }
        throw error;
      }
      // 插话开了新的一回合:要不要接着等后台,由那一回合的结尾重新判,旧的等待期限作废。
      clearHold();
    },
    kill() {
      accepting = false;
      stopped = true;
      clearHold(); // 停止 = 不再等后台,别让旧期限在进程退出前补报一条超时
      resident.kill();
    },
    cleanup: resident.cleanup,
  };
}

function backgroundLostMessage(unfinished?: { agent: number; workflow: number }): string {
  const parts = [
    unfinished?.workflow ? `${unfinished.workflow} 个工作流` : "",
    unfinished?.agent ? `${unfinished.agent} 个后台子代理` : "",
  ].filter(Boolean).join("、");
  return `后台工作${parts ? `（${parts}）` : ""}还没跑完，智能体进程就退出了，本回合按未完成结算。`;
}

const BACKGROUND_UNVERIFIED_MESSAGE =
  "重启接管时读不出之前的输出，确认不了后台工作跑没跑完，智能体进程就退出了，本回合按未完成结算。";

const holdTimeoutMessage = (ms: number) =>
  `后台工作等了 ${Math.round(ms / 60_000)} 分钟还没跑完，已收掉进程，本回合按未完成结算。`;

const holdUnverifiedMessage = (ms: number) =>
  `重启接管时读不出之前的输出，确认不了后台工作跑没跑完；等了 ${Math.round(ms / 60_000)} 分钟智能体也没接着干，已收掉进程，本回合按未完成结算。`;

const wrapupTimeoutMessage = (ms: number) =>
  `后台工作都跑完了，智能体等了 ${Math.round(ms / 60_000)} 分钟还没开始整理结果，已收掉进程，本回合按未完成结算。`;

const WRAPUP_LOST_MESSAGE = "后台工作都跑完了，智能体还没开始整理结果进程就退出了，本回合按未完成结算。";

// stream-json 的入站格式:一条 user 消息 = 一行 JSON。
const userLine = (text: string) =>
  JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } }) + "\n";
