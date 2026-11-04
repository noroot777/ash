// ── 任务写过的位置 ─────────────────────────────────────────────────────────────
// 执行器当场报出来的「这一步写到了哪里」（`writes` 事件，取法见 executors/tool-writes.ts），
// 按任务去重落一行。写入端是 `task-writes.ts`，读取端是生成物面板的并发裁决
// （`task-artifact-footprint.ts`）：共享目录上两个任务同时在跑时，时间分不开它们，
// 「谁在这附近写过东西」分得开。
//
// 一个任务对同一个路径只留一行（首次 / 最近一次），量级是「它碰过的文件数」，不随回合涨。
import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { Client } from "./node-sqlite-client.js";

export const taskWrites = sqliteTable(
  "task_writes",
  {
    taskId: text("task_id").notNull(),
    /** 绝对路径（相对路径在记录时已按会话工作目录展开）。 */
    path: text("path").notNull(),
    /** 1 = 命令的工作目录（弱证据：进去可能只是看一眼）；0 = 写文件/改文件工具的目标文件。 */
    weak: integer("weak").notNull(),
    firstAt: text("first_at").notNull(),
    lastAt: text("last_at").notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.taskId, t.path, t.weak] }) }),
);

/** 建表（幂等，每次启动都跑）。表定义与 DDL 放同一个文件，免得加列只改一边。 */
export async function ensureTaskWritesSchema(client: Client): Promise<void> {
  await client.executeMultiple(`
    CREATE TABLE IF NOT EXISTS task_writes (
      task_id TEXT NOT NULL, path TEXT NOT NULL, weak INTEGER NOT NULL,
      first_at TEXT NOT NULL, last_at TEXT NOT NULL,
      PRIMARY KEY (task_id, path, weak)
    );
  `);
}
