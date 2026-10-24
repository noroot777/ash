import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { RegressionSnapshot } from "../regression-snapshot.js";
import type { RegressionInputIdentity } from "../regression-input.js";
import type { Client } from "./node-sqlite-client.js";

export const regressionChecks = sqliteTable("regression_checks", {
  generation: integer("generation").primaryKey({ autoIncrement: true }),
  monitorId: text("monitor_id").notNull().unique(),
  taskId: text("task_id").notNull(),
  role: text("role").notNull(),
  command: text("command").notNull(),
  cwd: text("cwd").notNull(),
  logPath: text("log_path").notNull(),
  logDigest: text("log_digest"),
  before: text("before_snapshot", { mode: "json" }).$type<RegressionSnapshot>(),
  after: text("after_snapshot", { mode: "json" }).$type<RegressionSnapshot>(),
  inputIdentity: text("input_identity", { mode: "json" }).$type<RegressionInputIdentity>(),
  exitCode: integer("exit_code"),
  error: text("error"),
  createdAt: text("created_at").notNull(),
  startedAt: text("started_at"),
  endedAt: text("ended_at"),
}, (table) => ({ taskIdx: index("regression_checks_task_idx").on(table.taskId, table.generation) }));

export async function ensureRegressionChecksSchema(client: Client): Promise<void> {
  const transaction = await client.transaction("write");
  try {
    const definition = `(
      generation INTEGER PRIMARY KEY AUTOINCREMENT, monitor_id TEXT NOT NULL UNIQUE,
      task_id TEXT NOT NULL, role TEXT NOT NULL,
      command TEXT NOT NULL, cwd TEXT NOT NULL, log_path TEXT NOT NULL, log_digest TEXT,
      before_snapshot TEXT, after_snapshot TEXT, input_identity TEXT, exit_code INTEGER, error TEXT,
      created_at TEXT NOT NULL, started_at TEXT, ended_at TEXT
    )`;
    await transaction.execute(`CREATE TABLE IF NOT EXISTS regression_checks ${definition}`);
    const columns = (await transaction.execute("PRAGMA table_info(regression_checks)")).rows;
    if (!columns.some((column) => column.name === "generation")) {
      await transaction.execute(`CREATE TABLE regression_checks_ordered ${definition}`);
      const legacy = "monitor_id, task_id, role, command, cwd, log_path, log_digest, before_snapshot, after_snapshot, exit_code, error, created_at, started_at, ended_at";
      await transaction.execute(`INSERT INTO regression_checks_ordered (${legacy}) SELECT ${legacy} FROM regression_checks ORDER BY rowid`);
      await transaction.execute("DROP TABLE regression_checks");
      await transaction.execute("ALTER TABLE regression_checks_ordered RENAME TO regression_checks");
    }
    await transaction.execute("CREATE INDEX IF NOT EXISTS regression_checks_task_idx ON regression_checks (task_id, generation)");
    await transaction.commit();
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}
