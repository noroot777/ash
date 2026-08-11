import { useCallback, useEffect, useState } from "react";
import { api, type FreeWorkflowApiState } from "../lib/api.ts";
import { useServerEvents } from "../lib/events.ts";

type StateListener = (state: FreeWorkflowApiState) => void;

const states = new Map<string, FreeWorkflowApiState>();
const listeners = new Map<string, Set<StateListener>>();
const inFlight = new Map<string, Promise<FreeWorkflowApiState>>();
// 每个 task 只允许「最后声明的来源」写入共享状态：mutation 响应和新发起的 GET 都会占
// 一个更大的序号，早先在飞的 GET 返回时序号已旧，直接丢弃——否则「早发起晚返回」的
// GET 会把 mutation 刚写入的新状态盖回旧值（窗口最长一个轮询周期）。
const latestWriter = new Map<string, number>();
let writerSeq = 0;

function publish(taskId: string, state: FreeWorkflowApiState): void {
  const taskListeners = listeners.get(taskId);
  if (!taskListeners?.size) return;
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
    latestWriter.delete(taskId);
  };
}

function loadShared(taskId: string, force = false): Promise<FreeWorkflowApiState> {
  if (!force) {
    const running = inFlight.get(taskId);
    if (running) return running;
  }
  const seq = ++writerSeq;
  latestWriter.set(taskId, seq);
  const request = api.freeWorkflow(taskId).then((state) => {
    if (latestWriter.get(taskId) === seq) publish(taskId, state);
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

  // mutation 的响应就是此刻最权威的状态：占最新序号，让所有在飞 GET 作废。
  const setState = useCallback((next: FreeWorkflowApiState) => {
    latestWriter.set(taskId, ++writerSeq);
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
