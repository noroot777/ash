import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inspectProcessSync, isPidAlive, isProcessGroupAlive, killTree, listProcesses } from "./platform.js";
import { RUNS_DIR } from "./paths.js";
import type { PreviewRecord } from "./preview-store.js";

type Target = { pid: number; startedAt: string | null };
export type PreviewStopResult = { stopped: true } | { stopped: false; message: string };
const pendingMessage = "已请求停止预览，但仍有进程未退出；后台会继续检查。";
const alive = (target: Target) => isPidAlive(target.pid) || isProcessGroupAlive(target.pid);

function pendingFiles(taskId: string): string[] {
  const dir = join(RUNS_DIR, taskId);
  try { return readdirSync(dir).filter(name => /^preview-stop-[a-f0-9-]+\.json$/.test(name)).map(name => join(dir, name)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}

export const hasPendingPreviewStops = (taskId: string): boolean => pendingFiles(taskId).length > 0;

async function terminate(file: string, targets: Target[], signalable = targets): Promise<PreviewStopResult> {
  for (const target of signalable) if (alive(target)) killTree(target.pid, "SIGTERM");
  const started = Date.now();
  let forced = false;
  while (targets.some(alive) && Date.now() - started < 5000) {
    if (!forced && Date.now() - started >= 2000) {
      for (const target of signalable) if (alive(target)) killTree(target.pid, "SIGKILL");
      forced = true;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  if (targets.some(alive)) return { stopped: false, message: pendingMessage };
  rmSync(file, { force: true });
  return { stopped: true };
}

export async function stopPreviewProcesses(taskId: string, record: Pick<PreviewRecord, "pid" | "installPid" | "services">): Promise<PreviewStopResult> {
  const roots = [...new Set([record.pid, record.installPid ?? 0, ...(record.services ?? []).map(service => service.pid)])]
    .filter(pid => Number.isInteger(pid) && pid > 1 && pid !== process.pid);
  if (!roots.length) return { stopped: true };
  const processes = await listProcesses();
  const descendants = new Set(roots);
  for (let previous = -1; previous !== descendants.size;) {
    previous = descendants.size;
    for (const row of processes) if (descendants.has(row.ppid) && row.pid !== process.pid) descendants.add(row.pid);
  }
  const targets = [...descendants].reverse().map(pid => ({ pid,
    startedAt: processes.find(row => row.pid === pid)?.startedAt ?? inspectProcessSync(pid)?.startedAt ?? null,
  }));
  // 停止记录独立于当前预览代，关闭/启动失败后仍能找到已被重新托管的后台子进程。
  // 启动时间用来区分后续复查时被复用的 PID；它们不再是可回收的旧进程。
  const dir = join(RUNS_DIR, taskId);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `preview-stop-${randomUUID()}.json`);
  writeFileSync(file, JSON.stringify(targets));
  return terminate(file, targets);
}

export async function retryPreviewStops(taskId: string): Promise<PreviewStopResult> {
  const files = pendingFiles(taskId);
  if (!files.length) return { stopped: true };
  for (const file of files) {
    let targets: Target[];
    try { targets = JSON.parse(readFileSync(file, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; return { stopped: false, message: pendingMessage }; }
    if (!Array.isArray(targets) || targets.some(target => !target || !Number.isInteger(target.pid) || target.pid <= 1 || target.pid === process.pid
      || (target.startedAt !== null && typeof target.startedAt !== "string"))) return { stopped: false, message: pendingMessage };
    const processes = await listProcesses();
    const signalable: Target[] = [];
    targets = targets.filter(target => {
      if (!isPidAlive(target.pid)) { signalable.push(target); return isProcessGroupAlive(target.pid); }
      const startedAt = processes.find(row => row.pid === target.pid)?.startedAt ?? inspectProcessSync(target.pid)?.startedAt;
      if (target.startedAt && startedAt && target.startedAt !== startedAt) return false;
      if (target.startedAt && startedAt) signalable.push(target);
      return true;
    });
    await terminate(file, targets, signalable);
  }
  return hasPendingPreviewStops(taskId) ? { stopped: false, message: pendingMessage } : { stopped: true };
}
