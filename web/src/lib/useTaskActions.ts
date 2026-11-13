import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { ActionVerdict, TaskActions } from "@ash/shared";
import { api } from "./api.ts";
import { useServerEvents } from "./events.ts";

// 任务「此刻能做什么」的唯一取数点（判据整份在服务端，见 shared/src/task-actions.ts）。详情头、
// 回复框、信息格的队列、审查格、讨论页、团队头、命令面板都读这里，谁也不自己按任务状态推。
//
// 一份全局缓存，按任务认：同一个任务上同时挂着的几个表面只发一次请求、看见的是同一份。之后由
// `task.actions` 事件推送（服务端在相关事实变了的时候重算），序号小的旧结论一律丢掉 —— 请求的
// 响应和事件走两条连接，谁先到都有可能。连接断过就重取一次：断线窗口里的推送追不回来。
//
// 还没取到（刚打开、或者服务端还是不认这个接口的旧版本）时返回 null：这几颗键都不出，等结论到了
// 再出 —— 不拿前端自己的猜测先垫一份，那正是这一层要消灭的东西。

const store = new Map<string, TaskActions>();
const listeners = new Set<() => void>();
const inflight = new Map<string, Promise<void>>();

function put(actions: TaskActions): void {
  const current = store.get(actions.taskId);
  if (current && current.seq >= actions.seq) return;
  store.set(actions.taskId, actions);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** 重取一次（撞车被拒之后、连接重连之后）。同一个任务同时只有一发在途。 */
export function refreshTaskActions(taskId: string): Promise<void> {
  const pending = inflight.get(taskId);
  if (pending) return pending;
  const request = api.taskActions(taskId)
    .then(put, () => undefined)
    .finally(() => { inflight.delete(taskId); });
  inflight.set(taskId, request);
  return request;
}

export function useTaskActions(taskId: string | null | undefined): TaskActions | null {
  const read = useCallback(() => (taskId ? store.get(taskId) ?? null : null), [taskId]);
  const actions = useSyncExternalStore(subscribe, read, read);
  const connected = useServerEvents((event) => {
    if (event.type === "task.actions") put(event.actions);
  });
  useEffect(() => {
    if (taskId) void refreshTaskActions(taskId);
  }, [taskId, connected]);
  return actions;
}

/** 这颗键出不出：能做、或者做不了但该灰着说原因的，出；`hidden` 的不出。 */
export function shown(verdict: ActionVerdict | null | undefined): verdict is ActionVerdict {
  return !!verdict && (verdict.ok || !verdict.hidden);
}

/** 灰着的那句原因；能做时是 null。 */
export function blocker(verdict: ActionVerdict | null | undefined): string | null {
  return verdict && !verdict.ok ? verdict.reason : null;
}
