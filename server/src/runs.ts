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

// ── 完成确认(严格 done 协议)────────────────────────────────────────────────
// exit 0 只说明 CLI 进程正常退出,不代表任务目标达成(agent 报错后正常退出照样
// exit 0)。done 必须由 agent 亲口确认:回合内调 complete_task(MCP → POST
// /tasks/:id/complete)置标记,settle 时 take 消费。内存态即可——标记只活在
// 「调用 ~ 本回合 settle」之间;server 重启时 running 任务本来就 reconcile 成
// failed,标记一起丢掉正好。
const confirmed = new Set<string>();

export function confirmDone(taskId: string): void {
  confirmed.add(taskId);
}

// Check-and-clear(对称 takeCanceled):settle 消费,失败重试的下一回合不残留。
export function takeConfirmed(taskId: string): boolean {
  return confirmed.delete(taskId);
}

// Thrown by a run step when a stop was requested mid-flight, so the debate
// pipeline unwinds to its top-level catch and settles as `canceled`.
export class CanceledRun extends Error {
  constructor() {
    super("canceled");
    this.name = "CanceledRun";
  }
}
