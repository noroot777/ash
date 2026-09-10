import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { Client } from "./node-sqlite-client.js";

export const chatRooms = sqliteTable("chat_rooms", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  ownerUserId: text("owner_user_id"),
  name: text("name").notNull(),
  members: text("members").notNull(),
  kind: text("kind").notNull().default("chat"),
  createdAt: text("created_at").notNull(),
}, (table) => [index("chat_rooms_project").on(table.projectId)]);

export const chatMessages = sqliteTable("chat_messages", {
  id: text("id").primaryKey(),
  roomId: text("room_id").notNull(),
  role: text("role").notNull(),
  memberId: text("member_id"),
  author: text("author").notNull(),
  body: text("body").notNull().default(""),
  modelReply: text("model_reply"),
  mentions: text("mentions").notNull().default("[]"),
  status: text("status").notNull().default("done"),
  taskId: text("task_id"),
  context: text("context"),
  assistant: text("assistant"),
  // 目录观察附注（execution.ts changeNotice）。invoke 一返回就落到这一列：附注是
  // 「项目可能被并发改动/观察失效」的安全信息，不能只活在 reply() 的闭包里——进程
  // 崩溃/重启后 stop()/recover() 的固定文案覆盖要靠它把附注拼回正文（service.ts）。
  notice: text("notice"),
  createdAt: text("created_at").notNull(),
}, (table) => [index("chat_messages_room").on(table.roomId, table.createdAt)]);

export const chatContextEntries = sqliteTable("chat_context_entries", {
  sequence: integer("sequence").primaryKey({ autoIncrement: true }),
  roomId: text("room_id").notNull(),
  messageId: text("message_id").notNull().unique(),
  content: text("content").notNull(),
  tokens: integer("tokens").notNull(),
}, (table) => [index("chat_context_entries_room").on(table.roomId, table.sequence)]);

export const chatSummaries = sqliteTable("chat_summaries", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  roomId: text("room_id").notNull(),
  throughSequence: integer("through_sequence").notNull(),
  body: text("body").notNull(),
  tokens: integer("tokens").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [index("chat_summaries_room").on(table.roomId, table.throughSequence)]);

export const chatContextStates = sqliteTable("chat_context_states", {
  roomId: text("room_id").primaryKey(),
  status: text("status").notNull().default("idle"),
  error: text("error"),
  failedAt: text("failed_at"),
  updatedAt: text("updated_at").notNull(),
});

export const chatContextResets = sqliteTable("chat_context_resets", {
  roomId: text("room_id").primaryKey(),
  afterSequence: integer("after_sequence").notNull(),
  clearedAt: text("cleared_at").notNull(),
});

export async function ensureChatSchema(client: Pick<Client, "executeMultiple" | "execute">) {
  await client.executeMultiple(`
    CREATE TABLE IF NOT EXISTS chat_rooms (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, owner_user_id TEXT,
      name TEXT NOT NULL, members TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS chat_rooms_project ON chat_rooms(project_id);
    CREATE TABLE IF NOT EXISTS chat_messages (
      id TEXT PRIMARY KEY, room_id TEXT NOT NULL, role TEXT NOT NULL, member_id TEXT,
      author TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', model_reply TEXT, mentions TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'done', task_id TEXT, context TEXT, notice TEXT, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS chat_messages_room ON chat_messages(room_id, created_at);
    CREATE TABLE IF NOT EXISTS chat_context_entries (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, room_id TEXT NOT NULL,
      message_id TEXT NOT NULL UNIQUE, content TEXT NOT NULL, tokens INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS chat_context_entries_room ON chat_context_entries(room_id, sequence);
    CREATE TABLE IF NOT EXISTS chat_summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT, room_id TEXT NOT NULL, through_sequence INTEGER NOT NULL,
      body TEXT NOT NULL, tokens INTEGER NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS chat_summaries_room ON chat_summaries(room_id, through_sequence);
    CREATE TABLE IF NOT EXISTS chat_context_states (
      room_id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'idle', error TEXT, failed_at TEXT, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chat_context_resets (
      room_id TEXT PRIMARY KEY, after_sequence INTEGER NOT NULL, cleared_at TEXT NOT NULL
    );
  `);
  const messageColumns = await client.execute("PRAGMA table_info(chat_messages)");
  const roomColumns = await client.execute("PRAGMA table_info(chat_rooms)");
  if (!roomColumns.rows.some((column) => column.name === "kind")) {
    await client.execute("ALTER TABLE chat_rooms ADD COLUMN kind TEXT NOT NULL DEFAULT 'chat'");
  }
  if (!messageColumns.rows.some((column) => column.name === "assistant")) {
    await client.execute("ALTER TABLE chat_messages ADD COLUMN assistant TEXT");
  }
  if (!messageColumns.rows.some((column) => column.name === "model_reply")) {
    await client.execute("ALTER TABLE chat_messages ADD COLUMN model_reply TEXT");
  }
  if (!messageColumns.rows.some((column) => column.name === "notice")) {
    await client.execute("ALTER TABLE chat_messages ADD COLUMN notice TEXT");
  }
  await client.execute("UPDATE chat_messages SET model_reply=body WHERE role='agent' AND status='done' AND model_reply IS NULL");
  const columns = await client.execute("PRAGMA table_info(chat_context_states)");
  if (!columns.rows.some((column) => column.name === "failed_at")) {
    await client.execute("ALTER TABLE chat_context_states ADD COLUMN failed_at TEXT");
  }
  await client.execute("UPDATE chat_context_states SET failed_at=updated_at WHERE status='failed' AND failed_at IS NULL");
}
