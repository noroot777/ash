// ── 任务「看过没有」：侧栏那颗「验收过、有没看的动态」绿点的判据 ──────────────────
// 一行 = 这个人看过这个任务的最新一轮：event 是那一轮的样子(口径见 web/src/lib/useTaskReadState.ts 的
// readEventForTask)，round 是那一轮的时刻(shared/src/task-reads.ts taskReadRound)。前端拿任务此刻的轮次
// 跟这里记的比，没看到这一轮就亮。round 只增不减：写进来的比已经记下的旧，就不写(迟到的重试、慢页面)。
//
// 为什么要进库：从前它只存在浏览器的 localStorage 里，于是每个浏览器各记一份 —— 飞书里点
// 「在 ash 中打开」用的是飞书内置浏览器，存储跟桌面浏览器不通，桌面上看过的任务到那边全亮着，
// 反过来也一样（用户问「是不是缓存」，其实是两份已读记录）。看没看过是人的事，不是设备的事。
//
// owner：多人模式下是 userId；自用模式下是空串（主键里不能用 NULL，NULL 互不相等会放进重复行）。
// 转多人时空串那几行过户给初始管理员（auth/conversion.ts）。
import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { Client } from "./node-sqlite-client.js";

export const taskReads = sqliteTable(
  "task_reads",
  {
    owner: text("owner").notNull(),
    taskId: text("task_id").notNull(),
    event: text("event").notNull(),
    round: integer("round").notNull().default(0),
    /** 写进来的那一刻(服务端的钟，epoch 毫秒)，只留作排查，不参与新旧判断。 */
    readAt: integer("read_at").notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.owner, t.taskId] }) }),
);

/** 建表(幂等,每次启动都跑)。表定义与 DDL 放同一个文件,免得加列只改一边。 */
export async function ensureTaskReadsSchema(client: Client): Promise<void> {
  await client.executeMultiple(`
    CREATE TABLE IF NOT EXISTS task_reads (
      owner TEXT NOT NULL, task_id TEXT NOT NULL, event TEXT NOT NULL,
      round INTEGER NOT NULL DEFAULT 0, read_at INTEGER NOT NULL,
      PRIMARY KEY (owner, task_id)
    );
  `);
  // 这张表的第一版没有 round(只在开发分支上跑过)：先问再补，理由同 schema-task-notice.ts。
  const columns = await client.execute("PRAGMA table_info(task_reads);");
  if (!columns.rows.some((row) => String((row as Record<string, unknown>).name) === "round")) {
    await client.executeMultiple("ALTER TABLE task_reads ADD COLUMN round INTEGER NOT NULL DEFAULT 0;");
  }
}
