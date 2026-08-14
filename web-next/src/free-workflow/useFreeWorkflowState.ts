import { useCallback, useEffect, useState } from "react";
import { api, type FreeWorkflowApiState } from "../lib/api.ts";
import { useServerEvents } from "../lib/events.ts";

type StateListener = (state: FreeWorkflowApiState) => void;

const states = new Map<string, FreeWorkflowApiState>();
const listeners = new Map<string, Set<StateListener>>();
const inFlight = new Map<string, Promise<FreeWorkflowApiState>>();

// 唯一的新旧判据是**服务端的状态修订号**（stateVersion：task.review 事件驱动的单调计数，
// 不是 wall-clock）：mutation 响应先在服务端生成、之后才有 SSE 触发的 GET，即使它更晚
// 到达，修订号也更小——按到达顺序或请求发起顺序猜都会把新状态盖回旧值（审查实测两轮）。
// **相等修订号也拒收**：服务端的一致性重试有一条兜底路径会给可能混杂的内容配「读取前」
// 的小版本，同版本不再保证同内容——保留现值最保守，真有更新的状态必然带着更大的版本
// （事件 bump 后的 SSE 重取）跟进。
function publish(taskId: string, state: FreeWorkflowApiState): void {
  const taskListeners = listeners.get(taskId);
  if (!taskListeners?.size) return;
  const current = states.get(taskId);
  if (current && current.stateVersion >= state.stateVersion) return; // 不比现值新，丢弃
  states.set(taskId, state);
  for (const listener of taskListeners) listener(state);
}

function subscribe(taskId: string, listener: StateListener): () => void {
  const taskListeners = listeners.get(taskId) ?? new Set<StateListener>();
  taskListeners.add(listener);
  listeners.set(taskId, taskListeners);
  return () => {
    taskListeners.delete(listener);
    if (taskListeners.size) return;
    listeners.delete(taskId);
    states.delete(taskId);
  };
}

function loadShared(taskId: string, force = false): Promise<FreeWorkflowApiState> {
  if (!force) {
    const running = inFlight.get(taskId);
    if (running) return running;
  }
  const request = api.freeWorkflow(taskId).then((state) => {
    publish(taskId, state);
    return state;
  }).finally(() => {
    if (inFlight.get(taskId) === request) inFlight.delete(taskId);
  });
  inFlight.set(taskId, request);
  return request;
}

export function useFreeWorkflowState(taskId: string, enabled = true) {
  const [state, setLocalState] = useState<FreeWorkflowApiState | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);

  // mutation 响应与 GET 走同一道版本门禁：谁的快照新谁说了算，与到达顺序无关。
  const setState = useCallback((next: FreeWorkflowApiState) => {
    publish(taskId, next);
  }, [taskId]);

  const reload = useCallback(async (quiet = false, force = false) => {
    if (!enabled) return null;
    if (!quiet) setLoading(true);
    try {
      const next = await loadShared(taskId, force);
      setError(null);
      return next;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      return null;
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [enabled, taskId]);

  useEffect(() => {
    if (!enabled) {
      setLocalState(null);
      setLoading(false);
      setError(null);
      return;
    }
    const cached = states.get(taskId) ?? null;
    setLocalState(cached);
    setLoading(!cached);
    const unsubscribe = subscribe(taskId, (next) => {
      setLocalState(next);
      setError(null);
      setLoading(false);
    });
    void reload(!!cached);
    const timer = window.setInterval(() => void reload(true), 2500);
    return () => {
      window.clearInterval(timer);
      unsubscribe();
    };
  }, [enabled, reload, taskId]);

  useServerEvents(useCallback((event) => {
    // 服务端刚宣布状态变了：强制发一个新 GET（复用早先在飞的请求拿到的可能还是变更前的世界）。
    if (enabled && event.type === "task.review" && event.taskId === taskId) void reload(true, true);
  }, [enabled, reload, taskId]));

  return { state, setState, loading, error, reload };
}
