import type { ChildProcess } from "node:child_process";
import type { AgentEvent, AgentType, ExecTarget } from "@harness/shared";
import type { RunTracePaths } from "./diagnostics.js";
import type { DetachedPaths } from "./detached.js";

export interface RunOpts {
  prompt: string;
  cwd: string;
  sessionId?: string; // resume an existing CLI session
  model?: string;
  extraArgs?: string[];
  trace?: RunTracePaths;
  // 非空 = 用「活得过 server 重启」的跑法：stdout/stderr 落到这几个文件而不是
  // 匿名管道（见 executors/detached.ts）。只有一次性 run() 该传；常驻会话
  // （openResident）必须保留可写的 stdin，不适用。ssh 目标会自动退回管道。
  detach?: DetachedPaths;
}

// A planned invocation: the resolved session id + exact command, plus a live
// event stream. The orchestrator records sessionId/commandLine for traceability
// before/while consuming the stream. `kill` terminates the
// underlying subprocess (manual stop) — the stream then ends like a normal exit.
export interface RunHandle {
  sessionId: string;
  commandLine: string;
  events: AsyncIterable<AgentEvent>;
  kill(): void;
  // 只有走了 detach 的这一轮才有：agent 的 pid + 已消费到的字节位置。
  // 调用方把它们存进 sessions，重启后据此找回并接管这个还活着的进程。
  detached?: { pid: number; committed: () => number };
}

// 挂在执行器上的供应商(§5)。非空时启动 CLI 前注入 base_url + key,顶掉 CLI
// 自己的官方登录账号。baseUrl 恒为根地址(不含 /v1),各 executor 按需自行补路径。
export interface RelayConfig {
  providerId: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  protocolConversionEnabled: boolean;
}

// 常驻会话(§Team 的调度台):一个**会话**吃多个回合,会话全程同一个。
// 跟 RunHandle 的区别只有两点 —— events 不会因为「一个回合说完」而结束(那是
// {kind:"turnEnd"}),以及多了 send/interrupt/close 这几根注入管子。
// 注意契约说的是「会话不断」而不是「进程不断」:claude 靠一个不退的进程做到,
// codex 靠 `exec resume <thread_id>` 一回合一进程做到,对调用方是一样的。
export interface ResidentHandle {
  sessionId: string;
  commandLine: string;
  events: AsyncIterable<AgentEvent>; // 直到 close()/kill() 才结束
  send(text: string): void; // 注入一条 user 消息(即时,无 tick)
  // 打断正在跑的回合。claude 的 stdin 注入是「排到回合结束才处理」,所以用户
  // 插话要先 interrupt 再 send 才有 codex 那种当场转向的手感(见 team/session.ts)。
  // codex 侧没有原生打断,interrupt 就是杀掉当前回合的进程。
  interrupt(): void;
  close(): void; // 优雅收尾:关 stdin,等它自己退出
  kill(): void; // 硬杀,走 killChild 三层击杀
}

// 从执行器 profile(agents 表一行)解析出来的构造参数 —— 单点在
// executors/index.ts 的 build(),专用类(claude/codex)与 GenericCliExecutor
// 都吃同一个形状,所以目录里的 factory 可以直接挂进来。
export interface ExecutorBuildOpts {
  /** profile 名,直接当 label(缺省时各执行器自己拼 `type@where·model`)。 */
  name?: string;
  model?: string;
  extraArgs?: string[];
  reasoningEffort?: string;
  speed?: "fast";
  /** 覆盖默认命令名(缺省用 spec.bins[0])。 */
  bin?: string;
  target?: ExecTarget;
  relay?: RelayConfig;
}

// Hand-rolled adapter (no Vercel AI SDK). Each CLI type gets
// one implementation that knows its flags, stream-json format, and resume scheme.
export interface AgentExecutor {
  readonly type: AgentType;
  readonly label: string; // e.g. "claude@local·opus"
  readonly target: ExecTarget;
  // 挂了供应商时,恢复命令要带的 env 前缀(token 已换成 <你的key> 占位符)。
  // 存进 sessions.relay_env —— 否则复制出来的命令会走 CLI 自己的官方账号。
  readonly relayEnvHint?: string;
  run(opts: RunOpts): RunHandle;
  // 重启后接管一个**还活着**的 agent 进程：把它的输出流接回本执行器自己的
  // parser。child 是 detached.ts 造的合成 ChildProcess（按 pid+offset 接回来的）。
  // 不实现 = 该执行器不支持接管，重启对它仍是「这一轮被打断」。
  // 放在接口上而不是让调用方按 agentType 去 switch parser —— 那等于在第三个
  // 地方再抄一张 CLI 名单（见 server/CLAUDE.md「执行器与模型」）。
  attach?(child: ChildProcess, opts: { sessionId: string; commandLine: string }): RunHandle;
  // 常驻会话。两种实现形态,契约相同(events 只在 close/kill 后结束):
  //   • claude = **进程级**常驻,一个进程吃多个回合(stdin 双向注入)
  //   • codex  = **会话级**常驻,每回合一个 `exec resume <thread_id>` 进程
  //     (它没有 stdin 注入通道;取舍见 executors/codex-resident.ts)
  // GenericCliExecutor 一律留 undefined —— 团队模式的「调度者」下拉据此过滤(§Team)。
  openResident?(opts: RunOpts): ResidentHandle;
  // Build the ready-to-paste resume command for a finished session (§13).
  resumeCommand(cwd: string, sessionId: string): string;
}
