import type { RestartImpact } from "./reattach.js";
import { releaseRuntimeHandover, reserveRuntimeHandover, runtimeHandoverActive } from "./runtime-handover-state.js";

type HeldTurn = { taskId: string; seq: number; token: string | null; role: string };

export async function acquireRuntimeHandover(assess: () => Promise<RestartImpact>, held: () => HeldTurn[]) {
  const lease = reserveRuntimeHandover();
  if (!lease) return { error: "另一处正在接管服务" };
  let keep = false;
  try {
    const before = new Map(held().map((turn) => [turn.taskId, turn.seq]));
    const impact = await assess();
    if (impact.interrupted.length || impact.resumes.length) return { error: "旧服务继续运行，稍后再接管" };
    const survivors = new Set(impact.survives.map((task) => task.id));
    if (!runtimeHandoverActive() || held().some((turn) => !survivors.has(turn.taskId) || !turn.token
      || !["single", "reviewer"].includes(turn.role) || before.get(turn.taskId) !== turn.seq)) {
      return { error: "仍有任务正在起跑或结算，稍后再接管" };
    }
    keep = true;
    return { lease };
  } finally {
    if (!keep) releaseRuntimeHandover(lease);
  }
}
