// 开机那一次清扫:**ash 自己重启了,得重新判一次谁还活着**。
//
// 从 claude-monitors.ts 拆出来,是因为那份文件顶到了 700 行上限,而这一段是其中最独立的
// 一块:它不碰 `ClaudeMonitorTrace` 的任何内部状态,只在启动时被 index.ts 调一次,跟同样
// 只在启动时跑的 `sweepOrphanClaudeMonitors`(claude-monitor-backfill.ts)是一对。
import { and, eq, inArray } from "drizzle-orm";
import { bus } from "./bus.js";
import { createLivenessProbe } from "./claude-monitor-liveness.js";
import { db, dbClient } from "./db/index.js";
import { monitors } from "./db/schema.js";
import { now } from "./util.js";

/**
 * 开机收拾上一个 server 留下的 claude 投影 —— **只收来源进程确实已经不在的那些**。
 *
 * 这些行没有 pid，`reattachMonitors` 按 `kind` 把它们整批跳过了（它只认 ash 自己起的
 * 进程），所以必须有人来管；但判据不能是「本进程的账本里没有它」—— **agent 活得过 ash
 * 重启**（detached，见 executors/detached.ts），无条件标 lost 会让用户看到「任务还在输出、
 * 哨兵却说进程已不在」。判据本体和它栽过的三次跟头都在 `claude-monitor-liveness.ts`，
 * 那边是回填与这里共用的唯一一份。
 *
 * 与 `finishAll()` 的分工：那边管「agent 进程正常结束」的常规路径，这边只兜「ash 自己重启
 * 了，得重新判一次谁还活着」。
 */
export async function loseDeadClaudeMonitors(): Promise<{ kept: number; lost: number }> {
  if (dbClient.closed) return { kept: 0, lost: 0 };
  const rows = await db
    .select({
      id: monitors.id,
      taskId: monitors.taskId,
      cliSessionId: monitors.cliSessionId,
      sourcePid: monitors.sourcePid,
      sourcePidStartedAt: monitors.sourcePidStartedAt,
    })
    .from(monitors)
    .where(and(eq(monitors.kind, "claude"), eq(monitors.status, "running")));
  if (!rows.length) return { kept: 0, lost: 0 };

  // 存活判据只有一份，住在 claude-monitor-liveness.ts——回填那边问的是同一个问题
  // （「历史里没读到终态，是早就没了还是现在还在盯着」），两处必须给出同一个答案。
  const probe = createLivenessProbe();

  const dead: { id: string; taskId: string }[] = [];
  let kept = 0;
  for (const row of rows) {
    const live = await probe.sourceAlive(row);
    if (live) kept += 1;
    else dead.push({ id: row.id, taskId: row.taskId });
  }
  if (dead.length) {
    await db.update(monitors).set({
      status: "lost",
      endedAt: now(),
      endedReason: "起它的那个智能体进程已经不在了（ash 重启后确认）",
    }).where(and(
      inArray(monitors.id, dead.map((r) => r.id)),
      eq(monitors.status, "running"),
    ));
    for (const taskId of new Set(dead.map((r) => r.taskId))) bus.publish({ type: "task.monitors", taskId });
  }
  return { kept, lost: dead.length };
}
