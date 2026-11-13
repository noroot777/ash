// 删掉的任务留在磁盘上的东西：`data/runs/<任务>`（会话正文、原始日志、验收快照）和
// `data/scratch/<任务>`。
//
// 难点在顺序：任务行是在一个原子批里删掉的（task-delete-routes.ts），磁盘只能在那之后收，
// 而磁盘这一步会失败（权限、被占用的文件）。失败时任务已经不存在了——删除既不能因此报失败
// （那等于说任务还在），也不能把剩下的东西扔给运气：任务行一没，就再也没有入口知道这个目录
// 是谁的。所以删行**之前**先落一张待办（`.pending-delete/<任务>`），磁盘真收干净了才撕掉；
// 收不掉就留着，由 run-disk-maintenance.ts 定时重试。删行本身失败（任务还在）时撤掉待办，
// 进程正好死在中间留下的那张，重试时看到任务行还在也会撤掉、什么都不删。
//
// 删除用异步的 `fs/promises.rm`：一个带整仓快照的任务目录有几十万个文件，同步删会把整个
// 服务卡住。
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { tasks } from "./db/schema.js";
import { DATA_DIR, RUNS_DIR } from "./paths.js";
import { now } from "./util.js";

const pendingDir = () => join(RUNS_DIR, ".pending-delete");
const pendingPath = (taskId: string) => join(pendingDir(), taskId);

/** 删任务行之前落待办。写不进去也不拦删除：最坏是回到「失败了没人重试」的老样子。 */
export function markTaskDiskPending(taskId: string): void {
  try {
    mkdirSync(pendingDir(), { recursive: true });
    writeFileSync(pendingPath(taskId), `${now()}\n`);
  } catch (error) {
    console.error(`[ash] 删除任务的磁盘待办没能落下（${taskId}）:`, error);
  }
}

export function clearTaskDiskPending(taskId: string): void {
  rmSync(pendingPath(taskId), { force: true });
}

/** 收一个已删任务的磁盘目录。两处各自尝试、互不拦；都收干净才撕待办。返回是否收干净。 */
export async function reclaimDeletedTaskDisk(taskId: string): Promise<boolean> {
  let clean = true;
  for (const dir of [join(RUNS_DIR, taskId), join(DATA_DIR, "scratch", taskId)]) {
    try {
      await rm(dir, { recursive: true, force: true });
    } catch (error) {
      clean = false;
      console.error(`[ash] 已删除任务的目录没能收掉，稍后重试（${dir}）:`, error);
    }
  }
  if (clean) clearTaskDiskPending(taskId);
  return clean;
}

/** 定时重试：任务行还在的待办是删除没成，撤掉；不在的接着收。返回这一趟收干净的个数。 */
export async function sweepPendingTaskDisk(): Promise<number> {
  let ids: string[];
  try {
    ids = readdirSync(pendingDir());
  } catch {
    return 0;
  }
  let reclaimed = 0;
  for (const taskId of ids) {
    const alive = (await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, taskId))).length > 0;
    if (alive) clearTaskDiskPending(taskId);
    else if (await reclaimDeletedTaskDisk(taskId)) reclaimed++;
  }
  return reclaimed;
}
