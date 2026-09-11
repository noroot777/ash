import { isPidAlive, isProcessGroupAlive, listProcesses } from "./platform.js";
import { killByPid } from "./executors/spawn.js";
import type { PreviewRecord } from "./preview-store.js";

export async function stopPreviewProcesses(record: Pick<PreviewRecord, "pid" | "installPid" | "services">): Promise<void> {
  const roots = [...new Set([record.pid, record.installPid ?? 0, ...(record.services ?? []).map(service => service.pid)])].filter(pid => pid > 1);
  if (!roots.length) return;
  const processes = await listProcesses();
  const descendants = new Set(roots);
  for (let previous = -1; previous !== descendants.size;) {
    previous = descendants.size;
    for (const row of processes) if (descendants.has(row.ppid)) descendants.add(row.pid);
  }
  roots.forEach(killByPid);
  const alive = () => roots.some(isProcessGroupAlive) || [...descendants].some(isPidAlive);
  const deadline = Date.now() + 5000;
  while (alive() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  if (alive()) throw new Error("预览进程尚未完全退出，工作区已保留；请稍后重试验收。");
}
