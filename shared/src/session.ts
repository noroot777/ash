import type { AgentType } from "./index.ts";
import type { ContextUsage, TokenUsage } from "./usage.ts";

// "lead" = 团队任务的常驻调度台会话（一个进程跑很多回合，见 server/src/team）；
// 执行者自己的会话仍是 "single"。
export type SessionRole =
  | "single"
  | "lead"
  | "voiceA"
  | "voiceB"
  | "implementer" // legacy: retained so historical sessions still decode
  | "reviewer"; // 独立审查会话（自由工作流复用，也兼容历史记录）

export interface Session {
  id: string;
  taskId: string;
  role: SessionRole;
  agentType: AgentType;
  executor: string; // executor profile name
  model?: string | null; // execution metadata; historical rows are best-effort enriched by the API
  reasoningEffort?: string | null;
  target: string; // "local" | "ssh:host"
  worktreePath: string | null;
  branch: string | null;
  cwd: string | null; // the actual working directory this run executed in (truth, incl. scratch fallback)
  transcriptPath: string; // absolute path to the persisted Markdown transcript for this session
  cliSessionId: string | null; // the CLI's own session/thread id = core credential
  resumeCommand: string | null; // ready-to-paste resume command
  commandLine: string | null; // full command invoked
  startedAt: string;
  turnStartedAt?: string | null; // latest turn on a reusable session row
  endedAt: string | null; // when this run finished (set with exitStatus); null while live
  exitStatus: number | null;
  // 这条会话行累计的 token 用量(会话可复用,跨多个回合累加)。null = 这家 CLI
  // 不报账,或这条会话建在该功能之前 —— 两种都不该显示成 0。
  usage: TokenUsage | null;
  // 上下文水位:最近一次 API 调用装了多少进模型。**覆盖式**,跟上面的累计流水是两
  // 个概念(见 shared/src/usage.ts)。null = 没采到(那家 CLI 不给,或会话建在该功能
  // 之前)。
  context: ContextUsage | null;
}
