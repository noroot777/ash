import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { Client } from "./node-sqlite-client.js";

export const taskBackgroundRevisions = sqliteTable("task_background_revisions", {
  taskId: text("task_id").primaryKey(),
  revision: integer("revision").notNull().default(0),
});

export async function ensureTaskBackgroundSchema(client: Client): Promise<void> {
  await client.executeMultiple(`
    CREATE TABLE IF NOT EXISTS task_background_revisions (
      task_id TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0
    );
    CREATE TRIGGER IF NOT EXISTS task_background_delete AFTER DELETE ON tasks BEGIN
      DELETE FROM task_background_revisions WHERE task_id = OLD.id;
    END;
  `);
  for (const table of ["monitors", "accept_gate_runs"]) {
    const columns = table === "monitors" ? "status, task_id" : "status, task_id, process_pending";
    const changed = "OLD.status IS NOT NEW.status OR OLD.task_id IS NOT NEW.task_id"
      + (table === "accept_gate_runs" ? " OR OLD.process_pending IS NOT NEW.process_pending" : "");
    const bump = (record: string, condition = "1") => `
      INSERT INTO task_background_revisions (task_id, revision)
        SELECT id, 1 FROM tasks WHERE id = ${record}.task_id AND ${condition}
        ON CONFLICT(task_id) DO UPDATE SET revision = revision + 1;
    `;
    await client.executeMultiple(`
      CREATE TRIGGER IF NOT EXISTS ${table}_background_insert AFTER INSERT ON ${table} BEGIN
        ${bump("NEW")}
      END;
      CREATE TRIGGER IF NOT EXISTS ${table}_background_delete AFTER DELETE ON ${table} BEGIN
        ${bump("OLD")}
      END;
      CREATE TRIGGER IF NOT EXISTS ${table}_background_update AFTER UPDATE OF ${columns} ON ${table}
        WHEN ${changed} BEGIN
        ${bump("NEW")}
        ${bump("OLD", "OLD.task_id IS NOT NEW.task_id")}
      END;
    `);
  }
}
