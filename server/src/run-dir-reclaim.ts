// 删掉的任务留在磁盘上的东西：`data/runs/<任务>`（会话正文、原始日志、验收快照）和
// `data/scratch/<任务>`。
//
// 难点在顺序：磁盘只能在任务行删掉之后收，而这一步会失败（权限、被占用的文件）。失败时任务
// 已经不存在了——删除不能因此报失败（那等于说任务还在），也不能把剩下的东西扔给运气：任务行
// 一没，就再也没有入口知道这个目录是谁的。所以清理责任（task_disk_cleanups 一行）跟删任务行
// 写在**同一个原子批**里（task-delete-routes.ts）：任务删成了就一定有这一行，删不成就一定没有。
// 后台只消费已经提交的行，不靠「任务行还在不在」去猜某个请求删成了没有；磁盘真收干净才删行，
// 收不掉就记下次数和原因，由 run-disk-maintenance.ts 定时重试。同一个编号可能被接力导入领回去，
// 所以真正动手删的那一段跟导入按编号互斥（task-dir-lock.ts）。
//
// 这里的每一步都不抛错：调用方此刻已经提交了删除，任何清理层的失败都只能变成「下次再来」，
// 不能改写那个已经成立的结果。删除用异步的 `fs/promises.rm`：一个带整仓快照的任务目录有
// 几十万个文件，同步删会把整个服务卡住。
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { db } from "./db/index.js";
import { taskDiskCleanups, tasks } from "./db/schema.js";
import { DATA_DIR, RUNS_DIR } from "./paths.js";
import { withTaskDirLock } from "./task-dir-lock.js";

/**
 * 收一个已删任务的磁盘目录。整段持这个编号的目录锁（task-dir-lock.ts），并在锁内重新确认任务
 * 行不在：同一个编号又被接力导入领回去了，目录就是那个活任务的，账作废、一个字节不动。两处
 * 目录各自尝试、互不拦；都收干净才销账。返回是否已了账（收干净或已作废）。
 */
export function reclaimDeletedTaskDisk(taskId: string): Promise<boolean> {
  return withTaskDirLock(taskId, async () => {
    try {
      if ((await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, taskId))).length) {
        await db.delete(taskDiskCleanups).where(eq(taskDiskCleanups.taskId, taskId));
        return true;
      }
    } catch (error) {
      console.error(`[ash] 没能确认任务 ${taskId} 是否还在，这一趟不动它的目录:`, error);
      return false;
    }
    const failures: string[] = [];
    for (const dir of [join(RUNS_DIR, taskId), join(DATA_DIR, "scratch", taskId)]) {
      try {
        await rm(dir, { recursive: true, force: true });
      } catch (error) {
        failures.push(`${dir}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    try {
      if (!failures.length) await db.delete(taskDiskCleanups).where(eq(taskDiskCleanups.taskId, taskId));
      else {
        console.error(`[ash] 已删除任务的目录没能收掉，稍后重试（${taskId}）:\n${failures.join("\n")}`);
        await db.update(taskDiskCleanups).set({ attempts: sql`${taskDiskCleanups.attempts} + 1`, lastError: failures.join("\n") })
          .where(eq(taskDiskCleanups.taskId, taskId));
      }
    } catch (error) {
      // 账没记上：行还在，下一趟照样会重试，只是少了这一次的次数和原因。
      console.error(`[ash] 磁盘清理的账没记上（${taskId}）:`, error);
    }
    return failures.length === 0;
  });
}

/** 定时重试全部欠着的清理。返回这一趟了账的个数。 */
export async function sweepPendingTaskDisk(): Promise<number> {
  let reclaimed = 0;
  for (const { taskId } of await db.select({ taskId: taskDiskCleanups.taskId }).from(taskDiskCleanups)) {
    if (await reclaimDeletedTaskDisk(taskId)) reclaimed++;
  }
  return reclaimed;
}
