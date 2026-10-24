import { and, eq, ne, or } from "drizzle-orm";
import { db } from "./db/index.js";
import { acceptGateRuns } from "./db/schema.js";
import { gateTreeAlive, stopAcceptGate } from "./accept-gate-process.js";

type Ownership = { taskId: string; pid: number | null; startedAt: string | null; stopping: boolean; logPath?: string;
  releaseDeferred?: boolean };
const owned = new Map<string, Ownership>();
const stops = new Map<string, Promise<boolean>>();

export function claimGateProcess(runId: string, taskId: string, logPath?: string): void {
  owned.set(runId, { taskId, pid: null, startedAt: null, stopping: false, logPath });
}

export function abandonUnstartedGateProcess(runId: string): void {
  const mark = owned.get(runId);
  if (mark && !mark.pid) owned.delete(runId);
}

export function attachGateProcess(runId: string, pid: number | null, startedAt: string | null, stopping = false): void {
  const mark = owned.get(runId);
  if (mark) Object.assign(mark, { pid, startedAt, stopping });
}

export function hasOwnedGateProcess(taskId: string): boolean {
  return [...owned.values()].some(mark => mark.taskId === taskId);
}

export function hasStoppingGateProcess(taskId: string): boolean {
  return [...owned.values()].some(mark => mark.taskId === taskId && mark.stopping);
}

export async function reconcileGateProcesses(taskId: string): Promise<void> {
  const rows = await db.select().from(acceptGateRuns).where(and(
    eq(acceptGateRuns.taskId, taskId), or(eq(acceptGateRuns.processPending, true), eq(acceptGateRuns.status, "running")),
  ));
  for (const row of rows) {
    if (!row.processPending) await db.update(acceptGateRuns).set({ processPending: true })
      .where(and(eq(acceptGateRuns.id, row.id), eq(acceptGateRuns.status, "running")));
    if (owned.has(row.id)) {
      if (row.status !== "running") allowGateProcessRelease(row.id);
      continue;
    }
    claimGateProcess(row.id, taskId, row.logPath);
    attachGateProcess(row.id, row.pid, row.pidStartedAt, true);
  }
  for (const [runId, mark] of owned) {
    if (mark.taskId !== taskId || !mark.stopping || stops.has(runId)) continue;
    const stopped = !gateTreeAlive(mark.pid ?? 0, mark.startedAt, mark.logPath);
    if (stopped) await stopGateRun(runId);
  }
}

export async function releaseGateProcess(runId: string): Promise<void> {
  const released = await db.update(acceptGateRuns).set({ processPending: false })
    .where(and(eq(acceptGateRuns.id, runId), ne(acceptGateRuns.status, "running")))
    .returning({ id: acceptGateRuns.id });
  if (released.length) forgetGateProcess(runId);
}

export function forgetGateProcess(runId: string): void {
  owned.delete(runId);
}

export function allowGateProcessRelease(runId: string): void {
  const mark = owned.get(runId);
  if (mark) mark.releaseDeferred = false;
}

export function stopGateRun(runId: string, release = true): Promise<boolean> {
  const mark = owned.get(runId);
  if (mark && !release) mark.releaseDeferred = true;
  const pending = stops.get(runId);
  if (pending) return pending.then(async stopped => {
    if (stopped && release && owned.has(runId) && !mark?.releaseDeferred) await releaseGateProcess(runId);
    return stopped;
  });
  if (!mark) return Promise.resolve(true);
  mark.stopping = true;
  const stop = (async () => {
    if (!await stopAcceptGate(mark.taskId, mark.pid, mark.startedAt, mark.logPath)) return false;
    if (release && !mark.releaseDeferred) await releaseGateProcess(runId);
    return true;
  })().finally(() => stops.delete(runId));
  stops.set(runId, stop);
  return stop;
}

export async function stopOwnedGateProcesses(taskId: string): Promise<boolean> {
  await reconcileGateProcesses(taskId);
  const results = await Promise.all([...owned].filter(([, mark]) => mark.taskId === taskId)
    .map(([runId]) => stopGateRun(runId)));
  return results.every(Boolean) && !hasOwnedGateProcess(taskId);
}
