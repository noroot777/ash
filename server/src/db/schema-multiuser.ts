// 多人模式专属的那几张表(docs/multi-user-plan.md)。
//
// 从 `schema.ts` 拆出来的理由:这几张表的生命周期和其它表**完全错开** —— 自用模式下
// 它们恒为空,一行都不会写(那条路一行鉴权都不拦);而它们一旦有内容,读写判据全在
// `auth/` 那一层,和任务/会话那些表的读写点没有任何交集。混在一份文件里只有一个后果:
// 改鉴权的人要滚过 500 行任务/会话字段才找得到自己那张表。
//
// 两条轴,别混(判据分别在 auth/visibility.ts 与 auth/owned.ts):
//  · **共享轴**:项目和任务 —— 谁看得见,由 project_members 说了算。
//  · **私有轴**:执行器/供应商/起手式/随手记 —— 由各表自己的 owner_user_id 说了算。
//    那些表仍住在 `schema.ts`(它们在自用模式下照样用),这里只放多人模式独有的。
import { index, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// ── 多人模式(docs/multi-user-plan.md)────────────────────────────────────────
// 无注册模块,**key 即身份**:库里只存哈希,明文仅在领取/重生成时整屏展示一次。
// 自用模式下这张表恒为空(那条路一行鉴权都不拦)。
export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  role: text("role").notNull().default("member"), // admin | member
  // 根目录下这个人的目录名。**设定后锁死**,没有修改入口(§七)。
  dirName: text("dir_name").notNull(),
  status: text("status").notNull().default("invited"), // invited | active | suspended
  // key 的哈希(scrypt)。null = 还没领取过。明文永不落库。
  keyHash: text("key_hash"),
  // git 署名:spawn 任务时按 ownerUserId 注入 GIT_AUTHOR_*/GIT_COMMITTER_*。
  // 不注入的话多人协作的提交在 git log 里全是宿主机一个身份(§八 B6)。
  gitName: text("git_name").notNull().default(""),
  gitEmail: text("git_email").notNull().default(""),
  createdBy: text("created_by"),
  createdAt: text("created_at").notNull(),
  lastActiveAt: text("last_active_at"),
});

// web 登录会话。key 换 HttpOnly cookie,30 天滑动过期;登出 = 删行。
// token 同样只存哈希 —— 库被快照/备份时不该连活会话一起送出去。
export const userSessions = sqliteTable(
  "user_sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    tokenHash: text("token_hash").notNull(),
    createdAt: text("created_at").notNull(),
    lastSeenAt: text("last_seen_at").notNull(),
    expiresAt: text("expires_at").notNull(),
    userAgent: text("user_agent").notNull().default(""),
  },
  (t) => ({
    tokenIdx: uniqueIndex("user_sessions_token_idx").on(t.tokenHash),
    userIdx: index("user_sessions_user_idx").on(t.userId),
  }),
);

// 专属邀请链接(一人一链)。7 天未领取自动过期,管理员可随时作废/重发。
// 领取流程见 §五:说明页 → 点「领取」生成并展示 key → 点「我已保存」才作废链接。
export const userInvites = sqliteTable(
  "user_invites",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    tokenHash: text("token_hash").notNull(),
    createdBy: text("created_by"),
    createdAt: text("created_at").notNull(),
    expiresAt: text("expires_at").notNull(),
    // 非空 = 已经点过「我已保存」,链接作废。中途只是看过说明页不算。
    consumedAt: text("consumed_at"),
    revokedAt: text("revoked_at"),
  },
  (t) => ({
    tokenIdx: uniqueIndex("user_invites_token_idx").on(t.tokenHash),
    userIdx: index("user_invites_user_idx").on(t.userId),
  }),
);

// 项目成员关系。创建者建项目时自动插一行 role=admin。
// 实例管理员**不在这张表里**却对所有项目有项目管理员权限(§四),判据在 auth/visibility.ts。
export const projectMembers = sqliteTable(
  "project_members",
  {
    projectId: text("project_id").notNull(),
    userId: text("user_id").notNull(),
    role: text("role").notNull().default("member"), // admin | member
    addedBy: text("added_by"),
    addedAt: text("added_at").notNull(),
  },
  (t) => ({
    memberIdx: uniqueIndex("project_members_idx").on(t.projectId, t.userId),
    userIdx: index("project_members_user_idx").on(t.userId),
  }),
);

// 项目邀请链接:一条链接发群里,多个**已有账号**的用户点开即加入(§六)。
// 只能发普通成员角色 —— 管理员必须由项目管理员逐个指定。
export const projectInvites = sqliteTable(
  "project_invites",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    tokenHash: text("token_hash").notNull(),
    createdBy: text("created_by"),
    createdAt: text("created_at").notNull(),
    expiresAt: text("expires_at"), // null = 不过期(可随时作废)
    revokedAt: text("revoked_at"),
  },
  (t) => ({
    tokenIdx: uniqueIndex("project_invites_token_idx").on(t.tokenHash),
    projectIdx: index("project_invites_project_idx").on(t.projectId),
  }),
);

// 接力目标机器**按人**(§十一)。app_settings.handoffTargets 是自用模式那份;
// 多人模式下每个用户配自己的清单,还多带一样东西:「我在对端的账号 key」。
// 那是凭证,待遇同 project_git_credentials —— 落库不回显。
export const userHandoffTargets = sqliteTable(
  "user_handoff_targets",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    url: text("url").notNull(),
    peerFp: text("peer_fp"),
    // 对端账号 key 的**明文**(要原样发给对端,没法只存哈希)。GET 只报 hasKey。
    peerKey: text("peer_key").notNull().default(""),
    createdAt: text("created_at").notNull(),
  },
  (t) => ({ userIdx: index("user_handoff_targets_user_idx").on(t.userId) }),
);

// 「默认规则」里属于**个人面**的那几项(§八:worktree 默认、默认起手式)。形状照抄
// app_settings —— 同一个 key 在这里有行就盖过全局那份,没有就落回全局。
// 实例面的那几项(根目录、实例模式、技能扫描间隔、接力审批/加密/载荷上限)不进这张表:
// 它们描述的是**这台机器**的行为,一人一份没有意义。
export const userSettings = sqliteTable(
  "user_settings",
  {
    userId: text("user_id").notNull(),
    key: text("key").notNull(),
    value: text("value").notNull(),
  },
  (t) => ({ idx: uniqueIndex("user_settings_idx").on(t.userId, t.key) }),
);
