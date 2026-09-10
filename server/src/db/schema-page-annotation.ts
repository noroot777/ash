import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { Client } from "./node-sqlite-client.js";

export const pageAnnotationBatches = sqliteTable("page_annotation_batches", {
  id: text("id").primaryKey(),
  taskId: text("task_id").notNull(),
  ownerUserId: text("owner_user_id"),
  payload: text("payload").notNull(),
  revision: integer("revision").notNull(),
  messageId: text("message_id"),
  savedAt: text("saved_at").notNull(),
  deliveredAt: text("delivered_at"),
}, (t) => [index("page_annotation_batches_task").on(t.taskId)]);

export async function ensurePageAnnotationSchema(client: Client): Promise<void> {
  await client.executeMultiple(`
    CREATE TABLE IF NOT EXISTS page_annotation_batches (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, owner_user_id TEXT,
      payload TEXT NOT NULL, revision INTEGER NOT NULL, message_id TEXT,
      saved_at TEXT NOT NULL, delivered_at TEXT
    );
    CREATE INDEX IF NOT EXISTS page_annotation_batches_task ON page_annotation_batches(task_id);
  `);
}
