import { useCallback, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { Task } from "@harness/shared";
import { useServerEvents } from "./useEvents";
import { renderEvent } from "./renderEvent";
import { applyDebateEvent, emptyDebate, type DebateState } from "./debateState";
import type { LogLine } from "./TaskDetail";

export function upsertTask(tasks: Task[], task: Task): Task[] {
  return tasks.some((item) => item.id === task.id)
    ? tasks.map((item) => (item.id === task.id ? task : item))
    : [task, ...tasks];
}

function upsertProjectTask(tasks: Task[], task: Task, projectId: string | null): Task[] {
  if (task.projectId !== projectId) return tasks.filter((item) => item.id !== task.id);
  return upsertTask(tasks, task);
}

export const runningOnly = (tasks: Task[]) => tasks.filter((task) => task.status === "running");

type Setter<T> = Dispatch<SetStateAction<T>>;

export function useAppEvents({
  projectIdRef,
  setTasks,
  setRunningTasks,
  setLogs,
  setDebates,
  setSessionsBump,
}: {
  projectIdRef: RefObject<string | null>;
  setTasks: Setter<Task[]>;
  setRunningTasks: Setter<Task[]>;
  setLogs: Setter<Record<string, LogLine[]>>;
  setDebates: Setter<Record<string, DebateState>>;
  setSessionsBump: Setter<number>;
}) {
  return useServerEvents(
    useCallback((event) => {
      if (event.type === "task.created" || event.type === "task.updated") {
        setTasks((tasks) => upsertProjectTask(tasks, event.task, projectIdRef.current));
        setRunningTasks((tasks) => event.task.status === "running"
          ? upsertTask(tasks, event.task)
          : tasks.filter((task) => task.id !== event.task.id));
      } else if (event.type === "task.status") {
        setTasks((tasks) => tasks.map((task) => task.id === event.taskId
          ? {
              ...task,
              status: event.status,
              updatedAt: event.updatedAt,
              startedAt: event.startedAt !== undefined ? event.startedAt : task.startedAt,
              endedAt: event.endedAt !== undefined ? event.endedAt : task.endedAt,
              activeMs: event.activeMs !== undefined ? event.activeMs : task.activeMs,
              liveSince: event.liveSince !== undefined ? event.liveSince : task.liveSince,
            }
          : task));
        if (event.status !== "running") {
          setRunningTasks((tasks) => tasks.filter((task) => task.id !== event.taskId));
        }
        if (["done", "failed", "canceled", "idle"].includes(event.status)) {
          setSessionsBump((value) => value + 1);
        }
      } else if (event.type === "task.stage") {
        // stage 与 status 正交：独立更新，列表色点和审查结论会在同一帧一起变化。
        setTasks((tasks) => tasks.map((task) => task.id === event.taskId ? { ...task, stage: event.stage, updatedAt: event.updatedAt } : task));
        setRunningTasks((tasks) => tasks.map((task) => task.id === event.taskId ? { ...task, stage: event.stage, updatedAt: event.updatedAt } : task));
      } else if (event.type === "task.title") {
        setTasks((tasks) => tasks.map((task) => task.id === event.taskId ? { ...task, title: event.title, updatedAt: event.updatedAt } : task));
      } else if (event.type === "task.question") {
        const patch = (task: Task) => task.id === event.taskId
          ? {
              ...task,
              updatedAt: event.updatedAt,
              question: event.question,
              questionOptions: event.questionOptions,
              questionItems: event.questionItems,
            }
          : task;
        setTasks((tasks) => tasks.map(patch));
        setRunningTasks((tasks) => tasks.map(patch));
      } else if (event.type === "agent.event") {
        if (event.role === "single" || event.role === "lead") {
          const line = renderEvent(event.event, event.agentType, event.sessionId);
          if (line && !(event.role === "lead" && line.kind === "done")) {
            setLogs((logs) => ({ ...logs, [event.taskId]: [...(logs[event.taskId] ?? []), line] }));
          }
        } else {
          setDebates((debates) => ({
            ...debates,
            [event.taskId]: applyDebateEvent(debates[event.taskId] ?? emptyDebate(), event),
          }));
        }
      } else if (event.type === "debate.progress" || event.type === "debate.gate" || event.type === "debate.user") {
        setDebates((debates) => ({
          ...debates,
          [event.taskId]: applyDebateEvent(debates[event.taskId] ?? emptyDebate(), event),
        }));
      }
    }, [projectIdRef, setDebates, setLogs, setRunningTasks, setSessionsBump, setTasks]),
  );
}
