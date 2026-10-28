// SCM 面板和项目 git 配置那一族 API 形状。
//
// 从 `apiTypes.ts` 拆出来的：那份原本把「文件 / 产物 / SCM / 验收 / 终端」全装在一起，涨到
// 701 行、过了 700 行上限。调用点照旧从 `api.ts` 引（那边整份再导出），拆分对调用方透明。
import type { FileWorkspaceRoot } from "./apiTypes.ts";
import type { AcceptanceAutoCommitDecision } from "@ash/shared/accept-workspace";
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
  acceptanceCommitBlock?: string | null;
  acceptanceAutoCommit?: AcceptanceAutoCommitDecision;
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
