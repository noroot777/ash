// ── IM 通道（飞书）─────────────────────────────────────────────────────────────
// 方案见 docs/feishu-integration.md。这几张表只住在 server 本地：preview-seed 是显式白名单
// （preview-seed.ts），im_* 天然不会被复制进预览库 —— 预览实例拿不到凭证、也不该替机主发卡。
//
// 凭证（App Secret）不在这里，在库文件旁的 `<db>.feishu.json`（im/config.ts）。
//
// 几张表的分工：
//   im_bindings    飞书身份 ↔ ash 身份。键是 (channel, app_id, open_id)：换应用就要重绑，有意为之。
//   im_bind_codes  网页发起的一次性绑定码（只存哈希）。码由飞书侧认领、再回网页确认，两步都留痕。
//   im_outbox      发出去的每一张卡/每一条消息。推送由对账驱动（im/reconcile.ts），这张表就是
//                  「已经推过什么、现在长什么样」的唯一记录 —— 飞书回读 2.0 卡片只给降级文字，
//                  卡片当前的样子只能自己记。行 id 兼作发消息的 uuid，崩溃后重发不会推两条。
//   im_actions     按钮信封。按钮 value 里只放信封 id；收件人、代次、过期、是否用过都在库里，
//                  重启后也不能重放。
//   im_inbound     入站消息与回调的去重键 + 处理进度（助手房间的回复要等它跑完再发回去）。
//   im_groups      群 ↔ 项目的绑定（群里的 @ 进项目群聊房间；卡片要不要改推到群里）。
//   im_group_rooms 群里每个说话人各自的那间项目群聊房间（多人模式下群聊房间是创建者私有的，
//                  所以一人一间；自用模式只有机主一人，user_key 为空串）。
//   im_outcomes    每个任务上次对账时看到的结局（验收合并了哪一版、门禁最近一次的结果）。通知按它的
//                  变化发（im/outcomes.ts），不看决策卡收没收起。
//   im_meta        水位线、本月调用计数、机器人自己的 open_id 等零散键值。
import { sql } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import type { Client } from "./node-sqlite-client.js";

export const imBindings = sqliteTable("im_bindings", {
  channel: text("channel").notNull(),
  appId: text("app_id").notNull(),
  openId: text("open_id").notNull(),
  /** ash 账号。自用模式下为空（= 机主）。 */
  userId: text("user_id"),
  /** 单聊会话 id：首次收到这个人的单聊消息时记下，发消息仍按 open_id 发。 */
  chatId: text("chat_id"),
  /** 这个人在飞书里说话落进的助手房间（kind=assistant）。房间被网页删掉后会重建。 */
  assistantRoomId: text("assistant_room_id"),
  /** 「当前项目」：助手派任务、/new 建任务落在哪个项目。 */
  projectId: text("project_id"),
  boundAt: text("bound_at").notNull(),
}, (t) => [
  primaryKey({ columns: [t.channel, t.appId, t.openId] }),
  index("im_bindings_user").on(t.userId),
]);

export const imBindCodes = sqliteTable("im_bind_codes", {
  id: text("id").primaryKey(),
  /** 发起绑定的 ash 账号；自用模式为空串（主键/唯一索引里 NULL 不相等，所以不用 NULL）。 */
  owner: text("owner").notNull(),
  /** user = 绑定本人的飞书账号（在单聊里发码）；group = 把一个群绑到项目（在群里 @ 机器人发码）。 */
  purpose: text("purpose").notNull(),
  /** purpose=group：要绑到哪个项目。 */
  projectId: text("project_id"),
  codeHash: text("code_hash").notNull(),
  /** open → claimed（飞书里有人发来了这串码）→ confirmed / rejected；过期按 expires_at 判。 */
  state: text("state").notNull(),
  claimedAppId: text("claimed_app_id"),
  claimedOpenId: text("claimed_open_id"),
  claimedChatId: text("claimed_chat_id"),
  /** purpose=group：认领时查到的群名。 */
  claimedName: text("claimed_name"),
  claimedAt: text("claimed_at"),
  createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at").notNull(),
}, (t) => [index("im_bind_codes_owner").on(t.owner), index("im_bind_codes_hash").on(t.codeHash)]);

export const imOutbox = sqliteTable("im_outbox", {
  id: text("id").primaryKey(),
  channel: text("channel").notNull(),
  appId: text("app_id").notNull(),
  receiveType: text("receive_type").notNull(),
  receiveId: text("receive_id").notNull(),
  /** 收件人（单聊的 open_id）。群消息为空 —— 群卡片上的按钮按点击人的绑定校验。 */
  recipientOpenId: text("recipient_open_id"),
  taskId: text("task_id"),
  /** question / accept / failed / dispute / duet_gate / done / gate / summary / reply / notice / confirm / online */
  kind: text("kind").notNull(),
  /** 这张卡代表的那一「代」事项，如某一轮提问的代次。同一收件人、同一任务、同一 kind 下唯一。 */
  subject: text("subject").notNull(),
  /** 回复哪条飞书消息（助手回复、话题里的回帖）。 */
  replyTo: text("reply_to"),
  replyInThread: integer("reply_in_thread").notNull().default(0),
  msgType: text("msg_type").notNull(),
  /** 卡片/消息当前的内容（JSON）：库里这份就是「飞书上应该长的样子」，发出去的和它不一样就要改卡。 */
  content: text("content").notNull(),
  /**
   * 决策卡：渲染这张卡用到的输入（标题、项目、只推标题、深链、这一件事的内容）的指纹。代次只说明
   * 「还是那件事」，说明不了「卡片内容还对不对」—— 设置改了、标题改了，代次不变、内容要重渲染。
   */
  renderKey: text("render_key"),
  /** 这份内容凭什么能给这个收件人看（JSON，im/scope.ts）：发出、改卡、回调回执三个出口都按它现算资格。 */
  scope: text("scope"),
  /** 只推标题版的内容：项目此刻设成了只推标题时，出口换成这一份（content 里带着答复原文、出错原因这类细节）。 */
  brief: text("brief"),
  /** pending → sent；决策类卡片在别处处理掉后 → resolved；重试耗尽 → dead。 */
  state: text("state").notNull(),
  messageId: text("message_id"),
  /**
   * 库里的 content 要不要改到飞书那张卡上：pending / result（回写用户刚点的那一下，额度见底也照发）/
   * acking（结果卡随卡片回调回执带回去了、还没确认送到 —— next_at 到期没确认就当 result 改一次）；
   * done / skipped / failed 是结果。
   */
  patchState: text("patch_state"),
  resolution: text("resolution"),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  nextAt: text("next_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  sentAt: text("sent_at"),
  resolvedAt: text("resolved_at"),
}, (t) => [
  // 应用要在键里：换了应用、同一个群，旧应用那行不能挡住新应用的卡。task_id 为空的行（命令回执、
  // 助手回复）也要去重 —— SQLite 唯一索引里 NULL 互不相等，所以按空串算。
  uniqueIndex("im_outbox_dedupe").on(t.appId, t.receiveId, sql`coalesce(${t.taskId}, '')`, t.kind, t.subject),
  index("im_outbox_task").on(t.taskId),
  index("im_outbox_state").on(t.state),
  index("im_outbox_message").on(t.messageId),
]);

export const imActions = sqliteTable("im_actions", {
  id: text("id").primaryKey(),
  outboxId: text("outbox_id").notNull(),
  taskId: text("task_id"),
  action: text("action").notNull(),
  payload: text("payload").notNull().default("{}"),
  /** 只有这个 open_id 点得动；群卡片为空串，改按点击人的绑定校验。 */
  recipientOpenId: text("recipient_open_id").notNull(),
  /** 发卡那一刻事项的代次；点击时与当前代次不一致就拒绝（旧卡答不中新问题）。 */
  generation: text("generation").notNull(),
  expiresAt: text("expires_at").notNull(),
  /** 被点下、正在执行（result 为空）或已办完（result 有值）。动作没做成会放回成空。 */
  usedAt: text("used_at"),
  /** 占用它的那个进程（envelopes.ts 的 CLAIMER）。重启后占用者不在了，由 actions.ts 的 recover 收尾。 */
  claimedBy: text("claimed_by"),
  result: text("result"),
  /** 办完了、还没记进任务时间线的那一句（和结局同一个事务写下；记上了清空，重启后补记）。 */
  audit: text("audit"),
  createdAt: text("created_at").notNull(),
}, (t) => [index("im_actions_outbox").on(t.outboxId)]);

export const imInbound = sqliteTable("im_inbound", {
  /** `msg:<message_id>` 或 `evt:<event_id>`（按钮回调没有自己的 message_id）。 */
  id: text("id").primaryKey(),
  channel: text("channel").notNull(),
  appId: text("app_id").notNull(),
  openId: text("open_id"),
  chatId: text("chat_id"),
  chatType: text("chat_type"),
  /** bind / answer / reply / command / assistant / group / callback / denied / ignored */
  kind: text("kind").notNull(),
  taskId: text("task_id"),
  roomId: text("room_id"),
  /** 实际送进 ash 的正文（附件转存后的路径也定在这里，重试时用同一份，chat 的幂等要求逐字节相同）。 */
  body: text("body"),
  attachments: text("attachments"),
  /** 聊天房间的回复发回飞书时凭的授权来源（JSON，im/scope.ts）：投进房间那一刻盖下。 */
  scope: text("scope"),
  /** 消息事件原文（JSON）：重启时还没处理完的，照它重新处理一遍。 */
  payload: text("payload"),
  /**
   * received（已落库、还没办）→ dispatching（正要做一件重做不安全的事：给任务发消息、答复、重试）
   * → done / failed；助手房间：sent（已投进房间）→ replied（回复已发回飞书）。
   */
  state: text("state").notNull(),
  detail: text("detail"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [index("im_inbound_state").on(t.state)]);

export const imGroups = sqliteTable("im_groups", {
  channel: text("channel").notNull(),
  appId: text("app_id").notNull(),
  chatId: text("chat_id").notNull(),
  projectId: text("project_id").notNull(),
  name: text("name"),
  /** 谁把这个群绑上的（ash 账号；自用模式为空）。群里的 @ 用这个人的身份执行。 */
  boundBy: text("bound_by"),
  /** 1 = 本项目任务的卡片改发到这个群（而不是各自的单聊）。 */
  pushCards: integer("push_cards").notNull().default(0),
  boundAt: text("bound_at").notNull(),
}, (t) => [primaryKey({ columns: [t.channel, t.appId, t.chatId] })]);

export const imGroupRooms = sqliteTable("im_group_rooms", {
  channel: text("channel").notNull(),
  appId: text("app_id").notNull(),
  chatId: text("chat_id").notNull(),
  /** 说话人的 ash 账号；自用模式为空串。 */
  userKey: text("user_key").notNull(),
  roomId: text("room_id").notNull(),
}, (t) => [primaryKey({ columns: [t.channel, t.appId, t.chatId, t.userKey] })]);

export const imOutcomes = sqliteTable("im_outcomes", {
  appId: text("app_id").notNull(),
  taskId: text("task_id").notNull(),
  /** result（验收合并）| gate（验收前置命令） */
  kind: text("kind").notNull(),
  value: text("value").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [primaryKey({ columns: [t.appId, t.taskId, t.kind] })]);

export const imMeta = sqliteTable("im_meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/** 建表（幂等，每次启动都跑）。表定义与 DDL 放同一个文件，免得加列只改一边。 */
export async function ensureImSchema(client: Client): Promise<void> {
  await client.executeMultiple(`
    CREATE TABLE IF NOT EXISTS im_bindings (
      channel TEXT NOT NULL, app_id TEXT NOT NULL, open_id TEXT NOT NULL, user_id TEXT,
      chat_id TEXT, assistant_room_id TEXT, project_id TEXT, bound_at TEXT NOT NULL,
      PRIMARY KEY (channel, app_id, open_id)
    );
    CREATE INDEX IF NOT EXISTS im_bindings_user ON im_bindings(user_id);
    CREATE TABLE IF NOT EXISTS im_bind_codes (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, purpose TEXT NOT NULL, project_id TEXT,
      code_hash TEXT NOT NULL, state TEXT NOT NULL,
      claimed_app_id TEXT, claimed_open_id TEXT, claimed_chat_id TEXT, claimed_name TEXT, claimed_at TEXT,
      created_at TEXT NOT NULL, expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS im_bind_codes_owner ON im_bind_codes(owner);
    CREATE INDEX IF NOT EXISTS im_bind_codes_hash ON im_bind_codes(code_hash);
    CREATE TABLE IF NOT EXISTS im_outbox (
      id TEXT PRIMARY KEY, channel TEXT NOT NULL, app_id TEXT NOT NULL,
      receive_type TEXT NOT NULL, receive_id TEXT NOT NULL, recipient_open_id TEXT,
      task_id TEXT, kind TEXT NOT NULL, subject TEXT NOT NULL,
      reply_to TEXT, reply_in_thread INTEGER NOT NULL DEFAULT 0,
      msg_type TEXT NOT NULL, content TEXT NOT NULL, render_key TEXT, scope TEXT, brief TEXT, state TEXT NOT NULL, message_id TEXT,
      patch_state TEXT, resolution TEXT, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, next_at TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, sent_at TEXT, resolved_at TEXT
    );
    DROP INDEX IF EXISTS im_outbox_subject;
    CREATE INDEX IF NOT EXISTS im_outbox_task ON im_outbox(task_id);
    CREATE INDEX IF NOT EXISTS im_outbox_state ON im_outbox(state);
    CREATE INDEX IF NOT EXISTS im_outbox_message ON im_outbox(message_id);
    CREATE TABLE IF NOT EXISTS im_actions (
      id TEXT PRIMARY KEY, outbox_id TEXT NOT NULL, task_id TEXT, action TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}', recipient_open_id TEXT NOT NULL, generation TEXT NOT NULL,
      expires_at TEXT NOT NULL, used_at TEXT, claimed_by TEXT, result TEXT, audit TEXT, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS im_actions_outbox ON im_actions(outbox_id);
    CREATE TABLE IF NOT EXISTS im_inbound (
      id TEXT PRIMARY KEY, channel TEXT NOT NULL, app_id TEXT NOT NULL,
      open_id TEXT, chat_id TEXT, chat_type TEXT, kind TEXT NOT NULL,
      task_id TEXT, room_id TEXT, body TEXT, attachments TEXT, scope TEXT, payload TEXT,
      state TEXT NOT NULL, detail TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS im_inbound_state ON im_inbound(state);
    CREATE TABLE IF NOT EXISTS im_groups (
      channel TEXT NOT NULL, app_id TEXT NOT NULL, chat_id TEXT NOT NULL, project_id TEXT NOT NULL,
      name TEXT, bound_by TEXT, push_cards INTEGER NOT NULL DEFAULT 0, bound_at TEXT NOT NULL,
      PRIMARY KEY (channel, app_id, chat_id)
    );
    CREATE TABLE IF NOT EXISTS im_group_rooms (
      channel TEXT NOT NULL, app_id TEXT NOT NULL, chat_id TEXT NOT NULL, user_key TEXT NOT NULL, room_id TEXT NOT NULL,
      PRIMARY KEY (channel, app_id, chat_id, user_key)
    );
    CREATE TABLE IF NOT EXISTS im_outcomes (
      app_id TEXT NOT NULL, task_id TEXT NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (app_id, task_id, kind)
    );
    CREATE TABLE IF NOT EXISTS im_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
  `);
  // 早期库补列（CREATE TABLE IF NOT EXISTS 不会给已有的表加列）。
  const added: [table: string, column: string, ddl: string][] = [
    ["im_outbox", "render_key", "ALTER TABLE im_outbox ADD COLUMN render_key TEXT"],
    ["im_outbox", "scope", "ALTER TABLE im_outbox ADD COLUMN scope TEXT"],
    ["im_outbox", "brief", "ALTER TABLE im_outbox ADD COLUMN brief TEXT"],
    ["im_actions", "audit", "ALTER TABLE im_actions ADD COLUMN audit TEXT"],
    ["im_actions", "claimed_by", "ALTER TABLE im_actions ADD COLUMN claimed_by TEXT"],
    ["im_inbound", "payload", "ALTER TABLE im_inbound ADD COLUMN payload TEXT"],
    ["im_inbound", "scope", "ALTER TABLE im_inbound ADD COLUMN scope TEXT"],
  ];
  for (const [table, column, ddl] of added) {
    const columns = await client.execute(`PRAGMA table_info(${table})`);
    if (!columns.rows.some((row) => row.name === column)) await client.execute(ddl);
  }
  // 唯一键换了组成（加应用、空 task_id 按空串）：只在还没建过时做一次，先清掉同键的重复行、留最早那条。
  const indexes = await client.execute("PRAGMA index_list(im_outbox)");
  if (!indexes.rows.some((row) => row.name === "im_outbox_dedupe")) {
    await client.execute(`DELETE FROM im_outbox WHERE rowid NOT IN (
      SELECT min(rowid) FROM im_outbox GROUP BY app_id, receive_id, coalesce(task_id, ''), kind, subject
    )`);
    await client.execute(
      "CREATE UNIQUE INDEX im_outbox_dedupe ON im_outbox(app_id, receive_id, coalesce(task_id, ''), kind, subject)",
    );
  }
}
