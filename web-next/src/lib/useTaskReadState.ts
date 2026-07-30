import { useCallback, useEffect, useState } from "react";
import type { Task } from "@harness/shared";

const STORAGE_KEY = "harness-next:task-read-state-v1";
const MAX_READ_TASKS = 300;

type ReadEntry = {
  event: string;
  readAt: number;
};

type ReadState = Record<string, ReadEntry>;

export type TaskStatusIndicator = "active" | "attention" | "success" | "error";

function terminalEvent(task: Task): string | null {
  if (task.status !== "done" && task.status !== "failed" && task.status !== "canceled") return null;
  return `${task.status}:${task.updatedAt}:${task.endedAt ?? ""}`;
}

function loadReadState(): ReadState {
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

function sameReadState(left: ReadState, right: ReadState): boolean {
  const leftEntries = Object.entries(left);
  const rightEntries = Object.entries(right);
  return leftEntries.length === rightEntries.length
    && leftEntries.every(([taskId, entry]) => {
      const other = right[taskId];
      return other?.event === entry.event && other.readAt === entry.readAt;
    });
}

function reconcileReadState(current: ReadState, tasks: Task[], selectedTaskId: string | null): ReadState {
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  // The task list is empty during the initial fetch. Preserve persisted reads until
  // at least one server result arrives, then discard deleted and restarted tasks.
  const entries = tasks.length === 0 ? Object.entries(current) : Object.entries(current).filter(([taskId]) => {
    const task = tasksById.get(taskId);
    return task != null && terminalEvent(task) != null;
  });
  const next = Object.fromEntries(entries);
  const selectedTask = selectedTaskId ? tasksById.get(selectedTaskId) : undefined;
  const selectedEvent = selectedTask ? terminalEvent(selectedTask) : null;
  if (selectedTask && selectedEvent && next[selectedTask.id]?.event !== selectedEvent) {
    next[selectedTask.id] = { event: selectedEvent, readAt: Date.now() };
  }
  return Object.fromEntries(
    Object.entries(next)
      .sort((left, right) => right[1].readAt - left[1].readAt)
      .slice(0, MAX_READ_TASKS),
  );
}

export function useTaskReadState(tasks: Task[], selectedTaskId: string | null) {
  const [readState, setReadState] = useState<ReadState>(loadReadState);

  useEffect(() => {
    setReadState((current) => {
      const next = reconcileReadState(current, tasks, selectedTaskId);
      return sameReadState(current, next) ? current : next;
    });
  }, [selectedTaskId, tasks]);

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(readState));
    } catch {
      // Reading state is optional UI metadata; storage failures must not break navigation.
    }
  }, [readState]);

  return useCallback((task: Task): TaskStatusIndicator | null => {
    if (task.question || task.status === "paused") return "attention";
    if (task.status === "running" || task.status === "queued") return "active";
    const event = terminalEvent(task);
    if (!event || task.id === selectedTaskId || readState[task.id]?.event === event) return null;
    return task.status === "done" ? "success" : "error";
  }, [readState, selectedTaskId]);
}
