import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { ActionVerdict, ServerEvent, TaskActions } from "@ash/shared";
import { api, ApiError } from "./api.ts";
import { type CatchUp, catchUpAbortKind, createCatchUp } from "./catchUp.ts";
import { subscribeConnection, subscribeEvents } from "./events.ts";

// 任务「此刻能做什么」的唯一取数点（判据整份在服务端，见 shared/src/task-actions.ts）。详情头、
// 回复框、信息格的队列、审查格、讨论页、团队头、命令面板都读这里，谁也不自己按任务状态推。
//
// 一份全局缓存，按任务认：同一个任务上同时挂着的几个表面共用一个追平实例，只发一次请求、看见的是
// 同一份。服务端在这个任务的结论可能变了的时候广播 `task.actions.stale`（相关事实一落库就发，谁写
// 的都一样），开着它的页面收到就重取；没开着的直接把缓存丢掉，下次打开再取。「开着」由这里自己记
// （挂载计数），服务端不记谁在看谁 —— 开着多少个、看过多少个任务都不会把哪张页面挤掉。
//
// 怎么读交给追平层（lib/catchUp.ts）：同一时刻只有一发在途、在途时又来了失效就落地后再补一趟、
// 一发挂住到点就掐、没读到（网络抖了、服务端 500）就隔一会儿再试；连接断了作废、连上了每个开着的
// 任务重对一遍账（断线窗口里的失效追不回来）。404 不重试 —— 任务没了、看不见了，或者服务端还是
// 不认这个接口的旧版本。响应之间还有一层序号：比手上那份旧的一律丢掉。
//
// 还没取到时返回 null：这几颗键都不出，等结论到了再出 —— 不拿前端自己的猜测先垫一份，那正是这一层
// 要消灭的东西。

const store = new Map<string, TaskActions>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function put(actions: TaskActions): void {
  const current = store.get(actions.taskId);
  if (current && current.seq >= actions.seq) return;
  store.set(actions.taskId, actions);
  emit();
}

function drop(taskId: string): void {
  if (store.delete(taskId)) emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** 开着的任务：挂着几个表面、共用的那个追平实例、还没发车的首读。 */
type Open = { count: number; catchUp: CatchUp; first: ReturnType<typeof setTimeout> | null };
const open = new Map<string, Open>();

async function read(taskId: string, signal: AbortSignal): Promise<boolean> {
  try {
    put(await api.taskActions(taskId, signal));
    return true;
  } catch (reason) {
    if (catchUpAbortKind(signal, reason) === "stale") return false;
    if (!(reason instanceof ApiError && reason.status === 404)) return false;
    // 404 是服务端说了算的「没有」：手上那份先前取到的也作废，不留着当真。
    drop(taskId);
    return true;
  }
}

function onServerEvent(event: ServerEvent): void {
  if (event.type === "task.actions.stale") {
    const entry = open.get(event.taskId);
    if (entry) void entry.catchUp.run();
    else drop(event.taskId);
  } else if (event.type === "task.actions.stale.all") {
    for (const taskId of [...store.keys()]) if (!open.has(taskId)) drop(taskId);
    for (const entry of open.values()) void entry.catchUp.run();
  }
}

function onConnection(connected: boolean): void {
  for (const entry of open.values()) {
    // 首读还没发车的不用再对账：它马上就去读了，再 run 一次只会多一趟。
    if (connected) { if (!entry.first) void entry.catchUp.run(); }
    else entry.catchUp.cancel();
  }
}

// 有任务开着时才挂在事件流上：一个都没开着就放手，别替别人把 EventSource 留着。
let unlink: (() => void) | null = null;

function acquire(taskId: string): void {
  const existing = open.get(taskId);
  if (existing) {
    existing.count += 1;
    return;
  }
  const entry: Open = { count: 1, catchUp: createCatchUp((signal) => read(taskId, signal)), first: null };
  // 首读推迟到下一个 tick：开发期 StrictMode 把挂载跑成 mount → cleanup → mount，立刻发车的话第一发
  // 会真的出门、又立刻被掐（同 useCatchUpLink）。
  entry.first = setTimeout(() => {
    entry.first = null;
    void entry.catchUp.run();
  }, 0);
  open.set(taskId, entry);
  if (!unlink) {
    const offEvents = subscribeEvents(onServerEvent);
    const offConnection = subscribeConnection(onConnection);
    unlink = () => { offEvents(); offConnection(); };
  }
}

function release(taskId: string): void {
  const entry = open.get(taskId);
  if (!entry) return;
  entry.count -= 1;
  if (entry.count) return;
  if (entry.first) clearTimeout(entry.first);
  entry.catchUp.cancel();
  open.delete(taskId);
  if (!open.size && unlink) {
    unlink();
    unlink = null;
  }
}

/** 被拒之后（撞车，或者手上那份已经过期）重取一次。有人在等这个结果：在途那一发让位。 */
export function refreshTaskActions(taskId: string): void {
  void open.get(taskId)?.catchUp.runNow();
}

export function useTaskActions(taskId: string | null | undefined): TaskActions | null {
  const readStore = useCallback(() => (taskId ? store.get(taskId) ?? null : null), [taskId]);
  const actions = useSyncExternalStore(subscribe, readStore, readStore);
  useEffect(() => {
    if (!taskId) return;
    acquire(taskId);
    return () => release(taskId);
  }, [taskId]);
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
