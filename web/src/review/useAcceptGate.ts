import { useCallback, useEffect, useRef, useState } from "react";
import type { AcceptGateBasis, AcceptGateState, AcceptGateView } from "@ash/shared/accept-gate";
import { api } from "../lib/api.ts";
import { type CatchUpOptions, catchUpAbortKind } from "../lib/catchUp.ts";
import { useServerEvents } from "../lib/events.ts";
import { useCatchUp, useCatchUpLink } from "../lib/useCatchUp.ts";

/**
 * 「这个任务的验收前置命令此刻怎么样」—— 两处表面共用的那一份状态。
 *
 * 验收台那张卡（`AcceptGateCard`）和主会话页输入框上方那条（`AcceptGateWaitCard`）要的
 * 是同一件事实，而**对账逻辑一点都不能少**：事件流没有历史回放，断线那几十秒里「跑完了」
 * 这条事件没人接，卡就会永远停在「正在跑」—— 那正是这功能要消灭的幽灵状态。所以读取、
 * 订阅、每次重连都重新对一次账、以及让「已经 N 分 N 秒」自己走的那个秒表，统一写在这里，
 * 别在第二个表面上再抄一遍（抄一遍就一定会漏掉其中一条）。
 *
 * ── 落地的只能是「当前这个任务、当前这一代」的结果（第 1 轮审查 F3 实测）────────────
 * 这些读取是**并发**的：首读、每条 SSE、每次重连、手动刷新都调同一个 reload，而它们的
 * 响应回来的顺序跟发出去的顺序没有关系。实测过的那一幕：请求 5（running）响应体在慢连接
 * 上迟到，请求 6（passed）先回来落了地，随后请求 5 才回来，把已经结束的那次又写回「正在
 * 跑」—— 秒表继续加，页面从此停在一个早已结束的命令上，没有任何后续事件会来纠正它。
 * 所以每次读取带一个代次，只有**最后一次发出**的那个结果可以落地；切任务时连代次带状态
 * 一起换掉（上一个任务的状态一秒都不许出现在新任务的卡上）。
 */
/**
 * 这一屏自己的节奏与措辞。
 *
 * **重试**:退五次(1 → 2 → 4 → 8 → 10 秒)之后停下来 —— 跟任务列表那几条静默追平不一样,
 * 这条等待条是用户正盯着的,读不到时它会如实写「状态待核对」并给一颗「刷新状态」按钮:有人
 * 在看、有出路,就不该在后台无限地敲服务端(实测确立过的行为)。按下那颗按钮是一次新的
 * `run()`,额度跟着清零(见 CatchUpRetry)。
 *
 * **超时那句话**由这一屏自己说:它要讲出秒数和出路,而追平层并不知道这一屏有没有刷新按钮。
 */
const GATE_CATCH_UP: CatchUpOptions = {
  retry: (failures) => (failures > 5 ? null : Math.min(1000 * 2 ** (failures - 1), 10_000)),
  deadlineMessage: "读取验收前置命令超时（15 秒），可刷新重试",
};

export function useAcceptGate(taskId: string): {
  state: AcceptGateState | null;
  error: string | null;
  stale: boolean;
  running: AcceptGateView | null;
  latest: AcceptGateView | null;
  /** 这一按当初拿什么放的行（已验收才有；null = 还没验收，或老数据没留凭据）。 */
  basis: AcceptGateBasis | null;
  /**
   * 正在跑的那一条「已经 N 分 N 秒」（没在跑就是 null）。
   *
   * 由这里给出而不是把秒表心跳交出去：那个心跳只为了触发重算，值本身没有意义，
   * 漏到调用方就变成一个必须被转手传进某个函数、否则就会被当成未使用变量的累赘。
   */
  runningFor: string | null;
  /** 「该重读了」。返回的 promise 在这一趟落地后兑现(调用方 await 它来解锁按钮)。 */
  reload: () => Promise<void>;
} {
  // 状态自带它属于哪个任务：`taskId` 一变，上一个任务那份立刻不作数（清不清都一样安全），
  // 不必等新请求回来才把旧数据换掉。
  const [snap, setSnap] = useState<{ taskId: string; state: AcceptGateState; readAt: number } | null>(null);
  const [failure, setFailure] = useState<{ taskId: string; error: string } | null>(null);
  const [checking, setChecking] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  // 这一份**属于谁**。读取的单飞、代次、重试、超时掐断全在追平层(lib/catchUp.ts),这里只
  // 剩「这一份能不能写进 state」——追平层掐断那一瞬,请求可能已经 resolve 了。
  const activeTask = useRef<string | null>(null);

  /**
   * 读一趟。
   *
   * 上一版这里是自己一套:AbortController + 15 秒超时 + 最多 5 次指数退避 + issued 序号,
   * 而「连上就对账」只认 false→true 那一下、断线不作废在途那一发(第 5 轮审查 N1 点到的
   * 五种写法之一)。那四样东西现在都是追平层的职责,它们只该有一份实现。
   */
  const read = useCallback(async (signal: AbortSignal): Promise<boolean> => {
    if (activeTask.current !== taskId) return true;
    setChecking(taskId);
    try {
      const next = await api.acceptGate(taskId, signal);
      if (activeTask.current !== taskId) return true;
      setSnap({ taskId, state: next, readAt: Date.now() });
      setFailure(null);
      setChecking(null);
      return true;
    } catch (reason) {
      if (activeTask.current !== taskId) return true;
      setChecking(null);
      // 换了代次的那一发不作数(断线/切任务/卸载):一个字都不说,新代次会自己追平。
      // 等到点的那一种照实说 —— 它的 reason 本身就是人话,而且追平层还会接着重试。
      if (catchUpAbortKind(signal, reason) === "stale") return false;
      setFailure({ taskId, error: reason instanceof Error ? reason.message : String(reason) });
      return false;
    }
  }, [taskId]);
  const catchUp = useCatchUp(read, taskId, GATE_CATCH_UP);
  // 交出去的是**抢占式**那一个:它的调用方全是「人正等着」—— 那颗刷新按钮,以及几个动作
  // 「做完 → 等状态刷新 → 解锁按钮」的 await(见 CatchUp.runNow 为什么不能跟背景触发合流:
  // 实测过一发挂住的背景读取把「验收通过」这一按拖到 30 秒之后才发出去)。
  const reload = catchUp.runNow;

  useEffect(() => {
    activeTask.current = taskId;
    void catchUp.run();
    return () => { activeTask.current = null; };
  }, [catchUp, taskId]);
  // 服务端的权威信号只有这一条：起了、结束了、被取消了，都发 task.acceptGate。
  const connected = useServerEvents((event) => {
    const relevant = event.type === "task.updated" ? event.task.id === taskId
      : (event.type === "task.acceptGate" || event.type === "task.stage") && event.taskId === taskId;
    if (!relevant) return;
    void catchUp.run();
  });
  // 每次（重新）连上都对一次账、断线就把这一代次作废，理由见文件头与 lib/useCatchUp.ts。
  useCatchUpLink(catchUp, connected);

  const state = snap?.taskId === taskId ? snap.state : null;
  const error = failure?.taskId === taskId ? failure.error : null;
  const stale = !!state && (checking === taskId || !!error);
  const running = state?.running ?? null;
  // 「已经跑了 N 分 N 秒」要自己走：这中间服务端一个事件都不会发（命令还在跑），
  // 不走就会定在点下去那一刻的 0 秒上，看着像卡死了。
  useEffect(() => {
    if (!running || stale) return;
    const timer = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [running, stale]);

  // tick 只在这儿用：它每秒 +1 触发重渲染，下面这句才会跟着重算。
  void tick;
  return {
    state,
    error,
    stale,
    running,
    latest: state?.latest ?? null,
    basis: state?.basis ?? null,
    runningFor: running ? elapsedSince(running.startedAt, stale ? snap!.readAt : Date.now()) : null,
    reload,
  };
}

/** 「已经跑了多久」。两处表面同一套措辞。 */
export function elapsedSince(from: string, at = Date.now()): string {
  const ms = Math.max(0, at - new Date(from).getTime());
  const total = Math.floor(ms / 1000);
  const min = Math.floor(total / 60);
  return min > 0 ? `${min} 分 ${total % 60} 秒` : `${total} 秒`;
}
