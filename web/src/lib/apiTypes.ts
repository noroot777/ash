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
  UsageAccountingMark,
} from "@ash/shared";
import type { ScmChange, ScmDiffSource } from "./apiTypes.scm.ts";

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
    | Extract<import("@ash/shared").AgentEvent, { kind: "tool" }>
    // source/ref/path:一处正文引用的保存结果(见 shared/src/events.ts)。配对靠 source+ref,
    // 不靠文件名;path 缺省 = 这处引用确实没有副本,`lost: true` 进一步说明「字节当时读到了、
    // 写盘失败了」—— 那一处只能作废,不能拿现在的文件顶上。`pos` 是这处引用的文档节点身份
    // (服务端全文坐标),恢复补回的记录靠它排回文档顺序(见 turnImages)。
    | { kind: "attachment"; path?: string; source?: string; ref?: number; pos?: number; lost?: boolean }
    // level:"notice" = 这条不是故障,是过程里的一句提示(上游在重试、还在等回话)。展示端
    // 据此把它排成「提示」那一行而不是红色异常(见 task-detail/conversationSegments 的 auxEvent)。
    | { kind: "error"; message: string; level?: "notice" }
    // verifyRound：这一回合属于就地验证的第几轮（不是验证轮时缺省）。它是会话里
    // 唯一能把审查者的发言跟实现回合分开的信号——两者常跑在同一条会话上。
    | { kind: "run"; model: string | null; reasoningEffort: string | null; verifyRound?: number | null }
    // 这一回合的 token 账（服务端每轮至多写一条）。它不是执行过程里的一步，渲染时
    // 要单独摘出去，别混进「执行过程」那串事件。
    | { kind: "usage"; usage: TokenUsage; accounting?: UsageAccountingMark };
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
  git?: FileGitStatus | null;
};

/**
 * 文件树把 git status 的四组拍平成一个列表，每条都记住自己出自哪一组——「点开这个文件」
 * 才知道该比哪一段。冲突文件读的是工作树，所以后端把 `merge` 归进 `unstaged`。
 */
export type FileGitStatus = {
  changes: (Pick<ScmChange, "path" | "origPath" | "kind"> & { source: ScmDiffSource })[];
  truncated: boolean;
  error: string | null;
};

/** 输入框敲 `@` 时的一条文件候选（见 server/src/file-search.ts）。 */
export type FileSearchHit = {
  /** 相对工作区根、posix 分隔符的相对路径 —— 写进正文的就是它。 */
  path: string;
  name: string;
  dir: string;
  kind: "file" | "dir";
  /** .gitignore 挡着的（构建产物、本地数据…）。照样能选，只是一律排在未忽略的后面。 */
  ignored?: boolean;
};

export type FileSearchResult = {
  /** 没有可搜的工作目录时为 null（任务还没跑过、项目不是仓库），不是错误。 */
  root: { path: string } | null;
  /**
   * 这批结果是怎么来的：`dir` = 某个目录的直接子项（树），`search` = 全局搜。
   * **缺这个字段 = 服务端是旧版**（它不认 `?dir=`，把请求当搜索处理了）。
   */
  mode?: "search" | "dir";
  hits: FileSearchHit[];
  truncated: boolean;
  /** 还有匹配上的没列出来（被条数上限截了）。界面据此提示「再敲几个字缩小范围」。 */
  more?: boolean;
};

export type FileContent = {  path: string;
  name: string;
  size: number;
  mtime: string | null;
  kind: "text" | "image" | "pdf" | "binary";
  text: string | null;
  truncated: boolean;
  absPath: string;
  mime: string | null;
};

/** 读一份文件全文的返回。 */
export type TaskFileRead = {
  root: FileWorkspaceRoot;
  file: FileContent;
  /**
   * 这份文件当作网页渲染时的地址（不是网页就是 null）。
   *
   * **前端不能自己拼**：里面带着一段预览令牌，它是用来挡住第三方站点读工作区文件的那
   * 一道。细节在 server/src/task-page.ts 顶部。
   */
  pageUrl: string | null;
  /**
   * 这份网页在沙箱里跑不全时的说明（跑得全就是 null）。
   *
   * 沙箱对脚本一律不发 `ACAO`（否则页面能读走工作区里的文件），模块脚本因此加载不了。
   * 与其让用户对着一个空壳猜「是不是坏了」，不如把话说在前面并指向「在浏览器中打开」。
   */
  pageNotice: string | null;
};

/**
 * 「这是什么、有多大、git 怎么看它、现在能不能删」。
 *
 * 文件夹详情页和删除确认框读同一份：确认框要说的话（里面多少个文件、几个未跟踪、删了
 * 还找不找得回来）正是详情页要展示的东西。
 */
export type FileEntryOverview = {
  root: FileWorkspaceRoot;
  target: {
    path: string;
    name: string;
    kind: "dir" | "file";
    size: number;
    mtime: string | null;
    absPath: string;
    symlink: boolean;
  };
  /** 文件夹才有：递归统计。`truncated` = 数到上限停了，数字是「至少这么多」。 */
  stats: { files: number; dirs: number; bytes: number; truncated: boolean } | null;
  /** 文件夹才有：这一层的子项。 */
  entries: FileEntry[] | null;
  git: {
    repo: boolean;
    /** 被跟踪的文件数 >0 = 删了还能从提交里找回来。 */
    tracked: number;
    dirty: number;
    /** 未跟踪 = git 里没有任何备份的那些。 */
    untracked: number;
    untrackedSamples: string[];
    error: string | null;
  };
  /** 这台机器上删除的去向。`available:false` 时只剩永久删除那一档。 */
  trash: { available: boolean; label: string | null; reason: string | null };
  /** 非 null = 这个工作区此刻只读（归档 / 回落主仓 / 预览实例），删除按钮要禁掉。 */
  readOnly: string | null;
  /** 这个目录上有没有任务在跑——有就得先弹一次「明知故犯」的确认。 */
  busy: { running: boolean; reason: string | null };
};

export type FileDeleteResult = {
  ok: true;
  mode: "trash" | "permanent";
  path: string;
  name: string;
  kind: "dir" | "file";
  absPath: string;
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

/** 本机装着的一个编程 IDE。`id` 来自服务端写死的清单（server/src/openers/ide-catalog.ts）。 */
export type IdeApp = {
  id: string;
  name: string;
  /** 在哪儿找到它的：.app 路径或可执行文件路径。 */
  detail: string;
};

export type IdeProbe = {
  platform: string;
  ides: IdeApp[];
  note: string | null;
};

/**
 * 一次启动服务端究竟观察到了什么。`opened` = 启动器以 0 退出、它说交代完了;
 * `launching` = 盯完观察窗口它还活着,**没有任何确认** —— 界面不许据此说「已打开」。
 */
export type IdeLaunchStatus = "opened" | "launching";

// ── 生成物（产物面板）────────────────────────────────────────────────────────
// 「这个任务做出来了什么可以直接看的东西」。判据、三路线索和它们各自的可信区间都在服务端
// `task-artifacts.ts` 顶部，这里只是它的形状。

export type ArtifactKind = "image" | "video" | "audio" | "page" | "pdf";
/** 这份产物是从哪条线索认出来的：还没提交 / 已提交在任务分支上 / 被 .gitignore 挡着。 */
export type ArtifactOrigin = "working" | "committed" | "ignored";

/**
 * **这一条**的归属有多硬（服务端 `task-artifacts.ts` 的 `exactProof`）。
 *
 * - `exact` —— 确定：目录独占、任务分支上的提交动过它、或者落在一段**精确**区间里；
 * - `approx` —— 候选：只落在**估出来**的区间里（会话寿命、没收尾的回合），可能是别人在同一个
 *   目录里做的。
 *
 * 整份清单那一档（`ArtifactScopeKind`）说的是「这个目录是不是它独占的」,这一列说的是
 * 「**这一个**文件凭什么算它的」—— 共享目录里两种条目是混着的,只给页脚一个总数,用户看得见
 * 数目却看不出是哪几个（本轮审查第 5 条）。
 */
export type ArtifactConfidence = "exact" | "approx";

export type TaskArtifact = {
  /** 相对工作区根、posix 分隔符——跟文件树、文件查看器同一个主键。 */
  path: string;
  name: string;
  dir: string;
  kind: ArtifactKind;
  size: number;
  mtime: string | null;
  origin: ArtifactOrigin;
  confidence: ArtifactConfidence;
};

/**
 * 归属是怎么成立的：
 * - `exclusive` —— 工作区是这个任务（或它跟随的那个任务）独占的 worktree，目录本身就是
 *   证据，清单是**确定的**；
 * - `shared` —— 共享主仓，同一个目录先后乃至同时跑过别的任务，只能按「它在跑的那几段
 *   时间」认，清单是**候选**。界面必须把这点说出来，否则用户会把候选当确定。
 */
export type ArtifactScopeKind = "exclusive" | "shared";

export type TaskArtifactsResult = {
  /** 任务还没有工作目录时为 null——那是「还没有产物」，不是错误。 */
  root: FileWorkspaceRoot | null;
  artifacts: TaskArtifact[];
  truncated: boolean;
  /**
   * 任务第一次开跑的时刻；界面只用它判「跑过没有」。真正的判据是**任务在跑的那几段**
   * 的并集（共享工作区）或目录独占（worktree），判据本体在服务端 `task-artifact-scope.ts`。
   */
  since: string | null;
  scope: ArtifactScopeKind;
  /** 清单**可能不全**的原因（预算用满、目录读不动…）。空数组 = 读全了。 */
  incomplete: string[];
  /** 某一路线索读失败了。另外两路通常还有东西，所以不当致命错误。 */
  error: string | null;
};

// SCM 面板与项目 git 配置那一族（Scm* / ProjectGit* / PullStrategy）住在 apiTypes.scm.ts。
export type * from "./apiTypes.scm.ts";


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
  verification?: import("@ash/shared/workflow-policy").UnexecutedVerification;
  confirmationRequired?: "confirmUnverified";
  completedMerge?: { targetBranch: string; commit: string | null };
  completedTag?: string;
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
  /** 验收前置命令那三种失败（accept_gate_required/running/failed）带回来的现场。 */
  gate?: import("@ash/shared/accept-gate").AcceptGateView;
};

export type AcceptTaskResult = AcceptTaskSuccess | AcceptTaskFailure;

// 门禁那一份状态的形状住在 shared/src/accept-gate.ts：它跟 AcceptGateView、凭据语义
// （basis）是同一件事的几个面，分开写迟早会漂。这里只把它接到 api 的类型面上。
export type { AcceptGateBasis, AcceptGateBasisMode, AcceptGateState } from "@ash/shared/accept-gate";

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
  versionWarning?: string;
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

export type {
  LaunchAbandonment, LaunchResidueView, TerminalSessionInfo, TerminalEvent,
} from "./apiTerminalTypes.ts";

export type ReplyTaskResult =
  | { started: true }
  | { started: false; command: true; text: string; recorded: boolean }
  | { scheduled: true; message: ScheduledMessage };
