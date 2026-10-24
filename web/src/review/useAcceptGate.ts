import { useCallback, useEffect, useRef, useState } from "react";
import type { AcceptGateBasis, AcceptGateState, AcceptGateView } from "@ash/shared/accept-gate";
import { api } from "../lib/api.ts";
import { useServerEvents } from "../lib/events.ts";

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
  reload: () => Promise<void>;
} {
  // 状态自带它属于哪个任务：`taskId` 一变，上一个任务那份立刻不作数（清不清都一样安全），
  // 不必等新请求回来才把旧数据换掉。
  const [snap, setSnap] = useState<{ taskId: string; state: AcceptGateState; readAt: number } | null>(null);
  const [failure, setFailure] = useState<{ taskId: string; error: string } | null>(null);
  const [checking, setChecking] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  // 发出去的第几次。只有号最大的那一次（= 最后发出的）能落地，迟到的旧响应一律丢掉。
  const issued = useRef(0);
  const activeTask = useRef<string | null>(null);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryCount = useRef(0);

  const reload = useCallback(async (retry = false): Promise<void> => {
    if (activeTask.current !== taskId) return;
    if (retryTimer.current) clearTimeout(retryTimer.current);
    retryTimer.current = null;
    if (!retry) retryCount.current = 0;
    const mine = ++issued.current;
    setChecking(taskId);
    try {
      const next = await api.acceptGate(taskId);
      if (issued.current !== mine) return;
      setSnap({ taskId, state: next, readAt: Date.now() });
      setFailure(null);
      setChecking(null);
      retryCount.current = 0;
    } catch (reason) {
      if (issued.current !== mine) return;
      setFailure({ taskId, error: reason instanceof Error ? reason.message : String(reason) });
      setChecking(null);
      if (retryCount.current < 5) {
        const delay = Math.min(1000 * 2 ** retryCount.current++, 10000);
        retryTimer.current = setTimeout(() => { void reload(true); }, delay);
      }
    }
  }, [taskId]);

  useEffect(() => {
    activeTask.current = taskId;
    issued.current += 1;
    void reload();
    return () => {
      activeTask.current = null;
      issued.current += 1;
      if (retryTimer.current) clearTimeout(retryTimer.current);
      retryTimer.current = null;
    };
  }, [taskId, reload]);
  // 服务端的权威信号只有这一条：起了、结束了、被取消了，都发 task.acceptGate。
  const connected = useServerEvents((event) => {
    const relevant = event.type === "task.updated" ? event.task.id === taskId
      : (event.type === "task.acceptGate" || event.type === "task.stage") && event.taskId === taskId;
    if (!relevant) return;
    void reload();
  });
  // 每次（重新）连上都对一次账，理由见文件头。
  const linked = useRef(connected);
  useEffect(() => {
    const was = linked.current;
    linked.current = connected;
    if (connected && !was) void reload();
  }, [connected, reload]);

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
