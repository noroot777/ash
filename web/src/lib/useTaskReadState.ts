import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import type { Task, TaskListItem } from "@ash/shared";
import { isTeamSettled, teamNeverStarted, timeMs } from "@ash/shared/team";
import { readRenamedStorage } from "./renamedStorage.ts";
import { awaitsAcceptance } from "./taskAttention.ts";

const STORAGE_KEY = "ash:task-read-state-v1";
const MAX_READ_TASKS = 300;
const EMPTY_READ_STATE: ReadState = {};

type ReadEntry = {
  event: string;
  readAt: number;
};

type ReadState = Record<string, ReadEntry>;

type TaskIndex = {
  byId: Map<string, TaskListItem>;
  workersByLead: Map<string, TaskListItem[]>;
};

export type TaskStatusIndicator = "pending" | "active" | "attention" | "unaccepted" | "success" | "error";
export type IndicatorForTask = (task: TaskListItem) => TaskStatusIndicator | null;

function terminalEvent(task: TaskListItem): string | null {
  if (task.status !== "done" && task.status !== "failed" && task.status !== "canceled") return null;
  return `${task.status}:${task.updatedAt}:${task.endedAt ?? ""}`;
}

function teamEvent(lead: TaskListItem, workers: TaskListItem[]): string | null {
  const leadError = lead.status === "failed" || lead.status === "canceled";
  if (teamNeverStarted(lead.status) && !leadError && workers.length === 0) return null;
  const members = [lead, ...workers];
  const latestMs = members.reduce((latest, task) => Math.max(latest, timeMs(task.updatedAt) ?? 0), 0);
  const latestRaw = members.reduce((latest, task) => task.updatedAt > latest ? task.updatedAt : latest, "");
  return `team:${latestMs || latestRaw}`;
}

function buildTaskIndex(tasks: TaskListItem[]): TaskIndex {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const workersByLead = new Map<string, TaskListItem[]>();
  for (const task of tasks) {
    if (!task.parentId) continue;
    const workers = workersByLead.get(task.parentId);
    if (workers) workers.push(task);
    else workersByLead.set(task.parentId, [task]);
  }
  return { byId, workersByLead };
}

export function readTaskIds(task: Pick<Task, "id" | "parentId">): string[] {
  return task.parentId ? [task.id, task.parentId] : [task.id];
}

export function readEventForTask(task: TaskListItem, workers: TaskListItem[] = []): string | null {
  return task.mode === "team" && !task.parentId ? teamEvent(task, workers) : terminalEvent(task);
}

export function deriveTaskStatusIndicator(
  task: TaskListItem,
  workers: TaskListItem[] = [],
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
    const settled = isTeamSettled(leadLive, workers);
    const failed = task.status === "failed"
      || task.status === "canceled"
      || workers.some((worker) => worker.status === "failed" || worker.status === "canceled");
    // 团队收工 = 它的「干完了」。没盖章就一直亮着未验收，跟读没读过无关。
    // 从没开过台的（还停在 backlog）不算收工 —— 那是没开始，不是等验收。
    if (!failed && !teamNeverStarted(task.status) && awaitsAcceptance(task, settled)) return "unaccepted";
    if (!unread || !settled) return null;
    return failed ? "error" : "success";
  }

  if (task.question || task.status === "paused") return "attention";
  if (task.status === "running" || task.status === "queued") return "active";
  if (task.status === "backlog") return "pending";
  // 「干完了但我还没验收」是持久事实，不是未读提醒：已读之后仍要标出来，
  // 否则做完的任务全都塌成同一颗灰点，分不出哪些还等着我盖章。
  // 执行者不进这一档 —— 验收是顶层任务的事（accept_task 拒绝共享执行者）。
  if (!task.parentId && awaitsAcceptance(task, task.status === "done")) return "unaccepted";
  if (!unread) return null;
  if (task.status === "done") return "success";
  if (task.status === "failed" || task.status === "canceled") return "error";
  return null;
}

function loadReadState(): ReadState {
  if (typeof window === "undefined") return {};
  try {
    const raw = readRenamedStorage(STORAGE_KEY);
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

export function reconcileReadState(current: ReadState, tasks: TaskListItem[], selectedTaskId: string | null): ReadState {
  const index = buildTaskIndex(tasks);
  // 重启/重连时 SSE 可能先送来一条 task.updated，完整 GET 还在路上。此时 tasks
  // 非空却只是临时子集，拿它清理“不存在”的任务会把其余已读记录全删掉；完整列表
  // 一到，那些历史任务就一起重新亮成未读。记录本身有 MAX_READ_TASKS 上限，保留已
  // 删除任务的少量陈旧项没有副作用；同 id 真有新一轮时 event 不同，照样会判未读。
  const next = { ...current };
  const selectedTask = selectedTaskId ? index.byId.get(selectedTaskId) : undefined;
  for (const taskId of selectedTask ? readTaskIds(selectedTask) : []) {
    const task = index.byId.get(taskId);
    if (!task) continue;
    const event = readEventForTask(task, index.workersByLead.get(task.id) ?? []);
    if (event && next[task.id]?.event !== event) {
      next[task.id] = { event, readAt: Date.now() };
    }
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

export function useTaskReadState(tasks: TaskListItem[], selectedTaskId: string | null) {
  const readState = useSyncExternalStore(subscribeReadState, getReadStateSnapshot, () => EMPTY_READ_STATE);
  const index = useMemo(() => buildTaskIndex(tasks), [tasks]);

  useEffect(() => {
    updateReadState((current) => reconcileReadState(current, tasks, selectedTaskId));
  }, [selectedTaskId, tasks]);

  const markTaskRead = useCallback((task: TaskListItem) => {
    updateReadState((current) => {
      let next = current;
      const readAt = Date.now();
      for (const taskId of readTaskIds(task)) {
        const target = index.byId.get(taskId);
        if (!target) continue;
        const event = readEventForTask(target, index.workersByLead.get(target.id) ?? []);
        if (!event || next[target.id]?.event === event) continue;
        if (next === current) next = { ...current };
        next[target.id] = { event, readAt };
      }
      return next === current ? current : trimReadState(next);
    });
  }, [index]);

  const visibleTaskIds = useMemo(() => {
    const selectedTask = selectedTaskId ? index.byId.get(selectedTaskId) : undefined;
    return new Set(selectedTask ? readTaskIds(selectedTask) : []);
  }, [index, selectedTaskId]);

  const indicatorForTask = useCallback<IndicatorForTask>((task) => {
    const workers = index.workersByLead.get(task.id) ?? [];
    const event = readEventForTask(task, workers);
    const unread = !!event && !visibleTaskIds.has(task.id) && readState[task.id]?.event !== event;
    return deriveTaskStatusIndicator(task, workers, unread);
  }, [index, readState, visibleTaskIds]);

  return { indicatorForTask, markTaskRead };
}
