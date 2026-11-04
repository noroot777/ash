// ── 任务写过的位置 ─────────────────────────────────────────────────────────────
// 执行器当场报出来的「这一步写到了哪里」（`writes` 事件，取法见 executors/tool-writes.ts），
// 按任务去重落一行。写入端是 `task-writes.ts`；读取端是生成物面板：写文件工具记下的文件连同
// 内容指纹是「这份是它亲手写的」的直接证据（task-artifact-direct.ts），它写过的目录扫描时先看。
//
// 一个任务对同一个路径只留一行（首次 / 最近一次 / 最近一次写下的内容指纹），量级是「它碰过的
// 文件数」，不随回合涨。
import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { Client } from "./node-sqlite-client.js";

export const taskWrites = sqliteTable(
  "task_writes",
  {
    taskId: text("task_id").notNull(),
    /** 归一后的绝对路径（相对路径已按工作目录展开、软链已解开），读取端按同一种身份比。 */
    path: text("path").notNull(),
    /** 1 = 命令的工作目录（进去可能只是看一眼）；0 = 写文件/改文件工具的目标文件。 */
    weak: integer("weak").notNull(),
    firstAt: text("first_at").notNull(),
    lastAt: text("last_at").notNull(),
    /** 最近一次写下的内容的指纹（从那次操作自己带的内容算，file-digest.ts）；推不出内容、不是产物、太大时为空。 */
    digest: text("digest"),
  },
  (t) => ({ pk: primaryKey({ columns: [t.taskId, t.path, t.weak] }) }),
);

/** 建表（幂等，每次启动都跑）。表定义与 DDL 放同一个文件，免得加列只改一边。 */
export async function ensureTaskWritesSchema(client: Client): Promise<void> {
  await client.executeMultiple(`
    CREATE TABLE IF NOT EXISTS task_writes (
      task_id TEXT NOT NULL, path TEXT NOT NULL, weak INTEGER NOT NULL,
      first_at TEXT NOT NULL, last_at TEXT NOT NULL, digest TEXT,
      PRIMARY KEY (task_id, path, weak)
    );
  `);
}
