// ── 任务通知:被挡回的用户操作 ─────────────────────────────────────────────────
// 「用户点了某个按钮,系统拒绝执行」这件事的**持久记录**。
//
// 为什么要一张自己的表,而不是写进会话正文:会话正文(`appendTaskTimeline`)依赖这个任务
// **至少跑过一次** —— 没有会话就没有 transcript 文件可写,那条路只会 return false 加一行
// warn。而「点运行被同队前项挡回」恰恰最常发生在一个**从没跑过**的任务上(它刚被排进队列),
// 于是最该留痕的那一档反而一个字都留不下:用户只看见一个一闪而过的 toast,刷新之后什么都
// 没有,他第二次点、第三次点,最后得出结论「按钮坏了」(2026-10-26 实测用户两次误判)。
// AGENTS.md 的判据是「用户刷新页面后仍能看出我点过」,所以存储不能依赖会话。
//
// 表很小,也不参与任何调度语义:只读、只增,展示完就过期(读取侧按时间窗过滤)。
import { index, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { Client } from "./node-sqlite-client.js";

export const taskNotices = sqliteTable(
  "task_notices",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id").notNull(),
    /** 用户点的是什么(`RejectedAction`,例如「运行」「派审查」)。 */
    action: text("action").notNull(),
    /** 为什么没执行 —— 原样存那句给人看的话。 */
    reason: text("reason").notNull(),
    occurredAt: text("occurred_at").notNull(),
  },
  (t) => ({ taskIdx: index("task_notices_task_idx").on(t.taskId, t.occurredAt) }),
);

/** 建表(幂等,每次启动都跑)。表定义与 DDL 放同一个文件,免得加列只改一边。 */
export async function ensureTaskNoticeSchema(client: Client): Promise<void> {
  await client.executeMultiple(`
    CREATE TABLE IF NOT EXISTS task_notices (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, action TEXT NOT NULL,
      reason TEXT NOT NULL, occurred_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS task_notices_task_idx ON task_notices (task_id, occurred_at);
  `);
}
