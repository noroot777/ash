import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// 删掉的任务还欠着的磁盘清理（run-dir-reclaim.ts）。这一行跟任务行的删除写在**同一个原子批**里
// （task-delete-routes.ts）：任务删成了就一定有它，删不成就一定没有——后台只消费已提交的这一行，
// 不需要去猜某个请求是删成了还是失败了。磁盘真收干净才删行。
export const taskDiskCleanups = sqliteTable("task_disk_cleanups", {
  taskId: text("task_id").primaryKey(),
  createdAt: text("created_at").notNull(),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
});
