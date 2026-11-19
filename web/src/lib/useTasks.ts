import { useCallback, useEffect, useRef, useState } from "react";
import type { ServerEvent, TaskListItem } from "@navi/shared";
import { api } from "./api.ts";
import { useServerEvents } from "./events.ts";
import { mergeTaskSnapshotFields } from "./taskSnapshot.ts";
import { useCatchUp, useCatchUpLink } from "./useCatchUp.ts";

export function upsertTask(tasks: TaskListItem[], task: TaskListItem, projectId?: string): TaskListItem[] {
  if (projectId && task.projectId !== projectId) {
    return tasks.filter((item) => item.id !== task.id);
  }
  return tasks.some((item) => item.id === task.id)
    ? tasks.map((item) => (item.id === task.id ? mergeTaskSnapshotFields(item, task) : item))
    : [task, ...tasks];
}

// GET 快照与 SSE/本地回写之间同样没有到达顺序保证：整表替换会让旧快照盖掉新状态。
// 逐行按 updatedAt 合并，本地行更新就保留本地行。快照里没有的行照快照删（任务删除
// 没有专门的 SSE 事件，快照是删除的权威来源）。
export function mergeFetchedTasks(current: TaskListItem[], fetched: TaskListItem[]): TaskListItem[] {
  const byId = new Map(current.map((task) => [task.id, task]));
  return fetched.map((task) => {
    const local = byId.get(task.id);
    return local ? mergeTaskSnapshotFields(local, task) : task;
  });
}

// 权威快照确认的删除:**fetch 发起时本地已有**、响应里却没有的行。只有「发起时已
// 存在」才能把缺席读成删除——行在发起前就在列表里,说明服务端在请求发出前就建好了
// 它,响应里缺席只能是之后删了;反过来,发起更早的旧快照缺一个刚创建(SSE 在途中
// 送达)的任务是正常时序,不构成删除证据(第 8 轮审查:要按请求先后区分「创建前的
// 旧列表」和「创建后的删除」)。结果并入 useTasks 的失效记录,给迟到的创建完成回写
// 当拒绝依据。
export function confirmedDeletions(
  idsAtFetchStart: ReadonlySet<string>,
  fetched: readonly { id: string }[],
): string[] {
  const present = new Set(fetched.map((task) => task.id));
  return [...idsAtFetchStart].filter((id) => !present.has(id));
}

type TaskStatusEvent = Extract<ServerEvent, { type: "task.status" }>;
type TaskMetadataEvent = Extract<ServerEvent, {
  type: "task.stage" | "task.title" | "task.question";
}>;

export function applyTaskStatusEvent<T extends TaskListItem>(task: T, event: TaskStatusEvent): T {
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

export function applyTaskMetadataEvent<T extends TaskListItem>(task: T, event: TaskMetadataEvent): T {
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
    // 每一次提问的变动都带着这一问是不是派活单：换了题、答了、撤下都让卡跟着走。
    dispatchPlan: event.dispatchPlan ?? null,
  };
}

export function useTasks(projectId?: string) {
  const [tasks, setTasks] = useState<TaskListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [snapshotScope, setSnapshotScope] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [settlementVersion, setSettlementVersion] = useState(0);

  // silent：追平用。列表已经在屏幕上，不翻 loading（免得依赖它的初始化逻辑重跑）、
  // 失败也不换错误横幅。返回是否成功，追平方失败时好安排重试。
  const fetchGen = useRef(0);
  // 本页已确认删除的任务 id(共享失效记录):本地删除(WorkspaceShell.deleteTask 直接
  // add)与权威快照确认的删除(refetch 里按 confirmedDeletions 裁决)都记在这里,给
  // 「创建并排队」等迟到的创建完成回写当拒绝依据——SSE 没有删除事件,别的页面删的
  // 任务只有这两条路能让本页确知(第 7、8 轮审查)。只增不减:id 不复用。
  const confirmedDeleteIds = useRef(new Set<string>());
  // refetch 发起时刻的在列 id 集合要用「发起那一刻」的列表;state 闭包会过期,用 ref 镜像。
  const tasksRef = useRef<TaskListItem[]>([]);
  useEffect(() => { tasksRef.current = tasks; }, [tasks]);
  const refetch = useCallback(async (options?: { silent?: boolean; signal?: AbortSignal }): Promise<boolean> => {
    const gen = ++fetchGen.current;
    const idsAtStart = new Set(tasksRef.current.map((task) => task.id));
    if (!options?.silent) {
      setLoading(true);
      setError(null);
    }
    try {
      const allTasks = await api.tasks(options?.signal);
      // 并发的两次 GET 响应也可能乱序：只应用最新一次发起的那份快照。
      if (gen === fetchGen.current) {
        const scoped = projectId ? allTasks.filter((task) => task.projectId === projectId) : allTasks;
        for (const id of confirmedDeletions(idsAtStart, scoped)) confirmedDeleteIds.current.add(id);
        setTasks((current) => mergeFetchedTasks(current, scoped));
        setSnapshotScope(projectId ?? "");
      }
      return true;
    } catch (reason) {
      if (!options?.silent) setError(reason instanceof Error ? reason : new Error("任务列表读取失败"));
      return false;
    } finally {
      if (!options?.silent) setLoading(false);
    }
  }, [projectId]);

  // 追平实例按 hook 寿命存一份,SSE 回调与重连接线共用它(同时只有一条重试在排)。
  // 实例的稳定、卸载作废、refetch 身份随 projectId 变化都由 useCatchUp 管。
  const catchUp = useCatchUp((signal) => refetch({ silent: true, signal }), projectId ?? "");

  useEffect(() => {
    void refetch();
  }, [refetch]);

  const connected = useServerEvents(
    useCallback((event) => {
      if (event.type === "task.monitors") {
        // 走统一的追平入口(createCatchUp):失败要自己重试,见那里的说明。
        void catchUp.run();
        return;
      }
      if (event.type === "task.created" || event.type === "task.updated") {
        setTasks((current) => upsertTask(current, event.task, projectId));
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
    }, [catchUp, projectId]),
  );

  // SSE 没有事件 ID 也没有补发：断线窗口里错过的事件追不回来，页面会一直陈旧到该任务
  // 下一次自己产生事件。「初始 GET 之后、SSE 第一次连上之前」也是这样一段窗口，所以每次
  // 观察到连接建立 —— 首次也一样 —— 都静默追平，断线则把这一代次作废。这条接线统一在
  // useCatchUpLink 里（五个消费者原先各写一遍，四处漏了「断线作废」，见那边的文件头）。
  useCatchUpLink(catchUp, connected);

  return { tasks, setTasks, loading, snapshotReady: snapshotScope === (projectId ?? ""), error, connected, settlementVersion, refetch, confirmedDeleteIds };
}
