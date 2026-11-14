// macOS 上留下的验收快照，等任务了结时回收。
//
// 结算时 macOS 那一档刻意不删快照（accept-gate-settle.ts 的 cleanupGateSnapshot）：兼容监督
// 认不全脱离进程组的后代，结算那一刻删目录可能正抽掉某个还在跑的东西的 cwd。但快照本身
// 只在那次结算里被读一次（verifyGateSnapshot），之后再没有代码读它。任务一旦验收、归档或
// 删除，就不会再有门禁围着它跑，「怕误伤还在跑的后代」也就不再成立——留着只是占地方
// （实测每份 80M～1G，带 .venv / node_modules 的整仓副本，不到三周攒了 15G）。
//
// 回收点：验收落章、归档、删除各当场收一次；启动时和之后每 6 小时再整体扫一遍
// （run-disk-maintenance.ts），补上存量和那几处没收成的。配了准备命令的那一档快照住在 RUNS_DIR 之外的
// 独立根下（accept-gate-isolated.ts），两个根一起扫。
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { acceptGateRuns, tasks } from "./db/schema.js";
import { RUNS_DIR } from "./paths.js";
import { removeGateSnapshot } from "./accept-gate-source.js";
import { GATE_ISOLATED_DIR } from "./accept-gate-isolated.js";
import { acceptGateLogPath, appendGateLog } from "./accept-gate-process.js";
import { now } from "./util.js";

const SNAPSHOT = /^accept-gate-(.+)\.source$/;

const SNAPSHOT_ROOTS = [RUNS_DIR, GATE_ISOLATED_DIR];

function snapshotRuns(taskId: string): string[] {
  return [...new Set(SNAPSHOT_ROOTS.flatMap((root) => {
    try {
      return readdirSync(join(root, taskId)).flatMap((name) => {
        const run = SNAPSHOT.exec(name)?.[1];
        return run && statSync(join(root, taskId, name)).isDirectory() ? [run] : [];
      });
    } catch {
      return [];
    }
  }))];
}

/** 任务还在不在需要快照的那段生命周期里：删了、归档了、验收了都算了结。 */
async function taskConcluded(taskId: string): Promise<boolean> {
  const row = (await db.select({ archived: tasks.archived, stage: tasks.stage }).from(tasks).where(eq(tasks.id, taskId))).at(0);
  return !row || row.archived || row.stage === "accepted";
}

/**
 * 收掉一个**已了结**任务名下的全部验收快照；任务还在进行就什么都不做。
 *
 * 先列目录、后查库：门禁是先插 running 行、再建快照（accept-gate.ts），所以列到的每一份
 * 新快照，查库时都看得到它那条还在跑的行——不会把刚建出来的那份当成残留删掉。
 * 还在跑、或进程还没确认收干净（processPending）的那一次一律不碰。
 */
export async function reclaimGateSnapshots(taskId: string): Promise<number> {
  const runs = snapshotRuns(taskId);
  if (!runs.length || !await taskConcluded(taskId)) return 0;
  const rows = await db.select({ id: acceptGateRuns.id, status: acceptGateRuns.status, processPending: acceptGateRuns.processPending })
    .from(acceptGateRuns).where(eq(acceptGateRuns.taskId, taskId));
  const busy = new Set(rows.filter((row) => row.status === "running" || row.processPending).map((row) => row.id));
  let removed = 0;
  for (const runId of runs) {
    if (busy.has(runId)) continue;
    try {
      await removeGateSnapshot(taskId, runId);
      const logPath = acceptGateLogPath(taskId, runId);
      if (existsSync(logPath)) appendGateLog(logPath, `\n[ash] ${now()} 任务已了结，独立测试快照已回收\n`);
      removed++;
    } catch (error) {
      console.error(`[ash] 回收验收快照失败（${taskId}/${runId}）:`, error);
    }
  }
  return removed;
}

/** 启动时整体扫一遍：每个带快照的任务目录都按 reclaimGateSnapshots 的判据过一次。 */
export async function sweepGateSnapshots(): Promise<number> {
  const taskIds = [...new Set(SNAPSHOT_ROOTS.flatMap((root) => {
    try { return readdirSync(root); } catch { return []; }
  }))];
  let removed = 0;
  for (const taskId of taskIds) removed += await reclaimGateSnapshots(taskId);
  return removed;
}
