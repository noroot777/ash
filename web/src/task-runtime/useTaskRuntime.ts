// 任务的运行环境（托管服务 + 共享浏览器）：一个任务一条 1.5s 轮询。右侧「服务」「浏览器」两格、
// 竖轨上那两颗点、智能体开浏览器时自动切过去，读的都是这一份。
import { useCallback, useEffect, useRef, useState } from "react";
import type { TaskBrowserState, TaskRuntimeState } from "@ash/shared/task-runtime";
import { runtimeApi } from "./runtimeApi.ts";

const EMPTY: TaskRuntimeState = { service: null, browser: null };
export const runtimeErrorText = (error: unknown) => error instanceof Error ? error.message : String(error);

export type TaskRuntime = {
  taskId: string;
  state: TaskRuntimeState;
  /** 服务起来了、有地址可看。 */
  serviceReady: boolean;
  busy: boolean;
  error: string;
  setBrowser: (next: TaskBrowserState) => void;
  /** 跑一个改运行环境的动作（停服务、开浏览器…），完了重新拉一次状态；失败记进 error。 */
  perform: (action: () => Promise<unknown>) => Promise<void>;
};

export function useTaskRuntime(taskId: string): TaskRuntime {
  const [state, setState] = useState<TaskRuntimeState>(EMPTY);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const live = useRef(true);
  const stateRef = useRef(state);
  stateRef.current = state;
  const refresh = useCallback(async () => {
    const next = await runtimeApi.state(taskId);
    if (live.current) { setState(next); setError(""); }
  }, [taskId]);
  useEffect(() => {
    live.current = true;
    setState(EMPTY);
    let canceled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { await refresh(); }
      // 什么都没有的任务拉失败了不吵：那一格本来就不在。
      catch (reason) { if (!canceled && (stateRef.current.browser || stateRef.current.service)) setError(runtimeErrorText(reason)); }
      if (!canceled) timer = setTimeout(() => void poll(), 1500);
    };
    void poll();
    return () => { canceled = true; live.current = false; clearTimeout(timer); };
  }, [refresh]);
  const busyRef = useRef(false);
  const perform = useCallback(async (action: () => Promise<unknown>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try { await action(); await refresh(); }
    catch (reason) { setError(runtimeErrorText(reason)); await refresh().catch(() => {}); }
    finally { busyRef.current = false; if (live.current) setBusy(false); }
  }, [refresh]);
  const setBrowser = useCallback((next: TaskBrowserState) => setState((previous) => ({ ...previous, browser: next })), []);
  const service = state.service;
  return { taskId, state, serviceReady: !!service?.url && !service.starting, busy, error, setBrowser, perform };
}
