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

// 星标 PATCH 的成功回写只合并 starredAt：HTTP 响应和 SSE 走不同连接，响应里那份
// Task 快照可能比已经到达的 SSE 旧 —— 整条替换会把完成状态/标题/计时回滚到点星
// 那一刻。任务已不在列表里（被删了）就什么都不做，旧响应不复活死任务。
export function applyStarredAt(tasks: Task[], taskId: string, starredAt: number | null): Task[] {
  return tasks.map((task) => (task.id === taskId ? { ...task, starredAt } : task));
}

// GET 快照与 SSE/本地回写之间同样没有到达顺序保证：整表替换会让旧快照盖掉新状态。
// 逐行按 updatedAt 合并，本地行更新就保留本地行。快照里没有的行照快照删（任务删除
// 没有专门的 SSE 事件，快照是删除的权威来源）。
export function mergeFetchedTasks(current: Task[], fetched: Task[]): Task[] {
  const byId = new Map(current.map((task) => [task.id, task]));
  return fetched.map((task) => {
    const local = byId.get(task.id);
    return local && local.updatedAt > task.updatedAt ? local : task;
  });
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

  // silent：追平用。列表已经在屏幕上，不翻 loading（免得依赖它的初始化逻辑重跑）、
  // 失败也不换错误横幅。返回是否成功，追平方失败时好安排重试。
  const fetchGen = useRef(0);
  const refetch = useCallback(async (options?: { silent?: boolean }): Promise<boolean> => {
    const gen = ++fetchGen.current;
    if (!options?.silent) {
      setLoading(true);
      setError(null);
    }
    try {
      const allTasks = await api.tasks();
      // 并发的两次 GET 响应也可能乱序：只应用最新一次发起的那份快照。
      if (gen === fetchGen.current) {
        const scoped = projectId ? allTasks.filter((task) => task.projectId === projectId) : allTasks;
        setTasks((current) => mergeFetchedTasks(current, scoped));
      }
      return true;
    } catch (reason) {
      if (!options?.silent) setError(reason instanceof Error ? reason : new Error("任务列表读取失败"));
      return false;
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

  // SSE 没有事件 ID 也没有补发：断线窗口里错过的事件追不回来，页面会一直陈旧到该任务
  // 下一次自己产生事件。「初始 GET 之后、SSE 第一次连上之前」也是这样一段窗口，所以
  // 每次观察到连接建立 —— 首次也一样 —— 都静默 refetch 追平；失败隔 5 秒重试，断开或
  // 卸载即停（重连时这个 effect 会重新跑）。
  useEffect(() => {
    if (!connected) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const catchUp = () => {
      void refetch({ silent: true }).then((ok) => {
        if (!ok && alive) timer = setTimeout(catchUp, 5000);
      });
    };
    catchUp();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [connected, refetch]);

  return { tasks, setTasks, loading, error, connected, settlementVersion, refetch };
}
