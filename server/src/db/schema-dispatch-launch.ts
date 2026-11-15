// dispatch_launch_starts：派活单「派出去」建好的那一组**还欠一次起跑**。
//
// 建任务、认领那一问、答复（进待发送托盘）跟这一行同一笔提交（dispatch-plan-launch.ts），提交之后立刻起这一组；
// 核实组里没人再欠起跑才销账，没还清就留着退避再起、重启时补起。还法和销账判据见 dispatch-launch-start.ts。
// 所以「已经建好的任务没人去跑」不靠谁记得，靠这一行在不在。
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { Client } from "./node-sqlite-client.js";

export const dispatchLaunchStarts = sqliteTable("dispatch_launch_starts", {
  groupId: text("group_id").primaryKey(),
  /** 摆单的那条任务（看日志、排查时用）。 */
  taskId: text("task_id").notNull(),
  createdAt: text("created_at").notNull(),
});

/** 建表(幂等,每次启动都跑)。 */
export async function ensureDispatchLaunchSchema(client: Client): Promise<void> {
  await client.executeMultiple(`
    CREATE TABLE IF NOT EXISTS dispatch_launch_starts (
      group_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, created_at TEXT NOT NULL
    );
  `);
}
