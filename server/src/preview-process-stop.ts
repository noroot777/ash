import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { inspectProcessSync, isPidAlive, isProcessGroupAlive, killTree, listProcesses } from "./platform.js";
import { RUNS_DIR } from "./paths.js";
import type { PreviewRecord } from "./preview-store.js";
import { appendTaskTimeline } from "./task-timeline.js";

type Target = { pid: number; startedAt: string | null };
export type PreviewStopResult = { stopped: true } | { stopped: false; message: string };
const pendingMessage = "已请求停止预览，但仍有进程未退出；后台会继续检查。";
const alive = (target: Target) => isPidAlive(target.pid) || isProcessGroupAlive(target.pid);

function pendingFiles(taskId: string): string[] {
  const dir = join(RUNS_DIR, taskId);
  try { return readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isFile() && /^preview-stop-[a-f0-9-]+\.json$/.test(entry.name)).map(entry => join(dir, entry.name)); }
  catch (error) { if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return []; throw error; }
}

export const hasPendingPreviewStops = (taskId: string): boolean => pendingFiles(taskId).length > 0;

function writeTargets(file: string, targets: Target[]): void {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(targets), { flag: "wx" });
    renameSync(temp, file);
  } finally { rmSync(temp, { force: true }); }
}

function identifiedTarget(value: unknown): value is Target {
  const target = value as Target | null;
  return !!target && Number.isInteger(target.pid) && target.pid > 1 && target.pid !== process.pid
    && typeof target.startedAt === "string" && target.startedAt.trim().length > 0;
}

async function discardInvalidTargets(taskId: string, file: string, reason: string, valid: Target[] = []): Promise<void> {
  if (valid.length) writeTargets(file, valid);
  else rmSync(file, { force: true });
  await appendTaskTimeline(taskId, `预览停止记录 ${basename(file)}：${reason}，已移除无效条目；未向这些条目对应的 PID 发送停止信号。`);
}

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
  })).filter(alive);
  if (!targets.length) return { stopped: true };
  // 停止记录独立于当前预览代，关闭/启动失败后仍能找到已被重新托管的后台子进程。
  // 启动时间用来区分后续复查时被复用的 PID；它们不再是可回收的旧进程。
  const dir = join(RUNS_DIR, taskId);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `preview-stop-${randomUUID()}.json`);
  writeTargets(file, targets);
  return terminate(file, targets);
}

export async function retryPreviewStops(taskId: string): Promise<PreviewStopResult> {
  const files = pendingFiles(taskId);
  if (!files.length) return { stopped: true };
  for (const file of files) {
    let saved: unknown;
    try { saved = JSON.parse(readFileSync(file, "utf8")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      if (!(error instanceof SyntaxError)) throw error;
      await discardInvalidTargets(taskId, file, "内容损坏，无法读取进程身份");
      continue;
    }
    if (!Array.isArray(saved)) {
      await discardInvalidTargets(taskId, file, "记录格式无效");
      continue;
    }
    let targets = saved.filter(identifiedTarget);
    if (targets.length !== saved.length) await discardInvalidTargets(taskId, file,
      `${saved.length - targets.length} 个条目缺少有效进程身份或指向 ash 自身`, targets);
    if (!targets.length) { rmSync(file, { force: true }); continue; }
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
