import type { RestartImpact } from "./reattach.js";
import { releaseRuntimeHandover, reserveRuntimeHandover, runtimeHandoverMatches } from "./runtime-handover-state.js";

type HeldTurn = { taskId: string; seq: number; token: string | null; role: string };

export async function acquireRuntimeHandover(assess: () => Promise<RestartImpact>, held: () => HeldTurn[],
  preparation?: { seal(lease: string): Promise<void>; checkpoint(impact: RestartImpact, lease: string): Promise<void> }) {
  const lease = reserveRuntimeHandover();
  if (!lease) return { error: "另一处正在接管服务" };
  let keep = false;
  try {
    const before = new Map(held().map((turn) => [turn.taskId, turn.seq]));
    await preparation?.seal(lease);
    const impact = await assess();
    if (impact.interrupted.length || impact.resumes.length) return { error: "旧服务继续运行，稍后再接管" };
    await preparation?.checkpoint(impact, lease);
    const final = preparation ? await assess() : impact;
    if (final.interrupted.length || final.resumes.length || final.runtimeHandover?.blocked.length
      || final.survives.length !== impact.survives.length || final.survives.some((task) => !impact.survives.some((old) => old.id === task.id && old.pid === task.pid))) {
      return { error: "准备期间任务状态变化，未停止服务" };
    }
    const survivors = new Set(impact.survives.map((task) => task.id));
    if (!runtimeHandoverMatches(lease) || held().some((turn) => !survivors.has(turn.taskId) || !turn.token
      || !["single", "reviewer"].includes(turn.role) || before.get(turn.taskId) !== turn.seq)) {
      return { error: "仍有任务正在起跑或结算，稍后再接管" };
    }
    keep = true;
    return { lease };
  } finally {
    if (!keep) releaseRuntimeHandover(lease);
  }
}
