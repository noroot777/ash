// HTTP 层的响应形状。跟 shared 里的领域类型分开住：那边是「系统里的东西长什么样」，
// 这里是「这个接口这一次回了什么」（探测结果、验收落点、诊断快照…），只有前端读。
// 从 api.ts 里搬出来是因为那份到了 700 行上限；导入路径不变，api.ts 原样再导出一遍。
import type {
  AgentType,
  FreeWorkflowState,
  ScheduledMessage,
  TaskWorkspaceDiscardResult,
  TaskWorkspaceLeftover,
  TokenUsage,
} from "@harness/shared";

export type ChildWorkspaceLeftover = TaskWorkspaceLeftover & { taskId: string; title?: string };

export type TaskWorkspaceProbe = TaskWorkspaceLeftover & {
  /** 有 Git 残留的 children（团队执行者 / duet 搭档），删除会连行一起删，探测必须一并报。 */
  children?: ChildWorkspaceLeftover[];
};

export type DeleteTaskResult = {
  deleted: true;
  leftover: TaskWorkspaceLeftover | null;
  cleanup: TaskWorkspaceDiscardResult | null;
  /** 连删的全部行（父 + children）；前端按它同步本地任务集合。 */
  deletedTaskIds?: string[];
  childCleanups?: (TaskWorkspaceDiscardResult & { taskId: string })[];
  childLeftovers?: { taskId: string; leftover: TaskWorkspaceLeftover }[];
};

export type FreeWorkflowApiState = Omit<FreeWorkflowState, "merge">;

export type TaskCommit = { sha: string; subject: string; at: string };

export type SessionTraceEntry = {
  at: string;
  turnStartedAt: string;
  event:
    | { kind: "text"; text: string }
    | { kind: "thinking"; text: string }
    | { kind: "tool"; name: string; detail?: string }
    | { kind: "attachment"; path: string }
    | { kind: "error"; message: string }
    // verifyRound：这一回合属于就地验证的第几轮（不是验证轮时缺省）。它是会话里
    // 唯一能把审查者的发言跟实现回合分开的信号——两者常跑在同一条会话上。
    | { kind: "run"; model: string | null; reasoningEffort: string | null; verifyRound?: number | null }
    // 这一回合的 token 账（服务端每轮至多写一条）。它不是执行过程里的一步，渲染时
    // 要单独摘出去，别混进「执行过程」那串事件。
    | { kind: "usage"; usage: TokenUsage; accounting?: "incremental" };
};

export type GitOverview = {
  branches: string[];
  current: string | null;
  worktrees: {
    path: string;
    branch: string | null;
    head: string | null;
    detached: boolean;
  }[];
};

export type TaskDiffResult = {
  available: boolean;
  sourceBranch: string;
  targetBranch: string | null;
  mergeBase: string | null;
  diff: string;
  files: { path: string; additions: number | null; deletions: number | null }[];
  truncated: boolean;
  limitBytes: number;
  reason?: string;
};

/** 任务实际在哪干活。服务端只读地解析，绝不为了看文件而新建 worktree。 */
export type FileWorkspaceRoot = {
  path: string;
  branch: string | null;
  gitRepo: boolean;
  source: "session" | "worktree" | "repo";
};

export type FileEntry = {
  name: string;
  path: string;
  kind: "dir" | "file";
  size: number;
  mtime: string | null;
  ignored: boolean;
  symlink: boolean;
};

export type FileListing = {
  root: FileWorkspaceRoot;
  path: string;
  entries: FileEntry[];
  truncated: boolean;
};

export type FileContent = {
  path: string;
  name: string;
  size: number;
  mtime: string | null;
  kind: "text" | "image" | "pdf" | "binary";
  text: string | null;
  truncated: boolean;
  absPath: string;
  mime: string | null;
};

/** 本机上能打开某个文件的一个应用。`match` 说明它凭什么被列进来。 */
export type AppOpener = {
  id: string;
  name: string;
  detail: string;
  match: "extension" | "type" | "generic";
  isDefault: boolean;
};

export type OpenerProbe = {
  platform: string;
  canReveal: boolean;
  apps: AppOpener[];
  note: string | null;
};

export type AcceptTaskWarning = {
  reason: "temporary_cleanup_failed";
  message: string;
  worktreePath: string;
};

export type AcceptTaskSuccess = {
  accepted: true;
  taskId: string;
  status: string;
  /** 中途关口放行不是验收，stage 会被清回「进行中」 */
  stage: "accepted" | null;
  kind: "already_accepted" | "in_place" | "isolated_worktree" | "marked_only" | "gate_released";
  sharedWorkersAccepted?: number;
  targetBranch?: string;
  merge?: string;
  worktreePath?: string;
  worktreeRemoved?: boolean;
  branch?: string;
  branchDeleted?: boolean;
  warnings?: AcceptTaskWarning[];
  /** 「点头之后」那一段（发布脚本之类）跑得怎么样；线上没写这一段就没有这个字段 */
  tail?: { ok: boolean; step?: string; reason?: string };
};

export type AcceptTaskFailure = {
  accepted: false;
  taskId: string;
  reason: string;
  error: string;
  status?: string;
  sourceBranch?: string;
  targetBranch?: string | null;
  conflictFiles?: string[];
  dirtyFiles?: string[];
  targetPath?: string;
  worktreePath?: string;
  phase?: "initial" | "before_accept" | "before_merge" | "before_cleanup";
  inFlightTasks?: {
    id: string;
    title: string;
    status: string;
    role: "task" | "shared_worker";
  }[];
  warnings?: AcceptTaskWarning[];
  conflictHandoff?: { notified: boolean; message: string };
};

export type AcceptTaskResult = AcceptTaskSuccess | AcceptTaskFailure;

// 人工强制通过一站「自动验证」之后的落点：签字之后线可能停在下一道关口、又开了一轮
// 验证、也可能直接合并完了，所以回的是**推进之后**的游标与验收阶段。
export type VerifyOverrideResult = {
  forced: true;
  taskId: string;
  station: string;
  workflowAt: string | null;
  stage: string | null;
  /** 签字落下了，但这一站之后那一段没跑完 —— 如实说，别报成一句「已放行」。 */
  advanceError?: string;
};

export type DetectedCli = {
  key: string;
  name: string;
  description: string;
  bins: string[];
  docsUrl: string;
  installCommand: string;
  type?: AgentType;
  bin: string;
  available: boolean;
  path: string | null;
  version: string | null;
  resident: boolean;
};

export type CuaProcess = { pid: number; ppid: number; command: string };

export type TeamCuaStatus = {
  taskId: string;
  current: {
    checkedAt: string;
    detected: boolean;
    processes: CuaProcess[];
    message: string;
    sideEffect: string;
  };
};

export type TerminalSessionInfo = {
  id: string;
  projectId: string;
  cwd: string;
  shell: string;
  name: string;
};

export type TerminalEvent =
  | { seq: number; type: "data"; data: string }
  | { seq: number; type: "exit"; exitCode: number; signal?: number };

export type ReplyTaskResult =
  | { started: true }
  | { scheduled: true; message: ScheduledMessage };
