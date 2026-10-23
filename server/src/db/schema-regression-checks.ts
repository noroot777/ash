import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { RegressionSnapshot } from "../regression-snapshot.js";
import type { Client } from "./node-sqlite-client.js";

export const regressionChecks = sqliteTable("regression_checks", {
  monitorId: text("monitor_id").primaryKey(),
  taskId: text("task_id").notNull(),
  role: text("role").notNull(),
  command: text("command").notNull(),
  cwd: text("cwd").notNull(),
  logPath: text("log_path").notNull(),
  logDigest: text("log_digest"),
  before: text("before_snapshot", { mode: "json" }).$type<RegressionSnapshot>(),
  after: text("after_snapshot", { mode: "json" }).$type<RegressionSnapshot>(),
  exitCode: integer("exit_code"),
  error: text("error"),
  createdAt: text("created_at").notNull(),
  startedAt: text("started_at"),
  endedAt: text("ended_at"),
}, (table) => ({ taskIdx: index("regression_checks_task_idx").on(table.taskId, table.createdAt) }));

export async function ensureRegressionChecksSchema(client: Client): Promise<void> {
  await client.executeMultiple(`
    CREATE TABLE IF NOT EXISTS regression_checks (
      monitor_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, role TEXT NOT NULL,
      command TEXT NOT NULL, cwd TEXT NOT NULL, log_path TEXT NOT NULL, log_digest TEXT,
      before_snapshot TEXT, after_snapshot TEXT, exit_code INTEGER, error TEXT,
      created_at TEXT NOT NULL, started_at TEXT, ended_at TEXT
    );
    CREATE INDEX IF NOT EXISTS regression_checks_task_idx ON regression_checks (task_id, created_at);
  `);
}
