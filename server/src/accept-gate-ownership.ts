import { and, eq, or } from "drizzle-orm";
import { db } from "./db/index.js";
import { acceptGateRuns } from "./db/schema.js";
import { gateTreeAlive, stopAcceptGate } from "./accept-gate-process.js";
import { readGateLaunch } from "./accept-gate-launch.js";

type Ownership = { taskId: string; pid: number | null; startedAt: string | null; stopping: boolean; logPath?: string };
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
    if (owned.has(row.id)) continue;
    claimGateProcess(row.id, taskId, row.logPath);
    attachGateProcess(row.id, row.pid, row.pidStartedAt, true);
  }
  for (const [runId, mark] of owned) {
    if (mark.taskId !== taskId || !mark.stopping || stops.has(runId)) continue;
    const stopped = readGateLaunch(mark.logPath)?.phase === "stopped"
      || (mark.pid && !gateTreeAlive(mark.pid, mark.startedAt, mark.logPath));
    if (stopped) await stopGateRun(runId);
  }
}

export async function releaseGateProcess(runId: string): Promise<void> {
  await db.update(acceptGateRuns).set({ processPending: false }).where(eq(acceptGateRuns.id, runId));
  owned.delete(runId);
}

export function stopGateRun(runId: string): Promise<boolean> {
  const pending = stops.get(runId);
  if (pending) return pending;
  const mark = owned.get(runId);
  if (!mark) return Promise.resolve(true);
  mark.stopping = true;
  const stop = (async () => {
    if (!await stopAcceptGate(mark.taskId, mark.pid, mark.startedAt, mark.logPath)) return false;
    await releaseGateProcess(runId);
    return true;
  })().finally(() => stops.delete(runId));
  stops.set(runId, stop);
  return stop;
}

export async function stopOwnedGateProcesses(taskId: string): Promise<boolean> {
  await reconcileGateProcesses(taskId);
  const results = await Promise.all([...owned].filter(([, mark]) => mark.taskId === taskId)
    .map(([runId]) => stopGateRun(runId)));
  return results.every(Boolean);
}
