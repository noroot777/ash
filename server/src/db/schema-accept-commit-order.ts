// ── 项目设置「合并后提交」最后一笔是哪一次写的 ────────────────────────────────────────────
// 写它的有两处：验收确认层点确认（server/src/accept-memory.ts —— 「提交」那一勾就是项目设置本身，
// projects.accept_commit）和设置页（project-routes.ts PATCH）。两处都带一个到达序号（accept-order.ts）：
// 浏览器等不及放弃了请求，服务端那一下照样会做完；有了序号，晚做完的旧确认就盖不掉新的。
//
// 确认层另一勾「运行前置命令」不在这里，也不在任何地方：跳过只管当次（用户 2026-11-16）。按人按项目记它
// 「上次取消过没有」的那张表 accept_memory 已退役，老库里的启动时清掉（migrations.ts RETIRED_TABLES）。
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { seedArrivalSeq } from "./arrival-seq.js";
import type { Client } from "./node-sqlite-client.js";

/** 没有行 = 这个项目的「合并后提交」还没人按顺序写过。 */
export const acceptCommitOrder = sqliteTable("accept_commit_order", {
  projectId: text("project_id").primaryKey(),
  seq: integer("seq").notNull(),
});

/** 建表(幂等,每次启动都跑)。 */
export async function ensureAcceptCommitOrderSchema(client: Client): Promise<void> {
  await client.executeMultiple(
    "CREATE TABLE IF NOT EXISTS accept_commit_order (project_id TEXT PRIMARY KEY, seq INTEGER NOT NULL);");
  const top = await client.execute("SELECT max(seq) AS seq FROM accept_commit_order;");
  seedArrivalSeq(Number((top.rows[0] as Record<string, unknown> | undefined)?.seq ?? 0));
}
