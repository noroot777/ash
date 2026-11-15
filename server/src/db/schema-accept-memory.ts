// ── 验收确认层「运行前置命令」那一勾上次的样子：按人、按项目各记一份 ─────────────────────
// 一行 = 这个人在这个项目里**上一次真的确认验收**时，有没有取消「运行」（skip_gate）。只有确认层
// 写它（server/src/accept-memory.ts），也只有确认层读它（经门禁状态带出去）：智能体调 accept_task、
// 飞书卡片、手机端都不读 —— 没明说跳过就照常跑。
//
// 为什么进库而不放浏览器：换浏览器、mac 版、重启都要记得；跳不跳过是人的习惯，不是设备的。
// 「提交」那一勾不在这里：它记成项目设置本身（projects.accept_commit），免得两份默认互相打架。
//
// owner：多人模式下是 userId；自用模式下是空串（理由同 schema-task-reads.ts），转多人时过户。
import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { Client } from "./node-sqlite-client.js";

export const acceptMemory = sqliteTable(
  "accept_memory",
  {
    owner: text("owner").notNull(),
    projectId: text("project_id").notNull(),
    skipGate: integer("skip_gate", { mode: "boolean" }).notNull().default(false),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.owner, t.projectId] }) }),
);

/** 建表(幂等,每次启动都跑)。 */
export async function ensureAcceptMemorySchema(client: Client): Promise<void> {
  await client.executeMultiple(`
    CREATE TABLE IF NOT EXISTS accept_memory (
      owner TEXT NOT NULL, project_id TEXT NOT NULL,
      skip_gate INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL,
      PRIMARY KEY (owner, project_id)
    );
  `);
}
