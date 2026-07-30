import { useCallback, useEffect, useState } from "react";
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

export function applyTaskStatusEvent(task: Task, event: TaskStatusEvent): Task {
  if (task.id !== event.taskId) return task;
  return {
    ...task,
    status: event.status,
    startedAt: event.startedAt !== undefined ? event.startedAt : task.startedAt,
    endedAt: event.endedAt !== undefined ? event.endedAt : task.endedAt,
    activeMs: event.activeMs !== undefined ? event.activeMs : task.activeMs,
    liveSince: event.liveSince !== undefined ? event.liveSince : task.liveSince,
  };
}

export function useTasks(projectId?: string) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const refetch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const allTasks = await api.tasks();
      setTasks(projectId ? allTasks.filter((task) => task.projectId === projectId) : allTasks);
    } catch (reason) {
      setError(reason instanceof Error ? reason : new Error("任务列表读取失败"));
    } finally {
      setLoading(false);
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
        return;
      }
      if (event.type === "task.stage") {
        setTasks((current) => current.map((task) =>
          task.id === event.taskId ? { ...task, stage: event.stage } : task));
        return;
      }
      if (event.type === "task.title") {
        setTasks((current) => current.map((task) =>
          task.id === event.taskId ? { ...task, title: event.title } : task));
        return;
      }
      if (event.type === "task.question") {
        setTasks((current) => current.map((task) => task.id === event.taskId
          ? {
              ...task,
              question: event.question,
              questionOptions: event.questionOptions,
              questionItems: event.questionItems,
            }
          : task));
      }
    }, [projectId]),
  );

  return { tasks, setTasks, loading, error, connected, refetch };
}
