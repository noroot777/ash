import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import type { Task, TaskListItem } from "@ash/shared";
import { teamNeverStarted, timeMs } from "@ash/shared/team";
import { taskReadRound, trimTaskReads, type TaskReadEntry, type TaskReads } from "@ash/shared/task-reads";
import { getTaskReads, subscribeTaskReads, updateTaskReads } from "./taskReadSync.ts";
import { deriveTaskStatusIndicator, taskLook, type TaskLook, type TaskStatusIndicator } from "./taskLook.ts";

// 档位的判据和侧栏那张表在 taskLook.ts；这里只管「读没读过」，并把两样原样转出，
// 让老的调用点继续从这里引用。读没读过的记录本身按人存在服务端，同步在 taskReadSync.ts。
export { deriveTaskStatusIndicator };
export type { TaskLook, TaskStatusIndicator };

const EMPTY_READ_STATE: TaskReads = {};

type ReadState = TaskReads;

type TaskIndex = {
  byId: Map<string, TaskListItem>;
  workersByLead: Map<string, TaskListItem[]>;
};

export type IndicatorForTask = (task: TaskListItem) => TaskStatusIndicator | null;
export type LookForTask = (task: TaskListItem) => TaskLook;

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

/** 「看过这一轮」该记下的那一条：event 判是不是同一轮，round 比新旧（shared/src/task-reads.ts）。 */
export function readMarkForTask(task: TaskListItem, workers: TaskListItem[] = []): TaskReadEntry | null {
  const event = readEventForTask(task, workers);
  return event ? { event, round: taskReadRound(task, workers) } : null;
}

/** 记下的那条已经覆盖到这一轮了吗。别处看过更新的一轮（这一页的任务数据还没跟上）也算。 */
function hasRead(stored: TaskReadEntry | undefined, mark: TaskReadEntry): boolean {
  return !!stored && (stored.round > mark.round || (stored.round === mark.round && stored.event === mark.event));
}

export function reconcileReadState(current: ReadState, tasks: TaskListItem[], selectedTaskId: string | null): ReadState {
  const index = buildTaskIndex(tasks);
  // 重启/重连时 SSE 可能先送来一条 task.updated，完整 GET 还在路上。此时 tasks
  // 非空却只是临时子集，拿它清理“不存在”的任务会把其余已读记录全删掉；完整列表
  // 一到，那些历史任务就一起重新亮成未读。记录本身有 TASK_READS_MAX 上限，保留已
  // 删除任务的少量陈旧项没有副作用；同 id 真有新一轮时 event 不同，照样会判未读。
  const next = { ...current };
  const selectedTask = selectedTaskId ? index.byId.get(selectedTaskId) : undefined;
  for (const taskId of selectedTask ? readTaskIds(selectedTask) : []) {
    const task = index.byId.get(taskId);
    if (!task) continue;
    const mark = readMarkForTask(task, index.workersByLead.get(task.id) ?? []);
    if (mark && !hasRead(next[task.id], mark)) next[task.id] = mark;
  }
  return trimTaskReads(next);
}

export function useTaskReadState(tasks: TaskListItem[], selectedTaskId: string | null) {
  const readState = useSyncExternalStore(subscribeTaskReads, getTaskReads, () => EMPTY_READ_STATE);
  const index = useMemo(() => buildTaskIndex(tasks), [tasks]);

  useEffect(() => {
    updateTaskReads((current) => reconcileReadState(current, tasks, selectedTaskId));
  }, [selectedTaskId, tasks]);

  const markTaskRead = useCallback((task: TaskListItem) => {
    updateTaskReads((current) => {
      let next = current;
      for (const taskId of readTaskIds(task)) {
        const target = index.byId.get(taskId);
        if (!target) continue;
        const mark = readMarkForTask(target, index.workersByLead.get(target.id) ?? []);
        if (!mark || hasRead(next[target.id], mark)) continue;
        if (next === current) next = { ...current };
        next[target.id] = mark;
      }
      return next === current ? current : trimTaskReads(next);
    });
  }, [index]);

  const visibleTaskIds = useMemo(() => {
    const selectedTask = selectedTaskId ? index.byId.get(selectedTaskId) : undefined;
    return new Set(selectedTask ? readTaskIds(selectedTask) : []);
  }, [index, selectedTaskId]);

  const lookForTask = useCallback<LookForTask>((task) => {
    const workers = index.workersByLead.get(task.id) ?? [];
    const mark = readMarkForTask(task, workers);
    const unread = !!mark && !visibleTaskIds.has(task.id) && !hasRead(readState[task.id], mark);
    return taskLook(task, workers, unread);
  }, [index, readState, visibleTaskIds]);
  const indicatorForTask = useCallback<IndicatorForTask>((task) => lookForTask(task).indicator, [lookForTask]);

  return { indicatorForTask, lookForTask, markTaskRead };
}
