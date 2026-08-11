import { useCallback, useEffect, useRef, useState } from "react";
import type { ServerEvent, Task } from "@harness/shared";
import { api } from "./api.ts";
import { useServerEvents } from "./events.ts";

function upsert(tasks: Task[], task: Task, projectId?: string): Task[] {
  if (projectId && task.projectId !== projectId) {
    return tasks.filter((item) => item.id !== task.id);
  }
  return tasks.some((item) => item.id === task.id)
    ? tasks.map((item) => (item.id === task.id ? task : item))
    : [task, ...tasks];
}

type TaskStatusEvent = Extract<ServerEvent, { type: "task.status" }>;
type TaskMetadataEvent = Extract<ServerEvent, {
  type: "task.stage" | "task.title" | "task.question";
}>;

export function applyTaskStatusEvent(task: Task, event: TaskStatusEvent): Task {
  if (task.id !== event.taskId) return task;
  return {
    ...task,
    status: event.status,
    updatedAt: event.updatedAt,
    startedAt: event.startedAt !== undefined ? event.startedAt : task.startedAt,
    endedAt: event.endedAt !== undefined ? event.endedAt : task.endedAt,
    activeMs: event.activeMs !== undefined ? event.activeMs : task.activeMs,
    liveSince: event.liveSince !== undefined ? event.liveSince : task.liveSince,
  };
}

export function applyTaskMetadataEvent(task: Task, event: TaskMetadataEvent): Task {
  if (task.id !== event.taskId) return task;
  if (event.type === "task.stage") {
    return { ...task, stage: event.stage, updatedAt: event.updatedAt };
  }
  if (event.type === "task.title") {
    return { ...task, title: event.title, updatedAt: event.updatedAt };
  }
  return {
    ...task,
    updatedAt: event.updatedAt,
    question: event.question,
    questionOptions: event.questionOptions,
    questionItems: event.questionItems,
  };
}

export function useTasks(projectId?: string) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [settlementVersion, setSettlementVersion] = useState(0);

  // silent：重连追平用。列表已经在屏幕上，不翻 loading（免得依赖它的初始化逻辑重跑）、
  // 失败也不换错误横幅 —— 追平失败就等下一次事件或用户操作，别把好好的列表盖掉。
  const refetch = useCallback(async (options?: { silent?: boolean }) => {
    if (!options?.silent) {
      setLoading(true);
      setError(null);
    }
    try {
      const allTasks = await api.tasks();
      setTasks(projectId ? allTasks.filter((task) => task.projectId === projectId) : allTasks);
    } catch (reason) {
      if (!options?.silent) setError(reason instanceof Error ? reason : new Error("任务列表读取失败"));
    } finally {
      if (!options?.silent) setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  const connected = useServerEvents(
    useCallback((event) => {
      if (event.type === "task.created" || event.type === "task.updated") {
        setTasks((current) => upsert(current, event.task, projectId));
        return;
      }
      if (event.type === "task.status") {
        setTasks((current) => current.map((task) => applyTaskStatusEvent(task, event)));
        if (["done", "failed", "canceled", "idle"].includes(event.status)) {
          setSettlementVersion((value) => value + 1);
        }
        return;
      }
      if (event.type === "task.stage" || event.type === "task.title" || event.type === "task.question") {
        setTasks((current) => current.map((task) => applyTaskMetadataEvent(task, event)));
      }
    }, [projectId]),
  );

  // SSE 没有事件 ID 也没有补发：断线窗口里错过的 task.updated 追不回来，页面会一直陈旧
  // 到该任务下一次自己产生事件。所以从断线恢复时整表静默 refetch 一次，把界面追平。
  const everConnected = useRef(false);
  useEffect(() => {
    if (!connected) return;
    if (everConnected.current) void refetch({ silent: true });
    else everConnected.current = true;
  }, [connected, refetch]);

  return { tasks, setTasks, loading, error, connected, settlementVersion, refetch };
}
