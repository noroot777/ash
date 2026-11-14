import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@ash/shared";
import { type CliHostEnv, cliConfigOverrideEnvPatch, cliConfigOverrideSettings } from "@ash/shared/cli-overrides";
import type { CompactSnapshot } from "@ash/shared/usage";
import { claudeLaunchCompact, cliHostEnv, hostEnvOf } from "./cli-env.js";
import { type ClaudeCompactFacts, claudeCompactFacts, claudeConfigDirOf } from "./claude-settings.js";
import type { AgentExecutor, ConsumedOutput, RelayConfig, ResidentHandle, ResumeFields, RunHandle, RunOpts } from "./types.js";
import type { MarkdownImageAccounting } from "./markdown-image-stream.js";
import { resolveSteerText, type SteerText } from "./steer-text.js";
import { spawnControllableForRun, spawnForRun, detachedInfo } from "./detached.js";
import { cleanupAfterRun, spawnAgent, resumeFor, resumeInner, shq, killChild, redactSecrets, failedChild } from "./spawn.js";
import { relayRoot } from "../llm.js";
import { monitorRedirectHook } from "../claude-monitor-hook.js";
import { anthropicContext1mBaseUrl, modelUsesContext1m, withContext1mSuffix } from "../anthropic-context-1m.js";
import { ClaudeControlBridge } from "./claude-control.js";
import { parseClaudeStream } from "./claude-stream.js";
import { claudeAshMcpInjection, type ClaudeAshMcpInjection } from "./ash-mcp-inject.js";
import { claudeGoalInvocation, cleanupClaudeGoalContext } from "./claude-goal.js";
import { singleRunFromResident } from "./claude-single-run.js";
export { parseClaudeStream } from "./claude-stream.js";
export { singleRunFromResident } from "./claude-single-run.js";
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
    // 起跑时传这次读到的那份(launchFacts);恢复命令没有起跑,按会话 cwd 现读。
    host: CliHostEnv = cliHostEnv(cwd),
  ): Record<string, unknown> | null {
    const settings = {
      ...(this.speed === "fast" ? { fastMode: true } : {}),
      ...cliConfigOverrideSettings(this.type, this.configOverrides, host),
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
  private env(host: CliHostEnv, model?: string): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = cliConfigOverrideEnvPatch(this.type, this.configOverrides, host);
    if (this.relay) {
      env.ANTHROPIC_BASE_URL = this.relayBaseUrl(model);
      env.ANTHROPIC_AUTH_TOKEN = this.relay.apiKey;
      env.ANTHROPIC_API_KEY = undefined;
      env.CLAUDE_CODE_OAUTH_TOKEN = undefined;
    }
    return env;
  }

  private runtimeSettings(cwd: string, host: CliHostEnv, model?: string, crossTurn = false): RuntimeSettings {
    const settings = this.settingsPayload(cwd, model, this.relay?.apiKey, crossTurn, host);
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
   * 判定全在 claudeLaunchCompact(cli-env.ts):各层继承、企业策略层,以及额外参数改了 CLI 读哪些
   * 配置的情形。交给它的额外参数跟 buildArgs 拼进命令的是同一份(profile 的 + 本次调用的)。
   * **只在起跑时调**:接管旧进程用会话存下的那份(attach 的 opts.compact)。facts 跟注入 settings/env
   * 的是同一次读取(launchFacts),快照记的就是真注入的那份。
   */
  private launchCompactSnapshot(opts: RunOpts, facts: ClaudeCompactFacts): CompactSnapshot {
    return claudeLaunchCompact(this.configOverrides, facts, [...this.extraArgs, ...(opts.extraArgs ?? [])]);
  }

  /** 这次起跑的配置事实,按子进程自己的 CLAUDE_CONFIG_DIR 读一次,三条起跑路径各调一次。 */
  private launchFacts(opts: RunOpts): { facts: ClaudeCompactFacts; host: CliHostEnv } {
    const facts = claudeCompactFacts(opts.cwd, claudeConfigDirOf(opts.env));
    return { facts, host: hostEnvOf(facts) };
  }

  run(opts: RunOpts): RunHandle {
    const sessionId = opts.sessionId ?? randomUUID();
    const model = opts.model ?? this.model;
    const { facts, host } = this.launchFacts(opts);
    const settings = this.startupError
      ? { arg: null, cleanup: () => {} }
      : this.runtimeSettings(opts.cwd, host, model, false);
    const { args, ash } = this.buildArgs(opts, sessionId, false, model, settings.arg);
    const goal = claudeGoalInvocation(opts);
    args.push(...goal.args);
    const commandLine = redactSecrets(`${this.bin} ${args.join(" ")} <prompt via stdin>${goal.marker}`);
    const child = this.startupError || settings.error
      ? failedChild(this.startupError ?? settings.error!)
      : spawnForRun(opts.cwd, this.bin, args, goal.input, { ...this.env(host, model), ...opts.env }, opts.detach);
    child.on("close", goal.cleanup);
    child.on("close", settings.cleanup);
    let goalStarted = false;
    const launchCompact = this.launchCompactSnapshot(opts, facts);
    const events = cleanupWithEvents(parseClaudeStream(child, undefined, this.bin, this.type, launchCompact, settings.cleanup, undefined, sessionId, opts.cwd, opts.images, undefined, ash), settings.cleanup);
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
    // crossTurn 给 `false`，而 `buildArgs` 那个 `true` 只是在要 stdin 的那个参数。
    const { facts, host } = this.launchFacts(opts);
    const settings = this.startupError
      ? { arg: null, cleanup: () => {} }
      : this.runtimeSettings(opts.cwd, host, model, false);
    const { args, ash } = this.buildArgs(opts, sessionId, true, model, settings.arg);
    const commandLine = redactSecrets(`${this.bin} ${args.join(" ")} <messages via stdin>`);
    const child = this.startupError || settings.error
      ? failedChild(this.startupError ?? settings.error!)
      : spawnControllableForRun(
          opts.cwd,
          this.bin,
          args,
          userLine(opts.prompt),
          { ...this.env(host, model), ...opts.env },
          opts.detach,
        );
    child.on("close", settings.cleanup);
    const detached = detachedInfo(child);
    return singleRunFromResident(
      this.residentFromChild(child, sessionId, commandLine, this.launchCompactSnapshot(opts, facts), settings.cleanup, opts.cwd, opts.images, true, undefined, ash),
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
    const { facts, host } = this.launchFacts(opts);
    const settings = this.startupError
      ? { arg: null, cleanup: () => {} }
      : this.runtimeSettings(opts.cwd, host, model, true);
    const { args, ash } = this.buildArgs(opts, sessionId, true, model, settings.arg);
    const commandLine = redactSecrets(`${this.bin} ${args.join(" ")} <messages via stdin>`);
    const child = this.startupError || settings.error
      ? failedChild(this.startupError ?? settings.error!)
      : spawnAgent(opts.cwd, this.bin, args, userLine(opts.prompt), { ...this.env(host, model), ...opts.env }, {
          keepStdin: true,
        });
    child.on("close", settings.cleanup);
    return this.residentFromChild(child, sessionId, commandLine, this.launchCompactSnapshot(opts, facts), settings.cleanup, opts.cwd, opts.images, false, undefined, ash);
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
    ash?: ClaudeAshMcpInjection,
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
        parseClaudeStream(child, resident, this.bin, this.type, compact, settingsCleanup, undefined, sessionId, cwd, images, consumed, ash),
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
  private buildArgs(opts: RunOpts, sessionId: string, resident: boolean, selectedModel = opts.model ?? this.model, settingsArg: string | null = null) {
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
    // ash 自己的 MCP 起跑时注入:同名以最后一个 `--mcp-config` 为准,所以排在全部参数之后(ash-mcp-inject.ts)。
    const ash = claudeAshMcpInjection();
    args.push(...ash.args);
    return { args, ash };
  }
}

// stream-json 的入站格式:一条 user 消息 = 一行 JSON。
const userLine = (text: string) =>
  JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } }) + "\n";
