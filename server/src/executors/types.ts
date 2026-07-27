import type { AgentEvent, AgentType } from "@harness/shared";
import type { RunTracePaths } from "./diagnostics.js";

export interface RunOpts {
  prompt: string;
  cwd: string;
  sessionId?: string; // resume an existing CLI session
  model?: string;
  extraArgs?: string[];
  trace?: RunTracePaths;
}

// A planned invocation: the resolved session id + exact command, plus a live
// event stream. The orchestrator records sessionId/commandLine for traceability
// (DESIGN.md §13) before/while consuming the stream. `kill` terminates the
// underlying subprocess (manual stop) — the stream then ends like a normal exit.
export interface RunHandle {
  sessionId: string;
  commandLine: string;
  events: AsyncIterable<AgentEvent>;
  kill(): void;
}

// 挂在执行器上的供应商(§5)。非空时启动 CLI 前注入 base_url + key,顶掉 CLI
// 自己的官方登录账号。baseUrl 恒为根地址(不含 /v1),各 executor 按需自行补路径。
export interface RelayConfig {
  name: string;
  baseUrl: string;
  apiKey: string;
}

// 常驻会话(§Team 的调度台):一个 CLI 进程活着吃多个回合,会话全程同一个。
// 跟 RunHandle 的区别只有两点 —— events 不会因为「一个回合说完」而结束(那是
// {kind:"turnEnd"}),以及多了 send/interrupt/close 这几根注入管子。
export interface ResidentHandle {
  sessionId: string;
  commandLine: string;
  events: AsyncIterable<AgentEvent>; // 直到 close()/kill() 才结束
  send(text: string): void; // 注入一条 user 消息(即时,无 tick)
  // 打断正在跑的回合。claude 的 stdin 注入是「排到回合结束才处理」,所以用户
  // 插话要先 interrupt 再 send 才有 codex 那种当场转向的手感(见 team/session.ts)。
  interrupt(): void;
  close(): void; // 优雅收尾:关 stdin,等它自己退出
  kill(): void; // 硬杀,走 killChild 三层击杀
}

// Hand-rolled adapter (DESIGN.md §7/§10: no Vercel AI SDK). Each CLI type gets
// one implementation that knows its flags, stream-json format, and resume scheme.
export interface AgentExecutor {
  readonly type: AgentType;
  readonly label: string; // e.g. "claude@local·opus"
  // 挂了供应商时,恢复命令要带的 env 前缀(token 已换成 <你的key> 占位符)。
  // 存进 sessions.relay_env —— 否则复制出来的命令会走 CLI 自己的官方账号。
  readonly relayEnvHint?: string;
  run(opts: RunOpts): RunHandle;
  // 常驻会话。只有支持中途注入的 CLI 实现它(v1 = claude);codex exec 没有注入
  // 通道,留 undefined —— 团队模式的「调度者」下拉据此过滤(§Team)。
  openResident?(opts: RunOpts): ResidentHandle;
  // Build the ready-to-paste resume command for a finished session (§13).
  resumeCommand(cwd: string, sessionId: string): string;
}
