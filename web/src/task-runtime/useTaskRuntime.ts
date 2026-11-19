// 任务的运行环境（托管服务 + 共享浏览器）：一个任务一条 1.5s 轮询。右侧「服务」「浏览器」两格、
// 竖轨上那两颗点、智能体开浏览器时自动切过去，读的都是这一份。
//
// 任务页换任务时不重挂（WorkspaceShell 复用同一个 TaskDetail），所以这一份 hook 会先后服务好几个
// 任务，同一个任务也会被反复进出（A→B→A）。归属的唯一来源是**签发能力的那一次渲染**：
//   - 访问代次 `visit`：每进入一次任务就换一代，A→B→A 回来也是新的一代。
//   - `perform` 和 `beginBrowserAction` 每一代（浏览器动作还按每个浏览器会话）各签一份，签发时就
//     把任务、代次、浏览器会话钉在闭包里，不在调用时再去读「现在是谁」。旧组件、排队的回调拿着的是
//     旧的那份，调用时对不上当前就直接作废——不会领到新任务的身份。
//   - 顺序号 `seq`：真正发起时领（查询、动作、浏览器回写共用一条序列）；只有比已落下的号新的才落。
//   - 浏览器回写还要核对响应里的浏览器 ID 就是发起时那个会话。
// 状态、两种错误、busy 都记着写下它的那一代，读的时候对不上就当没有。
//
// 错误只有一条通道：动作被拒（停止 / 重启 / 打开 / 接管 / 输入…，不管哪一格发起的）一直挂着，直到
// 你再做下一个动作；查询失败是暂时的，下一次查询成功就消失。两格都显示它，动作在哪一格发起、失败时
// 你停在哪一格都看得到。
import { useCallback, useEffect, useRef, useState } from "react";
import type { TaskBrowserState, TaskRuntimeState } from "@navi/shared/task-runtime";
import { runtimeApi } from "./runtimeApi.ts";

const EMPTY: TaskRuntimeState = { service: null, browser: null };
export const runtimeErrorText = (error: unknown) => error instanceof Error ? error.message : String(error);

type Ticket = { visit: number; seq: number };
type Stamped<T> = { visit: number; value: T };

/** 一个已发出的浏览器动作：结果、失败都经它落回。 */
export type BrowserActionTicket = {
  write: (next: TaskBrowserState) => void;
  fail: (reason: unknown) => void;
};

export type TaskRuntime = {
  taskId: string;
  state: TaskRuntimeState;
  /** 服务起来了、有地址可看。 */
  serviceReady: boolean;
  busy: boolean;
  /** 上一个动作被拒的原因（优先），或最近一次查询失败的原因。 */
  error: string;
  /**
   * 对当前浏览器会话发一个动作之前调用。签发它的那次渲染已经不是当前（换过任务、浏览器换了会话）
   * 就返回 null——这个动作不该再发出去。
   */
  beginBrowserAction: () => BrowserActionTicket | null;
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
  const browserId = state.browser?.id ?? null;

  /** 只给签发时那一代领号；那一代已经过去就领不到。 */
  const ticketFor = useCallback((origin: number): Ticket | null =>
    origin === visitRef.current ? { visit: origin, seq: ++seqRef.current } : null, []);
  const live = (held: Ticket) => held.visit === visitRef.current;
  /** 这张票的结果还能落：同一代、且比已落下的新。落了就把水位抬到它。 */
  const claim = (held: Ticket) => {
    if (!live(held) || held.seq <= appliedRef.current) return false;
    appliedRef.current = held.seq;
    return true;
  };
  const failWith = (held: Ticket, reason: unknown) => {
    if (live(held)) setActionError({ visit: held.visit, value: runtimeErrorText(reason) });
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
      const held = ticketFor(visit);
      if (!held) return;
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
  }, [taskId, visit, refresh, ticketFor]);

  const perform = useCallback(async (action: () => Promise<unknown>) => {
    if (busyRef.current && live(busyRef.current)) return;
    const held = ticketFor(visit);
    if (!held) return;
    busyRef.current = held;
    setBusyTicket(held);
    setActionError(null);
    try { await action(); }
    catch (reason) { failWith(held, reason); }
    // 动作完了再拉一次：领新票，它比动作期间发出的轮询都新。
    try { const after = ticketFor(visit); if (after) await refresh(taskId, after); } catch { /* 状态下一轮轮询再拉 */ }
    if (busyRef.current === held) { busyRef.current = null; setBusyTicket(null); }
  }, [taskId, visit, refresh, ticketFor]);

  const beginBrowserAction = useCallback((): BrowserActionTicket | null => {
    if (!browserId || stateRef.current.browser?.id !== browserId) return null;
    const held = ticketFor(visit);
    if (!held) return null;
    setActionError(null);
    const owns = () => live(held) && stateRef.current.browser?.id === browserId;
    return {
      write: (next) => {
        if (next.id !== browserId || !owns() || !claim(held)) return;
        setStateStamp((previous) => ({
          visit: held.visit,
          value: { ...(previous?.visit === held.visit ? previous.value : EMPTY), browser: next },
        }));
      },
      fail: (reason) => { if (owns()) failWith(held, reason); },
    };
  }, [visit, browserId, ticketFor]);

  const service = state.service;
  const error = (actionError?.visit === visit ? actionError.value : "") || (queryError?.visit === visit ? queryError.value : "");
  return {
    taskId, state, serviceReady: !!service?.url && !service.starting,
    busy: busyTicket?.visit === visit, error, beginBrowserAction, perform,
  };
}
