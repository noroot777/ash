// 只有服务端 API 才会返回的形状（shared 里没有对应类型的那些）。
// 从 `api.ts` 搬出来的，调用点照旧从 `api.ts` 引：那边整份再导出。
import type {
  AgentType,
  FreeWorkflowState,
  ScheduledMessage,
  Session,
  Task,
  TaskWorkspaceDiscardResult,
  TaskWorkspaceLeftover,
  TokenUsage,
} from "@ash/shared";

export type ChildWorkspaceLeftover = TaskWorkspaceLeftover & { taskId: string; title?: string };

/**
 * server 跑在哪台机器上（`GET /api/host`）。路径提示一律按它给 —— 浏览器所在的系统
 * 不算数：用 Windows 上的浏览器连 mac 上的 ash 是正常用法，项目目录在服务端。
 */
export type HostInfo = {
  /** `process.platform` 原文，如 `darwin` / `win32` / `linux`。 */
  platform: string;
  /** 路径分隔符（`\` 或 `/`）。 */
  sep: string;
  /** 服务端当前用户的家目录绝对路径。 */
  home: string;
  /**
   * 这次请求能不能弹系统文件选择窗口。窗口弹在**服务端桌面**上，所以远程浏览器
   * （Tailscale / 局域网）拿到的是 `false` —— 那时按钮根本不该出现。
   * 老服务端没有这个字段，读到 `undefined` 按「不能」处理。
   */
  canPickDirectory?: boolean;
};

/** `POST /api/host/pick-directory` 的结果。用户点了取消不是错误。 */
export type DirectoryPick = { path: string; cancelled: false } | { path: null; cancelled: true };

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

export type RemoteTaskSnapshot = {
  task: Task;
  sessions: Session[];
  persisted: Array<{ session: Session; output: string; trace: SessionTraceEntry[] }>;
  target: { name: string; url: string };
  returnAvailable: boolean;
};

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
  /** `origPath` 是改名/复制的来源。要单独再 diff 这一个文件时，两头路径都得给 git。 */
  files: { path: string; additions: number | null; deletions: number | null; origPath: string | null }[];
  truncated: boolean;
  limitBytes: number;
  reason?: string;
};

/**
 * 上面那份清单里点开的**一个**文件。
 *
 * 不在前端把 `TaskDiffResult.diff` 切开就算：那份文本是**带上限**读的（1 MB），大改动里
 * 排在后面的文件在它里面根本不存在，切出来会是空的。单独问一次后端，谁都不会落空。
 */
export type TaskFileDiffResult = {
  available: boolean;
  path: string;
  origPath: string | null;
  diff: string;
  truncated: boolean;
  limitBytes: number;
  binary: boolean;
  /** `available:false` 时的机器码。人话在 `scm/scmModel.ts` 的 `branchDiffReason`。 */
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

// ── 工作区源代码管理（SCM 面板）─────────────────────────────────────────────
// 跟 `TaskDiffResult` 是两回事：那个是任务分支 vs 合入目标的只读 diff（给审查用），
// 这里是**工作目录此刻**的暂存区/未暂存/未跟踪/冲突。字段与服务端 `git-status.ts`
// 的同名类型一一对应。

export type ScmChangeKind =
  | "modified" | "added" | "deleted" | "renamed" | "copied" | "typechange" | "unmerged" | "untracked";

export type ScmGroupId = "merge" | "staged" | "unstaged" | "untracked";
export type ScmDiffSource = "staged" | "unstaged" | "untracked";

export type ScmChange = {
  path: string;
  origPath: string | null;
  kind: ScmChangeKind;
  conflict: string | null;
  /**
   * 这一条是**嵌套 Git 仓库**（自带 `.git` 的子目录）。列得出、看得见，但暂存/丢弃/提交
   * 对它都不成立（后端一律摘出去，见 `git-workspace-ops.ts` 的 `withoutNested`），
   * 所以面板上不给它出操作按钮，只说清楚为什么。
   */
  nested: boolean;
};

export type ScmBranchInfo = {
  head: string | null;
  detached: boolean;
  oid: string | null;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
};

export type PullStrategy = "ff-only" | "merge" | "rebase";

/** 项目主仓的一条本地分支。`worktree` 非空 = 正被别的工作区检出着，切不过去。 */
export type ProjectGitBranchRow = {
  name: string;
  current: boolean;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  gone: boolean;
  worktree: string | null;
};

/** 项目**主仓**的 git 状态。跟 `ScmStatus` 的区别是尺度：那份说的是某个任务的工作目录。 */
export type ProjectGitState = {
  isRepo: boolean;
  root: string;
  branch: ScmBranchInfo;
  dirty: { staged: number; unstaged: number; untracked: number; merge: number };
  operation: ScmStatus["operation"];
  remotes: string[];
  branches: ProjectGitBranchRow[];
};

export type ProjectGitResult = { ok: true; message: string; state: ProjectGitState };

// ── 项目的 git 配置（设置页那一节）─────────────────────────────────────────
// 跟上面的 ProjectGitState 是两回事：那个是「仓库现在什么状态」，这个是「这个项目
// 用谁的身份、什么凭证去连远端」。

export type GitConfigValue = {
  value: string | null;
  /** `local` = 写在这个仓库的 .git/config 里；`inherited` = 来自 --global/--system。 */
  scope: "local" | "inherited" | null;
};

export type GitRemoteInfo = { name: string; url: string; https: boolean };

export type ProjectGitIdentity = {
  isRepo: boolean;
  userName: GitConfigValue;
  userEmail: GitConfigValue;
  sshKeyPath: string | null;
  sshCommand: GitConfigValue;
  remotes: GitRemoteInfo[];
};

/** 令牌**永远不会**出现在这里：存进去就取不回来，前端只知道「配了、是谁、什么时候」。 */
export type ProjectGitCredentialView = {
  username: string;
  configured: true;
  updatedAt: string;
};

export type ProjectGitConfig = {
  identity: ProjectGitIdentity;
  credential: ProjectGitCredentialView | null;
};

/** 只带上的字段才会被写；**空串 = 清掉本仓设置、回去跟着全局走**，不是「写个空值」。 */
export type ProjectGitConfigPatch = {
  userName?: string;
  userEmail?: string;
  sshKeyPath?: string;
};

export type ScmCommit = {
  sha: string;
  shortSha: string;
  subject: string;
  author: string;
  at: string;
};

export type ScmStatus = {
  branch: ScmBranchInfo;
  merge: ScmChange[];
  staged: ScmChange[];
  unstaged: ScmChange[];
  untracked: ScmChange[];
  truncated: boolean;
  operation: "merge" | "rebase" | "cherry-pick" | "revert" | null;
};

export type ScmOverview = {
  root: FileWorkspaceRoot;
  /**
   * 这个**工作目录**里此刻有没有任务在跑——共用它的其它任务（团队调度台、跟随它的
   * 兄弟执行者、各自的审查任务，以及同一个仓库被登记成另一个项目时那边的就地任务）
   * 算在内，不只是当前这一个。写操作要不要弹「agent 正在写这个目录」的确认，看它。
   */
  taskRunning: boolean;
  /**
   * 这个工作目录**不能写**的理由（能写就是 null）。归档任务、以及独立工作区还没建出来
   * 因而回退到项目主仓的任务都在此列——后端一律 409，面板据此收起写按钮并把这句话摆出来。
   * 跟 `taskRunning` 不是一回事：那个是「确认一下就能干」，这个是冻结，force 也不解。
   */
  readOnly: string | null;
  status: ScmStatus;
  commits: ScmCommit[];
  /** 仅含远端名；URL 可能带凭据，不下发。旧服务端响应可能暂时缺少这个字段。 */
  remotes?: string[];
};

export type ScmFileDiff = {
  path: string;
  origPath: string | null;
  source: ScmDiffSource;
  diff: string;
  truncated: boolean;
  limitBytes: number;
  binary: boolean;
};

/**
 * 写操作的统一返回：各自的结果字段 + 一份**刷新后**的状态。
 * 状态随写操作一起回来，面板不必再补一次 GET，也就没有「按钮已响应、列表还是旧的」那一帧。
 *
 * `status` 是**可选**的：写操作已经落地之后，那次只为显示服务的状态读取自己也可能失败，
 * 后端不会为此把成功报成失败（见 `scm-routes.ts` 写外壳）。缺了就自己补一次刷新。
 */
export type ScmWriteResult = {
  ok: true;
  affected: number;
  /** 这次**没**照做的那部分（目前只有嵌套仓）——成功提示要连它一起说。 */
  note?: string;
  status?: ScmStatus;
};

export type ScmCommitResult = {
  ok: true;
  /** 提交号；`git commit` 成功之后补读元数据失败时是 null——提交仍然算数。 */
  sha: string | null;
  subject: string;
  /** 提交成功、但之后某一步只为显示服务的读取失败了的实话。 */
  warning?: string;
  /** 预暂存时跳过的那部分——用户以为它们进了这次提交。 */
  note?: string;
  status?: ScmStatus;
};

export type ScmPushResult = {
  ok: true;
  remote: string;
  branch: string;
  published: boolean;
  /** 推送前相对 upstream 的领先提交数；首次发布时无法可靠计算。 */
  pushed: number | null;
  status?: ScmStatus;
};

/**
 * 批量操作跑到一半失败时，409 响应体里额外带的东西。
 *
 * `done` 里的路径**已经生效了**——丢弃未跟踪文件时它们是真的被删掉了，没有 reflog 也没有
 * stash。所以这份清单不是调试信息，是必须让用户看到的结果；面板据此在收到错误之后继续
 * 显示「哪些已经动了、哪些还没动」，而不是只弹一句「失败」了事。
 */
export type ScmWritePartial = {
  done: string[];
  pending: string[];
};

export type ScmErrorBody = {
  error?: string;
  needsForce?: boolean;
  partial?: ScmWritePartial;
  /** 部分生效时一并回来的刷新后状态。 */
  status?: ScmStatus;
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
  /** 服务端已按**它自己那台机器**的平台选好的安装命令；空串 = 本平台没有官方版本。 */
  installCommand: string;
  /** 本平台特有的前提/限制（目前只有 Windows 侧会有）。 */
  platformNote?: string;
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
    // false = 这个平台上没有 computer-use 旁路会话这套机制（macOS 独有），
    // 不是「查过、是干净的」。老服务端不带这个字段，按 true 处理。
    applicable?: boolean;
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
