// 多人模式的共享类型与纯函数（docs/multi-user-plan.md）。
//
// 纯类型 + 几个两端都要用的判据函数(目录名 slug 校验、角色比较)。运行时函数只能走
// 子路径 `@ash/shared/multiuser` 引用 —— index.ts 不能转发运行时值(服务端直跑 .ts 源码)。

/**
 * 实例模式。`single` = 自用,一行鉴权都不拦,与本功能上线前完全一致;
 * `multi` = 多人,闸生效。**只能单向转换**(见 docs/multi-user-plan.md §二)。
 */
export type InstanceMode = "single" | "multi";

/** 实例级角色。管理员与初始管理员同权。 */
export type UserRole = "admin" | "member";

/** invited = 已开户、key 还没领;active = 正常;suspended = 被停用。 */
export type UserStatus = "invited" | "active" | "suspended";

/** 项目级角色。创建者自动成为项目管理员。 */
export type ProjectRole = "admin" | "member";

/** 用户资料的对外形状。**永远不含 keyHash**。 */
export interface UserView {
  id: string;
  name: string;
  role: UserRole;
  /** 根目录下这个人的目录名(slug)。设定后锁死。 */
  dirName: string;
  status: UserStatus;
  /** 派任务时注入 GIT_AUTHOR_NAME/GIT_COMMITTER_NAME。 */
  gitName: string;
  gitEmail: string;
  createdBy: string | null;
  createdAt: string;
  lastActiveAt: string | null;
  /** 这个人有没有待领取的邀请链接(管理员列表用,不含 token 本身)。 */
  hasPendingInvite?: boolean;
}

/** 项目成员条目(带上姓名,免得前端为每一行再查一次用户表)。 */
export interface ProjectMemberView {
  projectId: string;
  userId: string;
  name: string;
  role: ProjectRole;
  /** 实例管理员进任意项目时权限等同项目管理员,但他并不是成员行 —— 用它区分。 */
  implicit?: boolean;
  addedAt: string;
}

/**
 * `GET /api/auth/state` 的应答。前端整个 SPA 的第一道分叉靠它:
 * - `mode==="single"` → 直接进,零鉴权(现状)
 * - `needsSetup` → 首启向导
 * - `user===null` → 登录页
 */
export interface AuthState {
  mode: InstanceMode;
  /** 模式还没定过(首启)。single 模式选定后恒为 false。 */
  needsSetup: boolean;
  user: UserView | null;
  /** 多人模式的根目录(仅管理员可见完整值;普通用户看到的是自己那一层)。 */
  rootDir: string | null;
  /** 当前用户自己的目录绝对路径。single 模式为 null。 */
  homeDir: string | null;
}

/** 领取邀请链接时先看到的说明页数据(还没生成 key)。 */
export interface InviteInfo {
  name: string;
  role: UserRole;
  /** 实例名/机器名,让人确认自己点的是不是对的那台。 */
  host: string;
  expiresAt: string;
  /** 已作废/已过期/已领取 → 说明页直接给结论。 */
  invalid?: string;
}

/** 项目邀请链接的说明页数据。 */
export interface ProjectInviteInfo {
  projectId: string;
  projectName: string;
  role: ProjectRole;
  expiresAt: string | null;
  invalid?: string;
}

// ── 目录名(slug)校验 ──────────────────────────────────────────────────────
// 两端共用一份:前端即时提示,服务端是权威。规则刻意保守 —— 这串东西会变成磁盘上
// 一级真实目录名,还要拼进 worktree 路径,所以只放行 ASCII 小写字母/数字/连字符。
export const USER_DIR_NAME_HINT = "只能用小写字母、数字和连字符,2~32 个字符,不能以连字符开头或结尾";

const RESERVED_DIR_NAMES = new Set([
  // Windows 保留设备名(建目录会直接失败),外加几个 ash 自己要用的。
  "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
  "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
  "data", "node_modules", "git",
]);

export function userDirNameError(value: string): string | null {
  const name = (value ?? "").trim();
  if (!name) return "目录名必填";
  if (!/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])$/.test(name)) return USER_DIR_NAME_HINT;
  if (name.includes("--")) return "目录名里不能有连续的连字符";
  if (RESERVED_DIR_NAMES.has(name)) return `「${name}」是保留名,换一个`;
  return null;
}

/** 按姓名猜一个目录名(添加用户表单的默认值,用户可改)。猜不出就返回空串。 */
export function suggestDirName(displayName: string): string {
  const slug = (displayName ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 32)
    .replace(/-+$/, "");
  return userDirNameError(slug) ? "" : slug;
}

/** 按姓名生成默认 git 署名邮箱。域名固定用 `ash.local` —— 不是真邮箱,只求可归属。 */
export function suggestGitEmail(displayName: string): string {
  const local = suggestDirName(displayName) || "user";
  return `${local}@ash.local`;
}

// ── 权限判据 ────────────────────────────────────────────────────────────────
// 服务端是权威,但前端也要用同一份来决定「按钮画不画」。判据只有这一处。

export interface ActorLike {
  userId: string;
  role: UserRole;
}

export const isInstanceAdmin = (actor: ActorLike | null | undefined): boolean =>
  actor?.role === "admin";

/** 实例管理员进任意项目时权限等同项目管理员(§四)。 */
export const canManageProject = (
  actor: ActorLike | null | undefined,
  projectRole: ProjectRole | null | undefined,
): boolean => isInstanceAdmin(actor) || projectRole === "admin";

// ── 多人模式下可派发的 CLI ─────────────────────────────────────────────────
// 约束挂在「catalog 里有没有 relay 实现」上,不写死名单(§八)。服务端从 catalog
// 现算并经 `GET /api/agents/catalog` 报给前端;这里只留一句共用文案。
export const MULTI_USER_CLI_BLOCKED = (cli: string): string =>
  `多人模式不可用:${cli} 不支持第三方 key(接上供应商注入后自动解禁)`;
export const MULTI_USER_CLI_BLOCKED_HINT = MULTI_USER_CLI_BLOCKED("该 CLI");
export const MULTI_USER_NO_PROVIDER_HINT =
  "多人模式下必须给执行器挂一个供应商 —— 宿主机的 CLI 订阅已被隔离,不可借用";

// ── 个人 CLI 环境 ──────────────────────────────────────────────────────────

/** 一个 CLI 的个人配置目录状态(设置页「个人 CLI 环境」节)。 */
export interface PersonalCliEnv {
  agentType: string;
  /** 该 CLI 支不支持「整体取代配置目录」的环境变量。false = 个人级降级为仅项目级。 */
  supported: boolean;
  /** 不支持时说明原因(界面如实标注)。 */
  reason?: string;
  configDir: string | null;
  envVar: string | null;
  skills: PersonalSkill[];
  /** 个人全局指令文件(claude 是 CLAUDE.md,codex 是 AGENTS.md)。 */
  memoryFile: string | null;
  memoryName: string | null;
  hasMemory: boolean;
  plugins: string[];
}

export interface PersonalSkill {
  name: string;
  description: string;
}

// ── 配置导出 / 导入(§十)────────────────────────────────────────────────────

export const CONFIG_BUNDLE_KINDS = ["executors", "modes", "workflows", "reviewers", "providers"] as const;
export type ConfigBundleKind = (typeof CONFIG_BUNDLE_KINDS)[number];

export const CONFIG_BUNDLE_LABELS: Record<ConfigBundleKind, string> = {
  executors: "执行器",
  modes: "执行模式",
  workflows: "起手式",
  reviewers: "审查者",
  providers: "供应商(不含 API key)",
};

/**
 * 导出文件的形状。**永远不含 API key** —— 这份文件会在聊天工具里传,带 key 就是
 * 现成的泄露渠道(§十)。导入方自己补。
 */
export interface ConfigBundle {
  version: 1;
  exportedAt: string;
  exportedBy: string;
  executors?: unknown[];
  modes?: unknown[];
  workflows?: unknown[];
  reviewers?: unknown[];
  providers?: unknown[];
}

// ── 接力:目标机器按人(§十一)───────────────────────────────────────────────

/**
 * 一个用户自己配的接力目标。`hasKey` 而不是 key 本身 —— 对端 key 是凭证,
 * 待遇同 `project_git_credentials`:落库不回显。
 */
export interface UserHandoffTarget {
  id: string;
  name: string;
  url: string;
  /** 记住的对端机器指纹(sha256 hex);null = 还没配对过。 */
  peerFp: string | null;
  /** 「我在对端的账号 key」配没配。多人对端必须有,单人对端不需要。 */
  hasKey: boolean;
}

/** `/handoff/ping` 应答里新增的对端自述,让审批方知情(§十一)。 */
export interface HandoffPeerModeInfo {
  mode: InstanceMode;
  /** 多人实例才有;单人恒为 undefined。 */
  userCount?: number;
}
