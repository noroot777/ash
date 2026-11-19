// 任务的运行环境（托管服务 + 共享浏览器）：一个任务一条 1.5s 轮询。右侧「服务」「浏览器」两格、
// 竖轨上那两颗点、智能体开浏览器时自动切过去，读的都是这一份。
//
// 任务页换任务时不重挂（WorkspaceShell 复用同一个 TaskDetail），所以这一份 hook 会先后服务好几个
// 任务。每个异步落点（轮询、动作后的刷新、浏览器动作的回写）都带着发起时的任务身份和请求代次：
// 只落给当前任务，且不比已经落下的那份旧——上一个任务迟到的响应、同一任务里被后来者超车的旧查询，
// 一律丢掉。状态、错误、busy 都按任务记，读的时候对不上当前任务就当没有。
//
// 错误分两种：动作被拒（停止 / 重启 / 打开浏览器失败）要一直挂着，直到你再做下一个动作；查询失败
// 是暂时的，下一次查询成功就消失。两者分开存，成功的轮询不会把动作的失败原因冲掉。
import { useCallback, useEffect, useRef, useState } from "react";
import type { TaskBrowserState, TaskRuntimeState } from "@ash/shared/task-runtime";
import { runtimeApi } from "./runtimeApi.ts";

const EMPTY: TaskRuntimeState = { service: null, browser: null };
export const runtimeErrorText = (error: unknown) => error instanceof Error ? error.message : String(error);

type Owned<T> = { taskId: string; value: T };

export type TaskRuntime = {
  taskId: string;
  state: TaskRuntimeState;
  /** 服务起来了、有地址可看。 */
  serviceReady: boolean;
  busy: boolean;
  /** 上一个动作被拒的原因（优先），或最近一次查询失败的原因。 */
  error: string;
  /** 浏览器动作的回写。`taskId` 是发起那个动作时的任务：换了任务再回来的就丢掉。 */
  setBrowser: (taskId: string, next: TaskBrowserState) => void;
  /** 跑一个改运行环境的动作（停服务、开浏览器…），完了重新拉一次状态；失败的原因留着直到下一个动作。 */
  perform: (action: () => Promise<unknown>) => Promise<void>;
};

export function useTaskRuntime(taskId: string): TaskRuntime {
  const [owned, setOwned] = useState<Owned<TaskRuntimeState> | null>(null);
  const [queryError, setQueryError] = useState<Owned<string> | null>(null);
  const [actionError, setActionError] = useState<Owned<string> | null>(null);
  const [busyFor, setBusyFor] = useState<string | null>(null);
  const current = useRef(taskId);
  current.current = taskId;
  // 代次：每次发查询或回写浏览器都领一个号，只有比已落下的号新的才落。
  const issued = useRef(0);
  const applied = useRef(0);
  const busyRef = useRef<string | null>(null);
  const hasAny = useRef(false);
  const state = owned?.taskId === taskId ? owned.value : EMPTY;
  hasAny.current = !!(state.browser || state.service);

  const refresh = useCallback(async (forTask: string) => {
    const seq = ++issued.current;
    const next = await runtimeApi.state(forTask);
    if (current.current !== forTask || seq <= applied.current) return;
    applied.current = seq;
    setOwned({ taskId: forTask, value: next });
    setQueryError(null);
  }, []);

  useEffect(() => {
    let canceled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { await refresh(taskId); }
      catch (reason) {
        // 什么都没有的任务拉失败了不吵：那一格本来就不在。
        if (!canceled && current.current === taskId && hasAny.current) setQueryError({ taskId, value: runtimeErrorText(reason) });
      }
      if (!canceled) timer = setTimeout(() => void poll(), 1500);
    };
    void poll();
    return () => { canceled = true; clearTimeout(timer); };
  }, [taskId, refresh]);

  const perform = useCallback(async (action: () => Promise<unknown>) => {
    const forTask = current.current;
    if (busyRef.current === forTask) return;
    busyRef.current = forTask;
    setBusyFor(forTask);
    setActionError(null);
    try { await action(); }
    catch (reason) { if (current.current === forTask) setActionError({ taskId: forTask, value: runtimeErrorText(reason) }); }
    try { await refresh(forTask); } catch { /* 状态下一轮轮询再拉 */ }
    if (busyRef.current === forTask) { busyRef.current = null; setBusyFor(null); }
  }, [refresh]);

  const setBrowser = useCallback((forTask: string, next: TaskBrowserState) => {
    if (current.current !== forTask) return;
    applied.current = ++issued.current;
    setOwned((previous) => ({ taskId: forTask, value: { ...(previous?.taskId === forTask ? previous.value : EMPTY), browser: next } }));
  }, []);

  const service = state.service;
  const error = (actionError?.taskId === taskId ? actionError.value : "") || (queryError?.taskId === taskId ? queryError.value : "");
  return { taskId, state, serviceReady: !!service?.url && !service.starting, busy: busyFor === taskId, error, setBrowser, perform };
}
