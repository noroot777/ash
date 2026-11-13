// data/runs 里按「任务了结」回收的两样东西：验收快照（accept-gate-reclaim.ts）和原始事件流
// （run-trace-retention.ts）。启动时跑一次，之后每 6 小时再跑一次——ash 常常连开好几天，
// 只在启动时扫的话，保留期到了也要等下一次重启才兑现。
import { sweepGateSnapshots } from "./accept-gate-reclaim.js";
import { sweepRawTraces } from "./run-trace-retention.js";

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
}

export function startRunDiskMaintenance(): void {
  void sweepOnce();
  setInterval(() => void sweepOnce(), INTERVAL_MS).unref();
}
