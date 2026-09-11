import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { inspectProcessSync, isPidAlive, isProcessGroupAlive, killTree, listProcesses } from "./platform.js";
import { RUNS_DIR } from "./paths.js";
import type { PreviewRecord } from "./preview-store.js";
import { appendTaskTimeline } from "./task-timeline.js";

type Target = { pid: number; startedAt: string | null; observedAt?: number };
export type PreviewStopResult = { stopped: true } | { stopped: false; message: string };
const pendingMessage = "已请求停止预览，但仍有进程未退出；后台会继续检查。";
const identityMessage = "预览进程仍存活，但暂时无法确认启动身份；后台会继续检查。";
const alive = (target: Target) => isPidAlive(target.pid) || isProcessGroupAlive(target.pid);

export function previewStopFailure(error: unknown): Extract<PreviewStopResult, { stopped: false }> {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return { stopped: false, message: `预览停止记录暂时无法读写${code ? `（${code}）` : ""}；请检查任务记录目录权限或磁盘状态后重试。` };
}

function pendingFiles(taskId: string): string[] {
  const dir = join(RUNS_DIR, taskId);
  try { return readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isFile() && /^preview-stop-[a-f0-9-]+\.json$/.test(entry.name)).map(entry => join(dir, entry.name)); }
  catch (error) { if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return []; throw error; }
}

export function hasPendingPreviewStops(taskId: string): boolean {
  try { return pendingFiles(taskId).length > 0; }
  catch { return true; }
}

function writeTargets(file: string, targets: Target[]): void {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(targets), { flag: "wx" });
    renameSync(temp, file);
  } finally { rmSync(temp, { force: true }); }
}

function recoverableTarget(value: unknown): value is Target {
  const target = value as Target | null;
  return !!target && Number.isInteger(target.pid) && target.pid > 1 && target.pid !== process.pid
    && ((typeof target.startedAt === "string" && target.startedAt.trim().length > 0)
      || (target.startedAt === null && Number.isSafeInteger(target.observedAt) && target.observedAt! > 0));
}

async function discardInvalidTargets(taskId: string, file: string, reason: string, valid: Target[] = []): Promise<void> {
  if (valid.length) writeTargets(file, valid);
  else rmSync(file, { force: true });
  const notice = `预览停止记录 ${basename(file)}：${reason}，已移除无效条目；未向这些条目对应的 PID 发送停止信号。`;
  if (!await appendTaskTimeline(taskId, notice)) appendFileSync(join(RUNS_DIR, taskId, "preview.log"), `${notice}\n`);
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
  if (targets.some(alive)) return { stopped: false, message: targets.some(target => !target.startedAt && alive(target)) ? identityMessage : pendingMessage };
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
  const observedAt = Date.now();
  const targets = [...descendants].reverse().map(pid => ({ pid, observedAt,
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
  let files: string[];
  try { files = pendingFiles(taskId); }
  catch (error) { return previewStopFailure(error); }
  let pending: PreviewStopResult = { stopped: true };
  for (const file of files) {
    try {
      const result = await retryStopFile(taskId, file);
      if (!result.stopped && pending.stopped) pending = result;
    } catch (error) { pending = previewStopFailure(error); }
  }
  if (!pending.stopped) return pending;
  try { return pendingFiles(taskId).length ? { stopped: false, message: pendingMessage } : pending; }
  catch (error) { return previewStopFailure(error); }
}

async function retryStopFile(taskId: string, file: string): Promise<PreviewStopResult> {
  let saved: unknown;
  try { saved = JSON.parse(readFileSync(file, "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { stopped: true };
    if (!(error instanceof SyntaxError)) throw error;
    await discardInvalidTargets(taskId, file, "内容损坏，无法读取进程身份");
    return { stopped: true };
  }
  if (!Array.isArray(saved)) {
    await discardInvalidTargets(taskId, file, "记录格式无效");
    return { stopped: true };
  }
  let targets = saved.filter(recoverableTarget);
  if (targets.length !== saved.length) await discardInvalidTargets(taskId, file,
    `${saved.length - targets.length} 个条目缺少有效进程身份或指向 ash 自身`, targets);
  if (!targets.length) { rmSync(file, { force: true }); return { stopped: true }; }
  const processes = await listProcesses();
  const signalable: Target[] = [];
  targets = targets.filter(target => {
    if (!isPidAlive(target.pid)) { signalable.push(target); return isProcessGroupAlive(target.pid); }
    const startedAt = processes.find(row => row.pid === target.pid)?.startedAt ?? inspectProcessSync(target.pid)?.startedAt;
    if (!target.startedAt && startedAt) {
      const created = Date.parse(startedAt);
      // 观测后出生的进程复用了 PID；更早出生才属于当时捕获的那条命。
      if (Number.isFinite(created) && created > target.observedAt!) return false;
      if (Number.isFinite(created)) target.startedAt = startedAt;
    }
    if (target.startedAt && startedAt && target.startedAt !== startedAt) return false;
    if (target.startedAt && startedAt) signalable.push(target);
    return true;
  });
  writeTargets(file, targets);
  return terminate(file, targets, signalable);
}
