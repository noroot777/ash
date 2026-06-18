// Registry of in-flight agent subprocesses, keyed by task, so a running task can
// be killed on demand (manual stop) — the orchestrator/debate register each live
// run here and the /stop API calls stopTask. A separate `canceling` set lets the
// run loops distinguish a user-requested kill (→ status canceled) from a crash
// (→ failed).

export interface Killable {
  kill(): void;
}

const handles = new Map<string, Set<Killable>>();
const canceling = new Set<string>();

export function trackRun(taskId: string, h: Killable): void {
  let set = handles.get(taskId);
  if (!set) handles.set(taskId, (set = new Set()));
  set.add(h);
}

export function untrackRun(taskId: string, h: Killable): void {
  const set = handles.get(taskId);
  if (!set) return;
  set.delete(h);
  if (!set.size) handles.delete(taskId);
}

// True if the task has at least one live subprocess (i.e. it can be stopped).
export function isRunning(taskId: string): boolean {
  return (handles.get(taskId)?.size ?? 0) > 0;
}

// Request a stop: flag the task as canceling and kill its live subprocess(es).
// Returns false if nothing was running (nothing to stop).
export function stopTask(taskId: string): boolean {
  const set = handles.get(taskId);
  if (!set || !set.size) return false;
  canceling.add(taskId);
  for (const h of set) {
    try {
      h.kill();
    } catch {
      /* best effort */
    }
  }
  return true;
}

export function isCanceling(taskId: string): boolean {
  return canceling.has(taskId);
}

// Check-and-clear: the run loop calls this after a kill to decide canceled vs
// done/failed, consuming the flag so a later run isn't wrongly canceled.
export function takeCanceled(taskId: string): boolean {
  return canceling.delete(taskId);
}

// Thrown by a run step when a stop was requested mid-flight, so the debate
// pipeline unwinds to its top-level catch and settles as `canceled`.
export class CanceledRun extends Error {
  constructor() {
    super("canceled");
    this.name = "CanceledRun";
  }
}
