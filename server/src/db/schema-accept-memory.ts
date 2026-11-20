// ── 验收确认层「运行前置命令」那一勾上次的样子：按人、按项目各记一份 ─────────────────────
// 一行 = 这个人在这个项目里**上一次真的确认验收**时，有没有取消「运行」（skip_gate）、有没有勾「推送」（push）。只有确认层
// 写它（server/src/accept-memory.ts），也只有确认层读它（经门禁状态带出去）：智能体调 accept_task、
// 飞书卡片、手机端都不读 —— 没明说跳过就照常跑。
//
// 为什么进库而不放浏览器：换浏览器、mac 版、重启都要记得；跳不跳过是人的习惯，不是设备的。
// 「提交」那一勾不在这里：它记成项目设置本身（projects.accept_commit），免得两份默认互相打架。
//
// owner：多人模式下是 userId；自用模式下是空串（理由同 schema-task-reads.ts），转多人时过户。
//
// seq / accept_commit_order：两份记忆各带一个「这一笔是哪一次确认写的」的到达序号（accept-order.ts）。
// 浏览器等不及放弃了请求，服务端那一下照样会做完；有了序号，晚做完的旧确认就盖不掉新的（第 2 轮审查 F1）。
import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { seedArrivalSeq } from "./arrival-seq.js";
import type { Client } from "./node-sqlite-client.js";

export const acceptMemory = sqliteTable(
  "accept_memory",
  {
    owner: text("owner").notNull(),
    projectId: text("project_id").notNull(),
    skipGate: integer("skip_gate", { mode: "boolean" }).notNull().default(false),
    /** 上一次确认时勾没勾「推送到远程」（task-accept-push.ts）。只管确认层的默认，/accept 不读它。 */
    push: integer("push", { mode: "boolean" }).notNull().default(false),
    seq: integer("seq").notNull().default(0),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.owner, t.projectId] }) }),
);

/** 项目设置「合并后提交」最后一笔是哪一次写的（确认层和设置页都写它）。没有行 = 还没人按顺序写过。 */
export const acceptCommitOrder = sqliteTable("accept_commit_order", {
  projectId: text("project_id").primaryKey(),
  seq: integer("seq").notNull(),
});

/** 建表(幂等,每次启动都跑)。 */
export async function ensureAcceptMemorySchema(client: Client): Promise<void> {
  await client.executeMultiple(`
    CREATE TABLE IF NOT EXISTS accept_memory (
      owner TEXT NOT NULL, project_id TEXT NOT NULL,
      skip_gate INTEGER NOT NULL DEFAULT 0, push INTEGER NOT NULL DEFAULT 0, seq INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL,
      PRIMARY KEY (owner, project_id)
    );
    CREATE TABLE IF NOT EXISTS accept_commit_order (project_id TEXT PRIMARY KEY, seq INTEGER NOT NULL);
  `);
  // 这张表的头两版没有 seq（只在本任务的审查版本上跑过）：先问再补，记住的选择原样留着，理由同 schema-task-reads.ts。
  const columns = await client.execute("PRAGMA table_info(accept_memory);");
  if (!columns.rows.some((row) => String((row as Record<string, unknown>).name) === "seq")) {
    await client.executeMultiple("ALTER TABLE accept_memory ADD COLUMN seq INTEGER NOT NULL DEFAULT 0;");
  }
  if (!columns.rows.some((row) => String((row as Record<string, unknown>).name) === "push")) {
    await client.executeMultiple("ALTER TABLE accept_memory ADD COLUMN push INTEGER NOT NULL DEFAULT 0;");
  }
  const top = await client.execute(
    "SELECT max(seq) AS seq FROM (SELECT seq FROM accept_memory UNION ALL SELECT seq FROM accept_commit_order);");
  seedArrivalSeq(Number((top.rows[0] as Record<string, unknown> | undefined)?.seq ?? 0));
}
