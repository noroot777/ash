// dispatch_start_debts：派活单「派出去」建好的任务里，**哪一条还欠一次起跑**——一条任务一行。
//
// 建任务、认领那一问、答复（进待发送托盘）跟这几行同一笔提交（dispatch-plan-launch.ts）。这一行就是「用户按下派出去、
// 要它开工」那一笔原始请求：起跑成了、被接走了（排进队列、挂到前置上）才销；用户对这一条按了停止就当场划掉（撤销
// 是终局的，之后的补起、重试都不会再替它挂请求）。还法和销账判据见 dispatch-launch-start.ts。
import { index, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { Client } from "./node-sqlite-client.js";

export const dispatchStartDebts = sqliteTable("dispatch_start_debts", {
  taskId: text("task_id").primaryKey(),
  groupId: text("group_id").notNull(),
  /** 摆单的那条任务（看日志、排查时用）。 */
  leadTaskId: text("lead_task_id").notNull(),
  createdAt: text("created_at").notNull(),
}, (t) => ({ groupIdx: index("dispatch_start_debts_group_idx").on(t.groupId) }));

/** 建表(幂等,每次启动都跑)。 */
export async function ensureDispatchLaunchSchema(client: Client): Promise<void> {
  await client.executeMultiple(`
    CREATE TABLE IF NOT EXISTS dispatch_start_debts (
      task_id TEXT PRIMARY KEY, group_id TEXT NOT NULL, lead_task_id TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS dispatch_start_debts_group_idx ON dispatch_start_debts (group_id);
  `);
}
