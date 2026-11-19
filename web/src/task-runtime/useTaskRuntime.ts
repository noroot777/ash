// 任务的运行环境（托管服务 + 共享浏览器）：一个任务一条 1.5s 轮询。右侧「服务」「浏览器」两格、
// 竖轨上那两颗点、智能体开浏览器时自动切过去，读的都是这一份。
//
// 任务页换任务时不重挂（WorkspaceShell 复用同一个 TaskDetail），所以这一份 hook 会先后服务好几个
// 任务，同一个任务也会被反复进出（A→B→A）。所有异步落点只认一张票（Ticket）：
//   - 访问代次 `visit`：每进入一次任务就换一代，A→B→A 回来也是新的一代。票的代次不是当前这一代，
//     结果一律丢掉——不管任务 ID 是不是碰巧相同。
//   - 顺序号 `seq`：**发起时**领（查询、动作、浏览器回写共用一条序列）；只有比已落下的号新的才落。
//     返回时才领号就会把迟到的旧结果当成最新的。
//   - 浏览器回写另核对发起时的浏览器会话：期间浏览器被关掉重开、换成了另一个会话，旧动作的结果不能
//     盖到新会话上。
// 状态、两种错误、busy 都记着写下它的那一代（busy 还记着是哪张票开的），读的时候对不上就当没有；
// 清理也只清自己那张票写下的。
//
// 错误分两种：动作被拒（停止 / 重启 / 打开浏览器失败）要一直挂着，直到你再做下一个动作；查询失败
// 是暂时的，下一次查询成功就消失。两者分开存，成功的轮询不会把动作的失败原因冲掉。
import { useCallback, useEffect, useRef, useState } from "react";
import type { TaskBrowserState, TaskRuntimeState } from "@ash/shared/task-runtime";
import { runtimeApi } from "./runtimeApi.ts";

const EMPTY: TaskRuntimeState = { service: null, browser: null };
export const runtimeErrorText = (error: unknown) => error instanceof Error ? error.message : String(error);

type Ticket = { visit: number; seq: number };
type Stamped<T> = { visit: number; value: T };

export type TaskRuntime = {
  taskId: string;
  state: TaskRuntimeState;
  /** 服务起来了、有地址可看。 */
  serviceReady: boolean;
  busy: boolean;
  /** 上一个动作被拒的原因（优先），或最近一次查询失败的原因。 */
  error: string;
  /**
   * 发一个浏览器动作之前领票，返回把结果写回来的函数。票记着此刻的访问代次、顺序号和浏览器会话；
   * 结果回来时三者有一样对不上（换过任务、有更新的结果落下了、浏览器换了会话），就丢掉。
   */
  beginBrowserWrite: () => (next: TaskBrowserState) => void;
  /** 跑一个改运行环境的动作（停服务、开浏览器…），完了重新拉一次状态；失败的原因留着直到下一个动作。 */
  perform: (action: () => Promise<unknown>) => Promise<void>;
};

export function useTaskRuntime(taskId: string): TaskRuntime {
  // 访问代次在渲染时就换：effect 之前那一帧里落下的旧结果也认不出是哪一代，得从这一帧起就作废。
  const visitRef = useRef(0);
  const visitTask = useRef<string | null>(null);
  if (visitTask.current !== taskId) {
    visitTask.current = taskId;
    visitRef.current += 1;
  }
  const visit = visitRef.current;
  const [stateStamp, setStateStamp] = useState<Stamped<TaskRuntimeState> | null>(null);
  const [queryError, setQueryError] = useState<Stamped<string> | null>(null);
  const [actionError, setActionError] = useState<Stamped<string> | null>(null);
  const [busyTicket, setBusyTicket] = useState<Ticket | null>(null);
  const seqRef = useRef(0);
  const appliedRef = useRef(0);
  const busyRef = useRef<Ticket | null>(null);
  const state = stateStamp?.visit === visit ? stateStamp.value : EMPTY;
  const stateRef = useRef(state);
  stateRef.current = state;

  const ticket = useCallback((): Ticket => ({ visit: visitRef.current, seq: ++seqRef.current }), []);
  const live = (held: Ticket) => held.visit === visitRef.current;
  /** 这张票的结果还能落：同一代、且比已落下的新。落了就把水位抬到它。 */
  const claim = (held: Ticket) => {
    if (!live(held) || held.seq <= appliedRef.current) return false;
    appliedRef.current = held.seq;
    return true;
  };

  const refresh = useCallback(async (forTask: string, held: Ticket) => {
    const next = await runtimeApi.state(forTask);
    if (!claim(held)) return;
    setStateStamp({ visit: held.visit, value: next });
    setQueryError(null);
  }, []);

  useEffect(() => {
    let canceled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const held = ticket();
      try { await refresh(taskId, held); }
      catch (reason) {
        // 什么都没有的任务拉失败了不吵：那一格本来就不在。
        const shown = stateRef.current;
        if (!canceled && live(held) && (shown.browser || shown.service)) setQueryError({ visit: held.visit, value: runtimeErrorText(reason) });
      }
      if (!canceled) timer = setTimeout(() => void poll(), 1500);
    };
    void poll();
    return () => { canceled = true; clearTimeout(timer); };
  }, [taskId, refresh, ticket]);

  const perform = useCallback(async (action: () => Promise<unknown>) => {
    const held = ticket();
    const forTask = visitTask.current!;
    if (busyRef.current && live(busyRef.current)) return;
    busyRef.current = held;
    setBusyTicket(held);
    setActionError(null);
    try { await action(); }
    catch (reason) { if (live(held)) setActionError({ visit: held.visit, value: runtimeErrorText(reason) }); }
    // 动作完了再拉一次：领新票，它比动作期间发出的轮询都新。
    try { if (live(held)) await refresh(forTask, ticket()); } catch { /* 状态下一轮轮询再拉 */ }
    if (busyRef.current === held) { busyRef.current = null; setBusyTicket(null); }
  }, [refresh, ticket]);

  const beginBrowserWrite = useCallback(() => {
    const held = ticket();
    const browserId = stateRef.current.browser?.id ?? null;
    return (next: TaskBrowserState) => {
      if (stateRef.current.browser?.id !== browserId || !claim(held)) return;
      setStateStamp((previous) => ({
        visit: held.visit,
        value: { ...(previous?.visit === held.visit ? previous.value : EMPTY), browser: next },
      }));
    };
  }, [ticket]);

  const service = state.service;
  const error = (actionError?.visit === visit ? actionError.value : "") || (queryError?.visit === visit ? queryError.value : "");
  return {
    taskId, state, serviceReady: !!service?.url && !service.starting,
    busy: busyTicket?.visit === visit, error, beginBrowserWrite, perform,
  };
}
