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

/**
 * 一个回合**自己**的结局(`session_turns.outcome`)。进程最后一次怎么没的另记在会话行上
 * (`exitStatus` / `stoppedAs`),**两件事不混** —— 语义与「为什么不能拿退出码投影」写在
 * `server/src/db/schema-sessions.ts` 的 `sessionTurns.outcome` 上。
 */
export type TurnOutcome = "completed" | "failed" | "stopped";

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
  /**
   * 这一轮**自己**的权威结局(`session_turns.outcome`,服务端收口时写下的那一位)。
   *
   * 为什么要带出门:`exitStatus` 记的是**进程**最后一次怎么没的,它答不了「ash 判这一轮成
   * 没成」。被回合级停滞看门狗终止的那一轮正是两者分家的现场 —— 我们判它失败、区间记
   * failed,而被终止的进程往多半以 **exit 0** 收流(claude 走信号退出时是 `code ?? 0`)。
   * 重试入口照退出码判,就会在页面明写「本次续聊因上游连不上被自动终止」的同时,不给任何
   * 重跑按钮(审查 F2,已实测 409「上一回合不是异常结束」)。
   *
   * null/undefined = 不知道(回合还开着、存量行、收口那一下没写成、不提供它的快照来源)。
   * 读端一律按「没有明确失败结局」处理。
   */
  turnOutcome?: TurnOutcome | null;
  /**
   * 这条会话**此刻**还卡在上游等回话吗 —— 服务端那份权威状态(server/src/session-waiting.ts)
   * 按回合身份判出来的一位,不是数据库里的列。
   *
   * 为什么要带在会话行上:读端**不许从落盘产物反推**。正文先写 `.md`,要到下一条非正文事件
   * 才冲进 trace(single-run 与 team 的 pendingTraceText 都是这个缓冲),于是刷新重建照 trace
   * 的末条判,会在用户已经读到恢复回答之后继续写着「正在重试」,直到下一条事件才消(第 5 轮
   * 审查 F2,已实测)。直播那一路本来就按事件顺序维护同一件事,这一位让**初始快照**跟它共用
   * 同一个事实源。
   *
   * 缺省/undefined = 这份快照来自不提供它的地方(接力过来的远端快照、历史客户端),按「不在等」
   * 处理;ash 重启后在飞的那一轮也会落回这一档(见 session-waiting.ts 的开头)。
   */
  awaitingUpstream?: boolean;
  // 这条会话行累计的 token 用量(会话可复用,跨多个回合累加)。null = 这家 CLI
  // 不报账,或这条会话建在该功能之前 —— 两种都不该显示成 0。
  usage: TokenUsage | null;
  // `usage.turns` 里有几轮是哨兵唤醒起的(被叫醒看一眼,不是人说了一句话)。它们照样计费,
  // 所以照样算进轮数,这里只负责拆得开。缺省 = 这份快照不提供它,按 0 处理。
  monitorWakeTurns?: number;
  // 上下文水位:最近一次 API 调用装了多少进模型。**覆盖式**,跟上面的累计流水是两
  // 个概念(见 shared/src/usage.ts)。null = 没采到(那家 CLI 不给,或会话建在该功能
  // 之前)。
  context: ContextUsage | null;
}

/**
 * 一条**过程提示**:上游在重试、还在等回话。`GET /sessions/:id/notices` 的元素。
 *
 * 这些提示的正本在 `<sessId>.trace.jsonl`（`level:"notice"` 的 error 事件），所以执行过程
 * 面板里它们排在发生的那一步下面。独立出这个窄出口只为**读不动整份 trace 的消费者**:
 * 手机端每几秒重拉一次,而 trace 连工具的完整输入输出一起落盘,真实库里最大的一份 8 MB、
 * 对应的 `.md` 只有 8 KB。
 *
 * 这个出口给的只有两种(判据见 server 的 `session-waiting.ts`):**此刻还在等**的那几条,
 * 和**这一轮真收在失败上**时的失败现场。提示之后上游又吐了东西 = 这一轮正常往下走了,
 * 那条提示在这里就该消失 —— 手机端压根不渲染执行过程,没有「排在它发生的那一步下面」这个
 * 位置可给,留着只会堆在会话结尾,那正是要治的病。
 */
export interface SessionNotice {
  at: string; // 这条提示发生的时刻
  /** 它属于哪一回合:`sessions.turnStartedAt`,也就是 trace 的分组键。 */
  turnStartedAt: string;
  text: string;
}
