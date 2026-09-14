import { randomUUID } from "node:crypto";
import { appendFileSync, lstatSync, mkdirSync, readFileSync, readlinkSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { inspectProcessSync, isPidAlive, isProcessGroupAlive, killTree, listProcesses } from "./platform.js";
import { RUNS_DIR } from "./paths.js";
import { recordPath, type PreviewRecord } from "./preview-store.js";
import { heldCacheOf } from "./preview-deps.js";
import { appendTaskTimeline } from "./task-timeline.js";

type Target = { pid: number; startedAt: string | null; observedAt?: number };
type HeldLink = { path: string; target: string; cache: string | null; dev: number; ino: number };
type StopRecord = { targets: Target[]; links: HeldLink[]; gen?: string; pid?: number };
export type PreviewStopResult = { stopped: true } | {
  stopped: false;
  reason: "process_pending" | "record_error" | "start_pending" | "replaced";
  message: string;
};
const pendingMessage = "已请求停止预览，但仍有进程未退出；后台会继续检查。";
const identityMessage = "预览进程仍存活，但暂时无法确认启动身份；后台会继续检查。";
const alive = (target: Target) => isPidAlive(target.pid) || isProcessGroupAlive(target.pid);

export function previewStopFailure(error: unknown): Extract<PreviewStopResult, { stopped: false }> {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return { stopped: false, reason: "record_error", message: `预览停止记录暂时无法读写${code ? `（${code}）` : ""}；请检查任务记录目录权限或磁盘状态后重试。` };
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

function writeStopRecord(file: string, record: StopRecord): void {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(record), { flag: "wx" });
    renameSync(temp, file);
  } finally { rmSync(temp, { force: true }); }
}

function captureLinks(paths: readonly string[]): HeldLink[] {
  return [...new Set(paths)].flatMap(path => {
    try {
      const stat = lstatSync(path);
      return stat.isSymbolicLink() ? [{ path, target: readlinkSync(path), cache: heldCacheOf(path), dev: stat.dev, ino: stat.ino }] : [];
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  });
}

function isHeldLink(value: unknown): value is HeldLink {
  const link = value as HeldLink | null;
  return !!link && typeof link.path === "string" && typeof link.target === "string"
    && (link.cache === null || typeof link.cache === "string") && typeof link.dev === "number" && typeof link.ino === "number";
}

function savedRecord(value: unknown): StopRecord | null {
  if (Array.isArray(value)) return { targets: value, links: [] }; // 旧版本只保存进程数组。
  const record = value as StopRecord | null;
  return record && Array.isArray(record.targets) && Array.isArray(record.links) && record.links.every(isHeldLink) ? record : null;
}

/** 待退出的进程仍持有原缓存，即使当前预览已归档或软链已被重挂。 */
export function pendingPreviewCaches(taskId: string): string[] | null {
  try {
    return pendingFiles(taskId).flatMap(file => savedRecord(JSON.parse(readFileSync(file, "utf8")))?.links.flatMap(link => link.cache ? [link.cache] : []) ?? []);
  } catch { return null; } // 无法读出持有清单时，这趟缓存清理暂缓。
}

function releaseLinks(taskId: string, file: string, record: StopRecord): boolean {
  if (!record.links.length) return true;
  let current: PreviewRecord | null = null;
  try { current = JSON.parse(readFileSync(recordPath(taskId), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  // 新一代可能直接复用旧软链，没有重新挂链；它退出前仍由这份停止记录保管。
  if (current && (record.gen !== undefined ? current.gen !== record.gen : current.pid !== record.pid)) return false;
  for (const other of pendingFiles(taskId)) {
    if (other === file) continue;
    const saved = savedRecord(JSON.parse(readFileSync(other, "utf8")));
    if (saved?.targets.filter(recoverableTarget).some(alive) && saved.links.some(link => record.links.some(own => own.path === link.path && own.target === link.target))) return false;
  }
  for (const link of record.links) {
    try {
      const stat = lstatSync(link.path);
      if (stat.isSymbolicLink() && stat.dev === link.dev && stat.ino === link.ino && readlinkSync(link.path) === link.target) rmSync(link.path, { force: true });
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return true;
}

function recoverableTarget(value: unknown): value is Target {
  const target = value as Target | null;
  return !!target && Number.isInteger(target.pid) && target.pid > 1 && target.pid !== process.pid
    && ((typeof target.startedAt === "string" && target.startedAt.trim().length > 0)
      || (target.startedAt === null && Number.isSafeInteger(target.observedAt) && target.observedAt! > 0));
}

async function discardInvalidTargets(taskId: string, file: string, reason: string, valid?: StopRecord): Promise<void> {
  if (valid && (valid.targets.length || valid.links.length)) writeStopRecord(file, valid);
  else rmSync(file, { force: true });
  const notice = `预览停止记录 ${basename(file)}：${reason}，已移除无效条目；未向这些条目对应的 PID 发送停止信号。`;
  if (!await appendTaskTimeline(taskId, notice)) appendFileSync(join(RUNS_DIR, taskId, "preview.log"), `${notice}\n`);
}

async function terminate(taskId: string, file: string, record: StopRecord, signalable = record.targets): Promise<PreviewStopResult> {
  const { targets } = record;
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
  if (targets.some(alive)) return { stopped: false, reason: "process_pending", message: targets.some(target => !target.startedAt && alive(target)) ? identityMessage : pendingMessage };
  if (!releaseLinks(taskId, file, record)) return { stopped: false, reason: "process_pending", message: "预览依赖仍被其他预览进程使用；后台会继续检查。" };
  rmSync(file, { force: true });
  return { stopped: true };
}

export async function stopPreviewProcesses(taskId: string, record: Pick<PreviewRecord, "pid" | "installPid" | "services" | "links" | "gen">): Promise<PreviewStopResult> {
  const links = captureLinks(record.links ?? []);
  const roots = [...new Set([record.pid, record.installPid ?? 0, ...(record.services ?? []).map(service => service.pid)])]
    .filter(pid => Number.isInteger(pid) && pid > 1 && pid !== process.pid);
  if (!roots.length && !links.length) return { stopped: true };
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
  if (!targets.length && !links.length) return { stopped: true };
  // 停止记录独立于当前预览代，关闭/启动失败后仍能找到已被重新托管的后台子进程。
  // 启动时间用来区分后续复查时被复用的 PID；它们不再是可回收的旧进程。
  const dir = join(RUNS_DIR, taskId);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `preview-stop-${randomUUID()}.json`);
  const saved = { targets, links, gen: record.gen, pid: record.pid };
  writeStopRecord(file, saved);
  return terminate(taskId, file, saved);
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
  try { return pendingFiles(taskId).length ? { stopped: false, reason: "process_pending", message: pendingMessage } : pending; }
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
  const record = savedRecord(saved);
  if (!record) {
    await discardInvalidTargets(taskId, file, "记录格式无效");
    return { stopped: true };
  }
  let targets = record.targets.filter(recoverableTarget);
  if (targets.length !== record.targets.length) await discardInvalidTargets(taskId, file,
    `${record.targets.length - targets.length} 个条目缺少有效进程身份或指向 ash 自身`, { ...record, targets });
  if (!targets.length && !record.links.length) { rmSync(file, { force: true }); return { stopped: true }; }
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
  const next = { ...record, targets };
  writeStopRecord(file, next);
  return terminate(taskId, file, next, signalable);
}
