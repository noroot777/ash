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
  /**
   * 这个人手上有没有 key。**不是** status 的同义词:管理面按它决定那一格该给
   * 「发邀请链接」(还没领到)还是「重置 key」(已经领到)—— 专属邀请链接是匿名
   * 领取入口,只发给还没有 key 的账号(store.ts `issueInvite`)。
   */
  hasKey: boolean;
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

/**
 * 姓名里**猜不出**目录名时的那句话。中文名(以及任何非 ASCII 名字)必然走到这里 ——
 * 只回一句「目录名必填」会让人对着一个自动填好过其它字段的表单发懵:填了姓名,
 * 怎么还说必填?所以要把「为什么猜不出」和「该填成什么样」一起说清。
 */
export const dirNameFromNameHint = (displayName: string): string =>
  `「${displayName}」里没有可以直接用作目录名的字母或数字（中文名很常见），请自己填一个英文目录名，比如 zhangsan。${USER_DIR_NAME_HINT}`;

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

/**
 * 按姓名生成默认 git 署名邮箱。域名固定用 `ash.local` —— 不是真邮箱,只求可归属。
 *
 * 姓名推不出 slug 时(中文名)退到 `dirName`,**不是**退到字面量 `user`:后者会让
 * 每一个中文名用户都拿到同一个 `user@ash.local`,而这一列存在的全部理由就是让
 * git log 认得出谁是谁(审查修订 B6)。dirName 唯一,退到它就还能分得开。
 */
export function suggestGitEmail(displayName: string, dirName?: string): string {
  const local = suggestDirName(displayName) || (dirName ?? "").trim() || "user";
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
//
// ⚠ 这几条只在**隔离**档下成立(`sharedHostCli === false`,§八之二)。共用宿主 CLI 时
// 派发闸整个不生效 —— 服务端的判据统一走 `auth/mode.ts` 的 `isHostCliIsolated()`,
// 别在别处按 `mode === "multi"` 另起一份。
export const MULTI_USER_CLI_BLOCKED = (cli: string): string =>
  `多人模式不可用:${cli} 不支持第三方 key(接上供应商注入后自动解禁)`;
export const MULTI_USER_CLI_BLOCKED_HINT = MULTI_USER_CLI_BLOCKED("该 CLI");
export const MULTI_USER_NO_PROVIDER_HINT =
  "多人模式下必须给执行器挂一个供应商 —— 宿主机的 CLI 订阅已被隔离,不可借用"
  + "(要几个人共用一份官方额度,让管理员去「设置 → 实例模式」把 CLI 额度改成共用)";
/**
 * 「这个 CLI 现在有哪些模型」在多人模式下不问宿主机(§八)。
 *
 * `grok models` 这类命令问的是**宿主机那个登录账号**,而那正是要抹掉的东西:执行器
 * 挂了供应商才跑得起来,模型候选也就该来自供应商的 `/v1/models`。
 * 共用宿主 CLI 那一档不适用 —— 那时宿主账号本来就是大家在用的账号。
 */
export const MULTI_USER_HOST_CLI_MODELS_HIDDEN = "多人模式不问宿主机 CLI";

// ── CLI 额度:隔离 / 共用(§八之二)──────────────────────────────────────────
// 多人模式下「宿主机 CLI 订阅彻底抹去」原本是写死的。实际有一类很常见的团队:几个人
// 合用一份官方订阅(Claude Max / ChatGPT Plus),对他们来说抹去宿主订阅等于整台机器
// 没法派活。所以它变成一个**实例级开关**,首启选、之后管理员随时能改。
//
// 两档的差别只有「宿主机那份登录态算不算数」,归属/可见性/权限一律不受影响。

export const HOST_CLI_ISOLATED_TITLE = "每人自带 key（隔离宿主机 CLI）";
export const HOST_CLI_SHARED_TITLE = "共用这台机器的 CLI 额度";

export const HOST_CLI_ISOLATED_DESC =
  "每人一个独立的 CLI 配置目录，宿主机上 claude / codex 的登录态谁也用不到。"
  + "执行器必须挂自己的供应商 key，各花各的钱。个人技能、个人全局 CLAUDE.md 也按人一份。";

export const HOST_CLI_SHARED_DESC =
  "所有人的任务都用这台机器上已经登录好的 CLI（~/.claude、~/.codex），"
  + "烧的是同一份官方订阅额度。适合几个人合买一份订阅的小团队。"
  + "代价是：额度、会话历史、CLI 全局配置和技能全都是共用的一份，个人 CLI 环境那一层不再生效。";

/** 换档之后旧的 CLI 会话为什么接不上(时间线里如实写一句)。 */
export const HOST_CLI_SWITCH_SESSION_NOTE =
  "CLI 额度设置改过了（共用宿主机 CLI ⇄ 每人自带 key），会话文件所在的配置目录也跟着换了，"
  + "旧的 CLI 上下文接不回来，这一轮从新会话开始。";


// ── 「这一轮会换执行器」的确认闸(§八「不静默替换」)──────────────────────────

/**
 * 一个任务身上可能被换掉的那几格执行器。
 * `task` = 单人任务顶层那一格;duet 不用它,两位讨论者各占一格;team 三个角色各占一格。
 */
export type ExecutorSlot = "task" | "voiceA" | "voiceB" | "lead" | "worker" | "reviewer";

export const EXECUTOR_SLOT_LABELS: Record<ExecutorSlot, string> = {
  task: "",
  voiceA: "讨论者 A",
  voiceB: "讨论者 B",
  lead: "调度者",
  worker: "执行者",
  reviewer: "审查者",
};

/**
 * 「我现在动它,这一格会被换成什么」。`GET /tasks/:id/executor-preflight` 返回一个
 * 列表:空数组 = 不会换,前端不弹。列表而不是单个对象,是因为 duet 有两格
 * (第 6 轮审查 P1:只看顶层那一格,duet 永远被预检成「无需确认」)。
 */
export interface ExecutorDowngradeItem {
  slot: ExecutorSlot;
  fromName: string;
  fromType: string;
  /** 原执行器属于谁(姓名);null = 那条执行器已经被删了。 */
  fromOwner: string | null;
  /** 本轮改用我的哪一个;null = 我这个类型压根没有默认执行器。 */
  toName: string | null;
}

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
  /** ash MCP 在这个个人配置目录里的登记状态。不支持个人配置目录的 CLI 为 null。 */
  ashMcp: PersonalAshMcp | null;
}

/**
 * 个人配置目录里的 ash MCP 登记。**缺了它 agent 就交不了卷** —— `complete_task` 那个
 * 工具压根不存在,活干完了也只会显示成失败(server/src/auth/user-cli-mcp.ts 顶部)。
 */
export interface PersonalAshMcp {
  configured: boolean;
  /** 实际登记名。历史安装可能仍是 `harness`。 */
  serverName: string | null;
  /** 没配上时的原因,界面原样显示。 */
  problem: string | null;
}

export interface PersonalSkill {
  name: string;
  description: string;
}

// ── 配置导出 / 导入(§十)────────────────────────────────────────────────────

export const CONFIG_BUNDLE_KINDS = ["providers", "executors", "workflows", "reviewers", "teamPresets", "cliEnv"] as const;
export type ConfigBundleKind = (typeof CONFIG_BUNDLE_KINDS)[number];

export const CONFIG_BUNDLE_LABELS: Record<ConfigBundleKind, string> = {
  executors: "执行器",
  teamPresets: "模式预设",
  workflows: "起手式",
  reviewers: "审查者",
  providers: "供应商(不含 API key)",
  cliEnv: "个人 CLI 环境(技能 + 全局指令)",
};

/**
 * 导出文件的形状。**永远不含 API key** —— 这份文件会在聊天工具里传,带 key 就是
 * 现成的泄露渠道(§十)。导入方自己补。
 */
export interface ConfigBundle {
  version: 1;
  exportedAt: string;
  /** 这份文件里装了哪几类(导入端据此显示勾选框)。 */
  kinds: ConfigBundleKind[];
  items: {
    providers?: ConfigProviderItem[];
    executors?: ConfigExecutorItem[];
    workflows?: ConfigWorkflowItem[];
    reviewers?: ConfigReviewerItem[];
    teamPresets?: ConfigNamedItem[];
    cliEnv?: ConfigCliEnvItem[];
  };
}

export interface ConfigProviderItem {
  name: string;
  protocol: string;
  baseUrl: string;
  model: string | null;
  protocolConversionEnabled: boolean;
  modelListMode: string | null;
  pinnedModels: string | null;
  context1mModels: string | null;
}

export interface ConfigExecutorItem {
  name: string;
  type: string;
  model: string | null;
  extraArgs: string | null;
  reasoningEffort: string | null;
  speed: string | null;
  configOverrides: string | null;
  isDefault: boolean;
  /** 按**名字**软引用供应商:对端的 id 必然不同,靠 id 引用一定悬空。 */
  providerName: string | null;
}

export interface ConfigWorkflowItem {
  builtinKey: string | null;
  name: string;
  description: string | null;
  def: string;
  disabled: boolean;
}

export interface ConfigReviewerItem {
  name: string;
  agentType: string;
  model: string | null;
  reasoningEffort: string | null;
}

export interface ConfigNamedItem {
  name: string;
  config: string;
}

export interface ConfigCliEnvItem {
  agentType: string;
  memory: string;
  skills: { name: string; body: string }[];
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
