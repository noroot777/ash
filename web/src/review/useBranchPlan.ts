import { useCallback, useEffect, useState } from "react";
import type { BranchPlanView, TaskListItem } from "@ash/shared";
import { api } from "../lib/api.ts";

type Snapshot = { view: BranchPlanView | null; error: string | null };
type Entry = {
  snapshot: Snapshot;
  listeners: Set<(snapshot: Snapshot) => void>;
  version?: string;
  sequence: number;
  pending?: Promise<void>;
  timer?: ReturnType<typeof setInterval>;
};
const empty: Snapshot = { view: null, error: null };
const entries = new Map<string, Entry>();

function load(taskId: string, entry: Entry, force = false): Promise<void> {
  if (entry.pending && !force) return entry.pending;
  const sequence = ++entry.sequence;
  const publish = (snapshot: Snapshot) => {
    if (sequence !== entry.sequence) return;
    entry.snapshot = snapshot;
    for (const listener of entry.listeners) listener(snapshot);
  };
  const pending = api.branchPlan(taskId).then(
    view => publish({ view, error: null }),
    reason => publish({ view: entry.snapshot.view, error: reason instanceof Error ? reason.message : String(reason) }),
  ).finally(() => { if (entry.pending === pending) entry.pending = undefined; });
  entry.pending = pending;
  return pending;
}

export function useBranchPlan(task: TaskListItem, enabled = true) {
  const active = enabled && !!task.useWorktree;
  const [state, setState] = useState<{ taskId: string; snapshot: Snapshot }>({ taskId: task.id, snapshot: empty });
  useEffect(() => {
    if (!active) return;
    let entry = entries.get(task.id);
    if (!entry) {
      entry = { snapshot: empty, listeners: new Set(), sequence: 0 };
      entries.set(task.id, entry);
    }
    const current = entry;
    const listener = (snapshot: Snapshot) => setState({ taskId: task.id, snapshot });
    current.listeners.add(listener);
    listener(current.snapshot);
    current.timer ??= setInterval(() => void load(task.id, current), 15_000);
    return () => {
      current.listeners.delete(listener);
      queueMicrotask(() => {
        if (current.listeners.size) return;
        clearInterval(current.timer);
        current.sequence++;
        if (entries.get(task.id) === current) entries.delete(task.id);
      });
    };
  }, [task.id, active]);
  useEffect(() => {
    const entry = active && entries.get(task.id);
    if (!entry || (entry.sequence > 0 && entry.version === task.updatedAt)) return;
    entry.version = task.updatedAt;
    entry.snapshot = empty;
    for (const listener of entry.listeners) listener(empty);
    void load(task.id, entry, true);
  }, [task.id, task.updatedAt, active]);
  const refresh = useCallback(async () => {
    const entry = active && entries.get(task.id);
    if (entry) await load(task.id, entry, true);
  }, [task.id, active]);
  return { ...(active && state.taskId === task.id ? state.snapshot : empty), refresh };
}
