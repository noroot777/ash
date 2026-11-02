import { sqliteTable, text } from "drizzle-orm/sqlite-core";

// 任务接力(handoff)的三张表:入站信任表 `handoff_peers`、自用模式的对端账号 key
// `handoff_local_peer_keys`,以及那把 key 的版本号 `handoff_local_key_revisions`。
//
// 从 `schema.ts` 拆出来的原因只有一个:那份到了 703 行,过了单文件上限(全局 CLAUDE.md),
// 而这三张表自成一件事 —— 「这条接力线的两头是不是原来那两台、带的是谁的账号」。写入端是
// `handoff-peers.ts` 与 `auth/handoff-scope.ts`,身份口径在 `handoff-identity.ts` 顶部。
//
// `schema.ts` 原样再导出这三张表,所以 `import { handoffPeers } from "./db/schema.js"` 照旧
// 能用,跟 `schema-monitors.ts`、`schema-sessions.ts` 那几份一个办法。

// 接力来源(入站方向的信任表):哪些机器可以把任务接力**进**本机。
//
// 主键是公钥指纹而不是地址 —— 地址会随 DHCP/网络环境漂,身份不会;而且换了地址还是
// 同一台机器,不该重新批准。存的全是公开信息(公钥、对端自述的主机名),泄露无害;
// 本机自己的私钥在 `<db>.identity.json`,见 handoff-identity.ts 顶部注释。
//
// 出站方向(「我要发的这台是不是原来那台」)不在这里,而是 app_settings.handoffTargets
// 每个目标上的 peerFp —— 那是「地址 → 期望身份」的绑定,和这张「身份 → 是否放行」是
// 两件事,合成一张表反而说不清一台只出不进(或只进不出)的机器该是什么状态。
export const handoffPeers = sqliteTable("handoff_peers", {
  fingerprint: text("fingerprint").primaryKey(), // sha256(公钥 SPKI DER) 小写 hex
  publicKey: text("public_key").notNull(), // base64(SPKI DER)
  // 对端自述的主机名,**不可信**,只用来在批准列表里帮人认出是哪台;身份永远看指纹。
  name: text("name").notNull().default(""),
  // pending = 来敲过门还没批;approved = 放行;blocked = 明确拒绝(不再进待批列表打扰)。
  status: text("status").notNull().default("pending"),
  firstSeenAt: text("first_seen_at").notNull(),
  lastSeenAt: text("last_seen_at").notNull(),
  approvedAt: text("approved_at"),
  // 多人模式下入站审批不是管理员专属(§十一 互信定位),所以必须记下是谁批的 ——
  // 一台机器被放行意味着它上面的人都能敲本机的门,事后要能问出「这是谁点的」。
  // 自用模式恒空(只有一个人)。
  approvedBy: text("approved_by"),
  // 这次配对申请代表本机的哪个账号:源机发申请时带的「我在对端的账号 key」认出来的人。
  // **一条申请只打扰这个人**,也只有他能接受。多人模式下认不出主人的申请压根不落库
  // (没有「无主申请」这回事,见 handoff-routes.ts 的 ping);空值只出现在单人时期或
  // 升级前落下的存量行上,那些行只有管理员看得见、能拒能删但批不了。判据见
  // handoff-peers.ts `peerAudience`。
  requestedByUserId: text("requested_by_user_id"),
  // 对端**自报**的实例模式(`single` / `multi:<人数>`)。自报的东西不做权限判据,
  // 只在批准界面上明示:批一台多人实例 = 它上面所有人都能经这条路进来(§十一)。
  peerMode: text("peer_mode").notNull().default(""),
  // 最近一次来访的地址,纯展示(帮人判断「这是不是我那台台式机」)。
  lastAddr: text("last_addr").notNull().default(""),
});

// 自用模式的「我在对端的账号 key」。**多人模式那份在 user_handoff_targets.peer_key**,
// 这张表只服务自用实例。
//
// 为什么不塞进 app_settings.handoffTargets(自用模式的目标机清单就住在那儿):那份设置
// 被 `GET /settings` 整份吐回前端,凭证进去就等于一个打开的网页拿走全部对端 key;而且
// 实例以后转多人时,它会当场变成所有人都读得到的公共设置。凭证的待遇统一照
// project_git_credentials:单独存,读侧只报 hasKey。
//
// 为什么自用实例也需要它:要不要 key 由**对端**的模式决定,不是本机。一台自用 ash 往
// 多人 ash 上接力同样要带「你在对端的账号 key」——2026-08-29 之前自用模式压根没有存
// 它的地方,预检失败的提示却让人去设置页补,那里根本没有输入框。
export const handoffLocalPeerKeys = sqliteTable("handoff_local_peer_keys", {
  // 归一后的目标机地址(去尾斜杠、小写),与 app_settings.handoffTargets 里的行按它对齐。
  url: text("url").primaryKey(),
  // 明文 key:要原样发给对端,没法只存哈希。GET 只报 hasKey。
  peerKey: text("peer_key").notNull(),
  // 保存这把 key 时通过签名核对的机器；旧数据没有归属证明，保持 null。
  peerFp: text("peer_fp"),
  updatedAt: text("updated_at").notNull(),
});

export const handoffLocalKeyRevisions = sqliteTable("handoff_local_key_revisions", {
  url: text("url").primaryKey(),
  revision: text("revision").notNull(),
});
