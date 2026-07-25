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

// 挂在执行者上的中转站(§5)。非空时启动 CLI 前注入 base_url + key,顶掉 CLI
// 自己的官方登录账号。baseUrl 恒为根地址(不含 /v1),各 executor 按需自行补路径。
export interface RelayConfig {
  name: string;
  baseUrl: string;
  apiKey: string;
}

// Hand-rolled adapter (DESIGN.md §7/§10: no Vercel AI SDK). Each CLI type gets
// one implementation that knows its flags, stream-json format, and resume scheme.
export interface AgentExecutor {
  readonly type: AgentType;
  readonly label: string; // e.g. "claude@local·opus"
  // 挂了中转站时,恢复命令要带的 env 前缀(token 已换成 <你的key> 占位符)。
  // 存进 sessions.relay_env —— 否则复制出来的命令会走 CLI 自己的官方账号。
  readonly relayEnvHint?: string;
  run(opts: RunOpts): RunHandle;
  // Build the ready-to-paste resume command for a finished session (§13).
  resumeCommand(cwd: string, sessionId: string): string;
}
