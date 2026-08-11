import { useCallback, useEffect, useState } from "react";
import { api, type FreeWorkflowApiState } from "../lib/api.ts";
import { useServerEvents } from "../lib/events.ts";

type StateListener = (state: FreeWorkflowApiState) => void;

const states = new Map<string, FreeWorkflowApiState>();
const listeners = new Map<string, Set<StateListener>>();
const inFlight = new Map<string, Promise<FreeWorkflowApiState>>();

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
  };
}

function loadShared(taskId: string): Promise<FreeWorkflowApiState> {
  const running = inFlight.get(taskId);
  if (running) return running;
  const request = api.freeWorkflow(taskId).then((state) => {
    publish(taskId, state);
    return state;
  }).finally(() => inFlight.delete(taskId));
  inFlight.set(taskId, request);
  return request;
}

export function useFreeWorkflowState(taskId: string, enabled = true) {
  const [state, setLocalState] = useState<FreeWorkflowApiState | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);

  const setState = useCallback((next: FreeWorkflowApiState) => publish(taskId, next), [taskId]);

  const reload = useCallback(async (quiet = false) => {
    if (!enabled) return null;
    if (!quiet) setLoading(true);
    try {
      const next = await loadShared(taskId);
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
    if (enabled && event.type === "task.review" && event.taskId === taskId) void reload(true);
  }, [enabled, reload, taskId]));

  return { state, setState, loading, error, reload };
}
