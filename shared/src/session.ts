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
  // 这一轮真正跑的执行器 profile 主键与生效覆盖值（`executor` 只是可改的展示名）。
  // null = 会话建在该功能之前，重跑只能退回按任务当前配置。
  executorId?: string | null;
  turnModel?: string | null;
  turnReasoningEffort?: string | null;
  model?: string | null; // execution metadata; historical rows are best-effort enriched by the API
  reasoningEffort?: string | null;
  worktreePath: string | null;
  branch: string | null;
  cwd: string | null; // the actual working directory this run executed in (truth, incl. scratch fallback)
  transcriptPath: string; // absolute path to the persisted Markdown transcript for this session
  cliSessionId: string | null; // the CLI's own session/thread id = core credential
  cliVersion?: string | null; // Codex rollout 记录的会话创建版本；其它 CLI / 旧格式为 null
  versionWarning?: string; // 会话级兼容性提醒（与当前已安装版本不同）
  resumeCommand: string | null; // ready-to-paste resume command
  commandLine: string | null; // full command invoked
  startedAt: string;
  turnStartedAt?: string | null; // latest turn on a reusable session row
  endedAt: string | null; // when this run finished (set with exitStatus); null while live
  exitStatus: number | null;
  // 这一轮**是被停的**（"canceled" / "paused"），不是它自己崩的。CLI 吃 SIGTERM 后按
  // signal 写非零退出，光看 exitStatus 两者一模一样；停止事实只在服务端内存里活一次。
  stoppedAs?: string | null;
  // 这一轮是旁路回合（审查 / 就地验证 / 斜杠命令），不是任务本体的执行。
  sideTurn?: boolean;
  // 这条会话行累计的 token 用量(会话可复用,跨多个回合累加)。null = 这家 CLI
  // 不报账,或这条会话建在该功能之前 —— 两种都不该显示成 0。
  usage: TokenUsage | null;
  // 上下文水位:最近一次 API 调用装了多少进模型。**覆盖式**,跟上面的累计流水是两
  // 个概念(见 shared/src/usage.ts)。null = 没采到(那家 CLI 不给,或会话建在该功能
  // 之前)。
  context: ContextUsage | null;
}
