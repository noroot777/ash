import { index, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const chatRooms = sqliteTable("chat_rooms", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  ownerUserId: text("owner_user_id"),
  name: text("name").notNull(),
  members: text("members").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [index("chat_rooms_project").on(table.projectId)]);

export const chatMessages = sqliteTable("chat_messages", {
  id: text("id").primaryKey(),
  roomId: text("room_id").notNull(),
  role: text("role").notNull(),
  memberId: text("member_id"),
  author: text("author").notNull(),
  body: text("body").notNull().default(""),
  mentions: text("mentions").notNull().default("[]"),
  status: text("status").notNull().default("done"),
  taskId: text("task_id"),
  context: text("context"),
  createdAt: text("created_at").notNull(),
}, (table) => [index("chat_messages_room").on(table.roomId, table.createdAt)]);

export async function ensureChatSchema(client: { executeMultiple(sql: string): Promise<unknown> }) {
  await client.executeMultiple(`
    CREATE TABLE IF NOT EXISTS chat_rooms (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, owner_user_id TEXT,
      name TEXT NOT NULL, members TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS chat_rooms_project ON chat_rooms(project_id);
    CREATE TABLE IF NOT EXISTS chat_messages (
      id TEXT PRIMARY KEY, room_id TEXT NOT NULL, role TEXT NOT NULL, member_id TEXT,
      author TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', mentions TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'done', task_id TEXT, context TEXT, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS chat_messages_room ON chat_messages(room_id, created_at);
  `);
}
