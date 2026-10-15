// 落库资格:**跟写在同一条原子语句组里**,不是写之前问一句。
//
// 内存门闸(claude-monitor-revoked.ts)解决的是「删除期间别再写」,但它关不住这个窗口:
//
//   writer: 问门闸 —— 还开着           ← 任务此刻确实还在
//           await …（让出事件循环）
//                                  删除整批提交,任务和它的行都没了
//           插入                      ← 孤儿行,再也没有入口能清掉它
//
// 把「任务行还在吗」做成跟写同一个批里的第二条语句,这个窗口就不存在了:`db.batch` 在一个
// BEGIN…COMMIT 里**同步**跑完两条语句,中间没有 await、也就没有别人插进来的机会。任务要是
// 已经没了,第二条当场把刚写的那些行收走 —— 净效果是「任务还在才留得下」。
//
// 为什么不用 `db.transaction`:它的函数体里每个 await 都是一个让出点,同一条连接上别人的
// 语句会被卷进这个事务(`db/node-sqlite-client.ts`:整个进程共用一条连接)。`batch` 收的是
// 一组**已经造好**的语句,执行期一步到底。
//
// 另注意:**只有 INSERT 需要这道闸**。UPDATE/DELETE 打在已经删掉的行上命中 0 行,留不下
// 任何东西;只有插入能凭空造出孤儿。
import { and, eq, notExists, sql, type SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { db } from "./db/index.js";
import { tasks } from "./db/schema.js";

/** 「这个任务行此刻不在」——子查询,所以它和主语句一起被求值。 */
export const taskGone = (taskId: string): SQL =>
  notExists(db.select({ one: sql`1` }).from(tasks).where(eq(tasks.id, taskId)));

/**
 * 写一条(或一批)监听相关的行,**任务不在就不留下**。
 *
 * @param write 要落的那条写语句（造好但别执行）
 * @param purge 任务不在时把这次写的那些行收走的删除语句；一律带上 `taskGone(taskId)`
 */
export async function writeIfTaskAlive(
  write: BatchItem<"sqlite">, purge: BatchItem<"sqlite">,
): Promise<void> {
  await db.batch([write, purge]);
}

/** 配套的 WHERE:这个任务在这张表上的行,**且**任务已经不在了 ⇒ 它们全是孤儿。 */
export const orphanRows = <T extends { taskId: Parameters<typeof eq>[0] }>(
  table: T, taskId: string,
): SQL => and(eq(table.taskId, taskId), taskGone(taskId))!;
