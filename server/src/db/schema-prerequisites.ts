// 任务之间的「前置」关系，和「等齐就起」那一笔持久的开工请求（用法见 ../launch-request.ts）。
//
// 两张表都不被别的表引用，建表自成一个单元；`ensureSchema()` 只留一行调用。
import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
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
 * 自动开工的记账，一个任务一行。表名里的「prerequisite」是历史：它起初只给有前置的任务用，现在是**一切**自动
 * 开工的那一份账（分组运行、派活单派出、接着跑兑现、前置站齐），没有前置的任务也挂在这里。
 *
 * - `requestedAt` 非空 = 已经被要求开工、还没开工（前置没站齐、同组名额满了、分组暂停着…），**等齐就起**。
 *   这一笔是持久的：重启之后照旧在等，开机补办接上。
 * - `requestId` = 这一笔请求的代号。每被要求一次开工就换一个：一次起跑尝试的收尾（了结、记一次起不来、退避）
 *   只动它自己认领时的那一代，旧尝试碰不到之后重新挂上的请求。
 * - `startFailures` / `retryAt` = 轮到它了却连着没起来几次、下一次最早什么时候再试（退避，有上限）。
 * - `giveUp` 非空 = 到顶了、不再自动起；这是还没写进时间线的那句交代。写成了才撤掉请求（../launch-request.ts）。
 * - `launchedAt` 非空 = 开工起点已经按前置定下来了。之后的运行不再看前置，前置也不能再加减。
 * - `blocked` = 前置都站稳了却起不了跑的原因（几条前置的改动合不到一起），等用户处理；前置一变就重判。
 * - `actingUserId` = 当初要求起跑的人：等齐之后替他起跑，这一轮烧谁的额度照他。
 * - `installJournal` = 开工判定**打算**把工作区换到的每一版（JSON 数组，只增不删），换之前先记、开工落定时清空。
 *   换到一半断掉（哪怕连断几次、中间前置还动过）之后，工作区停在其中任何一版上都认得出是 navi 换的、
 *   不是它自己的提交（../prerequisite-install.ts）。
 */
export const taskPrerequisiteLaunches = sqliteTable("task_prerequisite_launches", {
  taskId: text("task_id").primaryKey(),
  requestedAt: text("requested_at"),
  source: text("source"),
  actingUserId: text("acting_user_id"),
  blocked: text("blocked"),
  launchedAt: text("launched_at"),
  installJournal: text("install_journal", { mode: "json" }).$type<string[]>(),
  startFailures: integer("start_failures").notNull().default(0),
  retryAt: text("retry_at"),
  requestId: text("request_id"),
  giveUp: text("give_up"),
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
      blocked TEXT, launched_at TEXT, install_journal TEXT
    );
  `);
  // 这一列晚于表本身：早先建过表的库补上（已经有了就吞掉那句错）。
  await client.execute("ALTER TABLE task_prerequisite_launches ADD COLUMN install_journal TEXT").catch(() => undefined);
  await client.execute("ALTER TABLE task_prerequisite_launches ADD COLUMN start_failures INTEGER NOT NULL DEFAULT 0").catch(() => undefined);
  await client.execute("ALTER TABLE task_prerequisite_launches ADD COLUMN retry_at TEXT").catch(() => undefined);
  await client.execute("ALTER TABLE task_prerequisite_launches ADD COLUMN request_id TEXT").catch(() => undefined);
  await client.execute("ALTER TABLE task_prerequisite_launches ADD COLUMN give_up TEXT").catch(() => undefined);
}
