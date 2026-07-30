import { randomUUID } from "node:crypto";
import type { AgentType, ExecTarget } from "@harness/shared";
import type { AgentExecutor, ExecutorBuildOpts, RelayConfig, RunHandle, RunOpts } from "./types.js";
import { killChild, redactSecrets, resumeFor, spawnAgent } from "./spawn.js";
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
  readonly relayEnvHint?: string;
  private spec: CliSpec;
  private target: ExecTarget;
  private bin: string;
  private model?: string;
  private extraArgs: string[];
  private reasoningEffort?: string;
  private speed?: "fast";
  private relay?: RelayConfig;

  constructor(spec: CliSpec, opts: ExecutorBuildOpts = {}) {
    this.spec = spec;
    this.type = spec.key;
    this.model = opts.model;
    this.extraArgs = opts.extraArgs ?? [];
    this.reasoningEffort = opts.reasoningEffort;
    this.speed = opts.speed;
    this.bin = opts.bin ?? spec.bins[0];
    this.target = opts.target ?? { kind: "local" };
    // relay 只在 spec 声明了注入方式时才生效 —— 半截配置去撞一个必然 401 的端点,
    // 不如老老实实用 CLI 自己的官方账号(同 executors/index.ts 的 loadRelay 口径)。
    this.relay = spec.exec.relay ? opts.relay : undefined;
    this.relayEnvHint = this.relay ? spec.exec.relay!(this.relay).envHint : undefined;
    const where = this.target.kind === "ssh" ? this.target.host : "local";
    this.label = opts.name ?? `${spec.key}@${where}${opts.model ? "·" + opts.model : ""}`;
  }

  run(opts: RunOpts): RunHandle {
    const { args, sessionId, stdin } = this.plan(opts);
    const commandLine = redactSecrets(
      `${this.bin} ${args.join(" ")}${stdin ? " <prompt via stdin>" : ""}`,
    );
    const child = spawnAgent(this.target, opts.cwd, this.bin, args, stdin ? opts.prompt : "", this.env());
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
    };
  }

  resumeCommand(cwd: string, sessionId: string): string {
    const inner = this.spec.exec.session?.interactive?.(sessionId);
    // 诚实优先:没有已知恢复命令时给一句说明,而不是拼一条跑不通(或跑到别家
    // CLI 上)的命令 —— 那种命令会被用户当真复制去执行。
    if (!inner) return unknownResumeNote(this.spec, sessionId);
    return resumeFor(this.target, cwd, inner, this.relayEnvHint ?? "");
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

  private env(): Record<string, string> | undefined {
    if (!this.relay || !this.spec.exec.relay) return undefined;
    return this.spec.exec.relay(this.relay).env;
  }
}

export function unknownResumeNote(spec: { name: string }, sessionId: string): string {
  return `# ${spec.name} 暂无已知的会话恢复命令（sessionId ${sessionId || "未记录"} 仅供追溯；重跑任务会开新会话）`;
}
