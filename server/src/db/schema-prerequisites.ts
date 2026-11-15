// 任务之间的「前置」关系，和「等齐就起」那一笔持久的起跑请求（用法见 ../prerequisite-launch.ts）。
//
// 两张表都不被别的表引用，建表自成一个单元；`ensureSchema()` 只留一行调用。
import { index, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { Client } from "./node-sqlite-client.js";

/**
 * 一条边 = `taskId` 建在 `prerequisiteId` 上面。
 *
 * `inheritedCommit` 是下游**开工那一刻**从这条前置拿到的那一版（前置已经合入目标分支时就是当时目标分支
 * 的提交）。验收时判「这条前置的成果进没进目标分支」、页面上判「前置在我开工之后又动过没有」都读它；
 * 没开工时为空。
 */
export const taskPrerequisites = sqliteTable("task_prerequisites", {
  taskId: text("task_id").notNull(),
  prerequisiteId: text("prerequisite_id").notNull(),
  inheritedCommit: text("inherited_commit"),
  createdAt: text("created_at").notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.taskId, t.prerequisiteId] }),
  byPrerequisite: index("task_prerequisites_prerequisite_idx").on(t.prerequisiteId),
}));

/**
 * 有前置的任务的起跑记账，一个任务一行。
 *
 * - `requestedAt` 非空、`launchedAt` 为空 = 已经被要求起跑（建的时候带 run、用户点运行、队列 / 分组轮到它），
 *   前置还没站齐，**等齐就起**。这一笔是持久的：重启之后照旧在等，重启期间站稳的由开机补办接上。
 * - `launchedAt` 非空 = 开工起点已经按前置定下来了。之后的运行不再看前置，前置也不能再加减。
 * - `blocked` = 前置都站稳了却起不了跑的原因（几条前置的改动合不到一起），等用户处理；前置一变就重判。
 * - `actingUserId` = 当初要求起跑的人：等齐之后替他起跑，这一轮烧谁的额度照他。
 */
export const taskPrerequisiteLaunches = sqliteTable("task_prerequisite_launches", {
  taskId: text("task_id").primaryKey(),
  requestedAt: text("requested_at"),
  source: text("source"),
  actingUserId: text("acting_user_id"),
  blocked: text("blocked"),
  launchedAt: text("launched_at"),
});

export async function ensurePrerequisiteSchema(client: Client): Promise<void> {
  await client.executeMultiple(`
    CREATE TABLE IF NOT EXISTS task_prerequisites (
      task_id TEXT NOT NULL, prerequisite_id TEXT NOT NULL, inherited_commit TEXT,
      created_at TEXT NOT NULL, PRIMARY KEY (task_id, prerequisite_id)
    );
    CREATE INDEX IF NOT EXISTS task_prerequisites_prerequisite_idx ON task_prerequisites (prerequisite_id);
    CREATE TABLE IF NOT EXISTS task_prerequisite_launches (
      task_id TEXT PRIMARY KEY, requested_at TEXT, source TEXT, acting_user_id TEXT,
      blocked TEXT, launched_at TEXT
    );
  `);
}
