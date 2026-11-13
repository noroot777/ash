// data/runs 里按「任务了结」回收的东西：验收快照（accept-gate-reclaim.ts）、原始事件流
// （run-trace-retention.ts），以及删任务时没收干净、留了待办的目录（run-dir-reclaim.ts）。
// 启动时跑一次，之后每 6 小时再跑一次——ash 常常连开好几天，只在启动时扫的话，保留期到了
// 也要等下一次重启才兑现。
import { sweepGateSnapshots } from "./accept-gate-reclaim.js";
import { sweepRawTraces } from "./run-trace-retention.js";
import { sweepPendingTaskDisk } from "./run-dir-reclaim.js";

const INTERVAL_MS = 6 * 3600_000;

async function sweepOnce(): Promise<void> {
  const snapshots = await sweepGateSnapshots().catch((err) => {
    console.error("[ash] 验收快照回收失败（不影响运行）:", err);
    return 0;
  });
  if (snapshots) console.log(`[ash] 回收 ${snapshots} 份已了结任务的验收快照`);
  const traces = await sweepRawTraces().catch((err) => {
    console.error("[ash] 原始事件流回收失败（不影响运行）:", err);
    return { removed: 0, bytes: 0 };
  });
  if (traces.removed) console.log(`[ash] 回收 ${traces.removed} 份过了保留期的原始事件流（${(traces.bytes / 1048576).toFixed(1)} MB）`);
  const deleted = await sweepPendingTaskDisk().catch((err) => {
    console.error("[ash] 已删除任务的目录重试回收失败（不影响运行）:", err);
    return 0;
  });
  if (deleted) console.log(`[ash] 补收 ${deleted} 个已删除任务的目录`);
}

export function startRunDiskMaintenance(): void {
  void sweepOnce();
  setInterval(() => void sweepOnce(), INTERVAL_MS).unref();
}
