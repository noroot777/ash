import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import type { Task } from "@harness/shared";
import { isTeamSettled, teamNeverStarted, timeMs } from "@harness/shared/team";

const STORAGE_KEY = "harness-next:task-read-state-v1";
const MAX_READ_TASKS = 300;
const EMPTY_READ_STATE: ReadState = {};

type ReadEntry = {
  event: string;
  readAt: number;
};

type ReadState = Record<string, ReadEntry>;

type TaskIndex = {
  byId: Map<string, Task>;
  workersByLead: Map<string, Task[]>;
};

export type TaskStatusIndicator = "pending" | "active" | "attention" | "success" | "error";
export type IndicatorForTask = (task: Task) => TaskStatusIndicator | null;

function terminalEvent(task: Task): string | null {
  if (task.status !== "done" && task.status !== "failed" && task.status !== "canceled") return null;
  return `${task.status}:${task.updatedAt}:${task.endedAt ?? ""}`;
}

function teamEvent(lead: Task, workers: Task[]): string | null {
  const leadError = lead.status === "failed" || lead.status === "canceled";
  if (teamNeverStarted(lead.status) && !leadError && workers.length === 0) return null;
  const members = [lead, ...workers];
  const latestMs = members.reduce((latest, task) => Math.max(latest, timeMs(task.updatedAt) ?? 0), 0);
  const latestRaw = members.reduce((latest, task) => task.updatedAt > latest ? task.updatedAt : latest, "");
  return `team:${latestMs || latestRaw}`;
}

function buildTaskIndex(tasks: Task[]): TaskIndex {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const workersByLead = new Map<string, Task[]>();
  for (const task of tasks) {
    if (!task.parentId) continue;
    const workers = workersByLead.get(task.parentId);
    if (workers) workers.push(task);
    else workersByLead.set(task.parentId, [task]);
  }
  return { byId, workersByLead };
}

export function readEventForTask(task: Task, workers: Task[] = []): string | null {
  return task.mode === "team" && !task.parentId ? teamEvent(task, workers) : terminalEvent(task);
}

export function deriveTaskStatusIndicator(
  task: Task,
  workers: Task[] = [],
  unread = false,
): TaskStatusIndicator | null {
  if (task.mode === "team" && !task.parentId) {
    if (task.question || workers.some((worker) => worker.question || worker.status === "paused")) {
      return "attention";
    }
    const leadLive = task.status === "running";
    if (leadLive || workers.some((worker) => worker.status === "running" || worker.status === "queued")) {
      return "active";
    }
    if (task.status === "backlog" && workers.every((worker) => worker.status === "backlog")) {
      return "pending";
    }
    if (!unread || !isTeamSettled(leadLive, workers)) return null;
    const failed = task.status === "failed"
      || task.status === "canceled"
      || workers.some((worker) => worker.status === "failed" || worker.status === "canceled");
    return failed ? "error" : "success";
  }

  if (task.question || task.status === "paused") return "attention";
  if (task.status === "running" || task.status === "queued") return "active";
  if (task.status === "backlog") return "pending";
  if (!unread) return null;
  if (task.status === "done") return "success";
  if (task.status === "failed" || task.status === "canceled") return "error";
  return null;
}

function loadReadState(): ReadState {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, ReadEntry] => {
      const value: unknown = entry[1];
      return !!value
        && typeof value === "object"
        && typeof (value as ReadEntry).event === "string"
        && typeof (value as ReadEntry).readAt === "number";
    }));
  } catch {
    return {};
  }
}

function saveReadState(readState: ReadState) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(readState));
  } catch {
    // Reading state is optional UI metadata; storage failures must not break navigation.
  }
}

function sameReadState(left: ReadState, right: ReadState): boolean {
  const leftEntries = Object.entries(left);
  const rightEntries = Object.entries(right);
  return leftEntries.length === rightEntries.length
    && leftEntries.every(([taskId, entry]) => {
      const other = right[taskId];
      return other?.event === entry.event && other.readAt === entry.readAt;
    });
}

function trimReadState(readState: ReadState): ReadState {
  return Object.fromEntries(
    Object.entries(readState)
      .sort((left, right) => right[1].readAt - left[1].readAt)
      .slice(0, MAX_READ_TASKS),
  );
}

function reconcileReadState(current: ReadState, tasks: Task[], selectedTaskId: string | null): ReadState {
  const index = buildTaskIndex(tasks);
  // The task list is empty during the initial fetch. Preserve persisted reads until
  // at least one server result arrives, then discard deleted and restarted tasks.
  const entries = tasks.length === 0 ? Object.entries(current) : Object.entries(current).filter(([taskId]) => {
    const task = index.byId.get(taskId);
    return task != null && readEventForTask(task, index.workersByLead.get(task.id) ?? []) != null;
  });
  const next = Object.fromEntries(entries);
  const selectedTask = selectedTaskId ? index.byId.get(selectedTaskId) : undefined;
  const selectedEvent = selectedTask
    ? readEventForTask(selectedTask, index.workersByLead.get(selectedTask.id) ?? [])
    : null;
  if (selectedTask && selectedEvent && next[selectedTask.id]?.event !== selectedEvent) {
    next[selectedTask.id] = { event: selectedEvent, readAt: Date.now() };
  }
  return trimReadState(next);
}

let readStateSnapshot: ReadState | null = null;
const readStateListeners = new Set<() => void>();

function getReadStateSnapshot(): ReadState {
  if (readStateSnapshot === null) readStateSnapshot = loadReadState();
  return readStateSnapshot;
}

function subscribeReadState(listener: () => void) {
  readStateListeners.add(listener);
  return () => readStateListeners.delete(listener);
}

function updateReadState(update: (current: ReadState) => ReadState) {
  const current = getReadStateSnapshot();
  const next = update(current);
  if (sameReadState(current, next)) return;
  readStateSnapshot = next;
  saveReadState(next);
  readStateListeners.forEach((listener) => listener());
}

export function useTaskReadState(tasks: Task[], selectedTaskId: string | null) {
  const readState = useSyncExternalStore(subscribeReadState, getReadStateSnapshot, () => EMPTY_READ_STATE);
  const index = useMemo(() => buildTaskIndex(tasks), [tasks]);

  useEffect(() => {
    updateReadState((current) => reconcileReadState(current, tasks, selectedTaskId));
  }, [selectedTaskId, tasks]);

  const markTaskRead = useCallback((task: Task) => {
    const event = readEventForTask(task, index.workersByLead.get(task.id) ?? []);
    if (!event) return;
    updateReadState((current) => {
      if (current[task.id]?.event === event) return current;
      return trimReadState({ ...current, [task.id]: { event, readAt: Date.now() } });
    });
  }, [index]);

  const indicatorForTask = useCallback<IndicatorForTask>((task) => {
    const workers = index.workersByLead.get(task.id) ?? [];
    const event = readEventForTask(task, workers);
    const unread = !!event && task.id !== selectedTaskId && readState[task.id]?.event !== event;
    return deriveTaskStatusIndicator(task, workers, unread);
  }, [index, readState, selectedTaskId]);

  return { indicatorForTask, markTaskRead };
}
