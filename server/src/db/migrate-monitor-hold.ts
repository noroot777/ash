// 升级那一刻已经停在那儿等哨兵的暂停,补上 `tasks.monitor_hold_at`(语义见 queue-monitor-hold.ts)。
//
// 新写的暂停在落库那一笔就带上了它;存量行没有。队列读成员时也会补(`withMonitorHolds`),但开机
// 补办那一趟要是没读成,哨兵随后在接回时落 lost,就再没有「此刻在等」可以观察了。所以在 DDL 之后、
// 任何恢复之前,按哨兵行把明摆着在等的那几位先盖上:还在跑的、结局已定通知还没入队的,且不是
// 审查那边起的(审查哨兵不挡执行,见 task-complete-monitors.ts)。多盖的代价是一次幂等的推进。
import type { Client } from "./node-sqlite-client.js";

export async function backfillMonitorHolds(client: Client): Promise<void> {
  try {
    await client.execute({
      sql: `UPDATE tasks SET monitor_hold_at = ? WHERE status = 'paused' AND monitor_hold_at IS NULL
        AND id IN (SELECT task_id FROM monitors WHERE kind = 'ash' AND source_review_run IS NULL
          AND (status = 'running' OR (result_handoff_at IS NOT NULL AND results_abandoned_at IS NULL)))`,
      args: [new Date().toISOString()],
    });
  } catch (e) {
    console.warn("[ash] 补记存量「在等哨兵」失败,忽略(队列读成员时还会补):", e);
  }
}
