import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { AgentType } from "@ash/shared";
import { cliConfigOverrideEnvPatch } from "@ash/shared/cli-overrides";
import { cliHostEnv, resumeEnvHint } from "./cli-env.js";
import type { AgentExecutor, ExecutorBuildOpts, RelayConfig, ResumeFields, RunHandle, RunOpts } from "./types.js";
import { spawnForRun, detachedInfo } from "./detached.js";
import { killChild, redactSecrets, resumeFor } from "./spawn.js";
import { textParser } from "./catalog/parsers.js";
import { valueArgs, type CliSpec } from "./catalog/types.js";

// 按目录里的 spec 装配命令行、跑一次性非交互回合。claude / codex 有专用类(常驻
// 会话、诊断链路),其余全部走这里 —— 于是「新增一个可派任务的 CLI」= 写一个 spec。
//
// 三条硬约定,别绕:
//   ① 密钥只走进程 env(spec.exec.relay 的 env),commandLine 另有 redactSecrets 兜底;
//   ② 预检失败(bin 不在 PATH / cwd 没了)由 spawnAgent 返回 failedChild,错误在
//      parser 第一次迭代时才发出 —— 这里绝不自己提前 emit 'error'(会变成没有
//      监听者的 uncaughtException,任务永远卡 running,见 server/CLAUDE.md);
//   ③ 不实现 openResident。「谁能当团队调度者」就是靠这个方法存在与否过滤的,
//      generic 装一个假的等于让一堆跑不了常驻会话的 CLI 出现在调度者下拉里。
export class GenericCliExecutor implements AgentExecutor {
  readonly type: AgentType;
  readonly label: string;
  private readonly resumeEnvHint?: string;
  private spec: CliSpec;
  private bin: string;
  readonly model?: string;
  private extraArgs: string[];
  readonly reasoningEffort?: string;
  private speed?: "fast";
  private relay?: RelayConfig;
  private configOverrides?: Record<string, number>;

  constructor(spec: CliSpec, opts: ExecutorBuildOpts = {}) {
    this.spec = spec;
    this.type = spec.key;
    this.model = opts.model;
    this.extraArgs = opts.extraArgs ?? [];
    this.reasoningEffort = opts.reasoningEffort;
    this.speed = opts.speed;
    this.bin = opts.bin ?? spec.bins[0];
    this.configOverrides = opts.configOverrides;
    // relay 只在 spec 声明了注入方式时才生效 —— 半截配置去撞一个必然 401 的端点,
    // 不如老老实实用 CLI 自己的官方账号(同 executors/index.ts 的 loadRelay 口径)。
    this.relay = spec.exec.relay ? opts.relay : undefined;
    this.resumeEnvHint = resumeEnvHint(
      this.type,
      this.configOverrides,
      this.relay ? spec.exec.relay!(this.relay).envHint : undefined,
    );
    this.label = opts.name ?? `${spec.key}@local${opts.model ? "·" + opts.model : ""}`;
  }

  run(opts: RunOpts): RunHandle {
    const { args, sessionId, stdin } = this.plan(opts);
    // 展示用的命令行:prompt 走 argv 时把正文压掉。它会存进 sessions.command_line
    // 并在 UI 展示,任务正文动辄上千字,原样带上等于把 body 抄一遍进会话表。
    const shown = args.map((a) => (a === opts.prompt ? shortPrompt(a) : a));
    const commandLine = redactSecrets(
      `${this.bin} ${shown.join(" ")}${stdin ? " <prompt via stdin>" : ""}`,
    );
    const child = spawnForRun(opts.cwd, this.bin, args, stdin ? opts.prompt : "", { ...this.env(), ...opts.env }, opts.detach);
    const lifecycle = { stopRequested: false };
    const parser = this.spec.exec.parser ?? textParser;
    return {
      sessionId,
      commandLine,
      events: parser({ child, bin: this.bin, label: this.label, trace: opts.trace, lifecycle }),
      kill: () => {
        lifecycle.stopRequested = true;
        killChild(child);
      },
      detached: detachedInfo(child),
    };
  }

  attach(child: ChildProcess, opts: { sessionId: string; commandLine: string }): RunHandle {
    const lifecycle = { stopRequested: false };
    const parser = this.spec.exec.parser ?? textParser;
    return {
      sessionId: opts.sessionId,
      commandLine: opts.commandLine,
      events: parser({ child, bin: this.bin, label: this.label, lifecycle }),
      kill: () => {
        lifecycle.stopRequested = true;
        child.kill();
      },
      detached: detachedInfo(child),
    };
  }

  resumeCommand(cwd: string, sessionId: string): string {
    const inner = interactiveResumeInner(this.spec, sessionId);
    // 诚实优先:拼不出可信的恢复命令时给一句说明,而不是一条跑不通(或跑到别家
    // CLI 上、或引用一个不存在的会话)的命令 —— 那种命令会被用户当真复制去执行。
    if (!inner) return unknownResumeNote(this.spec, sessionId);
    return resumeFor(cwd, inner, this.resumeEnvHint ?? "");
  }

  // 目录里的 spec 没有「盖掉 CLI 自己配置文件」那一档覆盖(声明表里只有 claude),
  // 所以这里不带参数。
  resumeFields(cwd: string, sessionId: string): ResumeFields {
    return { resumeCommand: this.resumeCommand(cwd, sessionId), resumeEnv: this.resumeEnvHint ?? null, resumeArgs: null };
  }

  // 命令行装配。顺序:subcommand → baseArgs → 会话参数 → model / effort / 加速档
  // → relay → profile 的固定参数 → 本次调用的 extraArgs → prompt。
  // 后面的能覆盖前面的(同 flag 时多数 CLI 取最后一个),所以用户自带参数在最后。
  private plan(opts: RunOpts): { args: string[]; sessionId: string; stdin: boolean } {
    const exec = this.spec.exec;
    const args = [...(exec.subcommand ?? []), ...(exec.baseArgs ?? [])];
    const { sessionId, sessionArgs } = this.session(opts.sessionId);
    args.push(...sessionArgs);
    args.push(...valueArgs(exec.model, opts.model ?? this.model));
    args.push(...valueArgs(exec.reasoningEffort, this.reasoningEffort));
    if (this.speed === "fast" && exec.fastArgs?.length) args.push(...exec.fastArgs);
    if (this.relay && exec.relay) args.push(...(exec.relay(this.relay).args ?? []));
    if (this.extraArgs.length) args.push(...this.extraArgs);
    if (opts.extraArgs?.length) args.push(...opts.extraArgs);

    const p = exec.prompt;
    if (p.via === "arg") args.push(opts.prompt);
    else if (p.via === "flag") args.push(p.flag ?? "-p", opts.prompt);
    else if (p.stdinArg) args.push(p.stdinArg);
    return { args, sessionId, stdin: p.via === "stdin" };
  }

  // 会话延续。spec 没声明 resumeArgs 就**忽略** RunOpts.sessionId 并发一个新 id:
  // 记录得有个 id 才能串起时间线,但绝不把「其实是全新会话」伪装成续跑。
  private session(wanted?: string): { sessionId: string; sessionArgs: string[] } {
    const s = this.spec.exec.session;
    if (s?.resumeArgs && wanted) return { sessionId: wanted, sessionArgs: s.resumeArgs(wanted) };
    if (s?.newIdFlag) {
      const fresh = randomUUID();
      return { sessionId: fresh, sessionArgs: [s.newIdFlag, fresh] };
    }
    // CLI 自己产生 id(靠 parser 发 {kind:"session"} 带回来)时不占位,免得
    // 写进 sessions.cli_session_id 的是个假 id。
    return { sessionId: s?.resumeArgs ? "" : randomUUID(), sessionArgs: [] };
  }

  // 供应商注入 + 盖过 CLI 自己配置文件的那几项(声明见 shared/src/cli-overrides.ts)。
  // 两者都可能为空,全空时返回 undefined —— spawn 那边据此走「不额外注入」的路径。
  // `undefined` 值 = 从子进程环境里删掉那个变量(见 cliConfigOverrideEnvPatch)。
  private env(): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = cliConfigOverrideEnvPatch(this.type, this.configOverrides, cliHostEnv());
    if (this.relay && this.spec.exec.relay) Object.assign(env, this.spec.exec.relay(this.relay).env);
    return env;
  }
}

/**
 * 这个 CLI 的 sessionId **是不是 CLI 真实认得的 id**。判定与上面 `session()` 的三档
 * 一一对应:`newIdFlag` = ash 自己发的 id 已经告诉了 CLI;`resumeArgs` = id 只可能
 * 来自 parser 回报的 `{kind:"session"}`。两者都没有时,`session()` 发的是个**纯 ash
 * 侧运行记录**的 UUID,CLI 压根没听说过它 —— 拿它拼 `--resume` 就是给用户一条引用
 * 不存在会话的命令(第 1 轮审查抓到的 antigravity 就是这种)。
 */
export function hasTrustedSessionId(spec: CliSpec): boolean {
  const s = spec.exec.session;
  return !!(s?.newIdFlag || s?.resumeArgs);
}

/** 可信才给交互式恢复命令(不带 cd 前缀);否则 null,由调用方换成诚实说明。 */
export function interactiveResumeInner(spec: CliSpec, sessionId: string): string | null {
  if (!sessionId || !hasTrustedSessionId(spec)) return null;
  return spec.exec.session?.interactive?.(sessionId) ?? null;
}

export function unknownResumeNote(spec: CliSpec | { name: string }, sessionId: string): string {
  const s = "exec" in spec ? spec.exec.session : undefined;
  // 三种原因分开说,否则用户看不出「这个 CLI 不支持」和「这条会话没接通」的区别。
  const why =
    s?.interactive && !("exec" in spec && hasTrustedSessionId(spec))
      ? "ash 没把会话 id 交给它、它也没回报,所以这个 id 只是运行记录,不能用来 --resume"
      : !sessionId
        ? "本次运行没有拿到 CLI 的会话 id"
        : "暂无已知的会话恢复命令";
  return `# ${spec.name} 无法恢复会话：${why}（sessionId ${sessionId || "未记录"} 仅供追溯；重跑任务会开新会话）`;
}

// 长 prompt 在展示用命令行里只留个头(短的原样保留,方便看清到底传了什么)。
const shortPrompt = (s: string) => (s.length <= 300 ? s : `${s.slice(0, 200)}…<prompt 共 ${s.length} 字>`);
