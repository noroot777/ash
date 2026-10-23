import { useCallback, useEffect, useRef, useState } from "react";
import type { AcceptGateView } from "@ash/shared/accept-gate";
import { api, type AcceptGateState } from "../lib/api.ts";
import { useServerEvents } from "../lib/events.ts";

/**
 * 「这个任务的验收前置命令此刻怎么样」—— 两处表面共用的那一份状态。
 *
 * 验收台那张卡（`AcceptGateCard`）和主会话页输入框上方那条（`AcceptGateWaitCard`）要的
 * 是同一件事实，而**对账逻辑一点都不能少**：事件流没有历史回放，断线那几十秒里「跑完了」
 * 这条事件没人接，卡就会永远停在「正在跑」—— 那正是这功能要消灭的幽灵状态。所以读取、
 * 订阅、每次重连都重新对一次账、以及让「已经 N 分 N 秒」自己走的那个秒表，统一写在这里，
 * 别在第二个表面上再抄一遍（抄一遍就一定会漏掉其中一条）。
 */
export function useAcceptGate(taskId: string): {
  state: AcceptGateState | null;
  error: string | null;
  running: AcceptGateView | null;
  latest: AcceptGateView | null;
  /**
   * 正在跑的那一条「已经 N 分 N 秒」（没在跑就是 null）。
   *
   * 由这里给出而不是把秒表心跳交出去：那个心跳只为了触发重算，值本身没有意义，
   * 漏到调用方就变成一个必须被转手传进某个函数、否则就会被当成未使用变量的累赘。
   */
  runningFor: string | null;
  reload: () => Promise<void>;
} {
  const [state, setState] = useState<AcceptGateState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const reload = useCallback(async () => {
    try {
      setState(await api.acceptGate(taskId));
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [taskId]);

  useEffect(() => { void reload(); }, [reload]);
  // 服务端的权威信号只有这一条：起了、结束了、被取消了，都发 task.acceptGate。
  const connected = useServerEvents((event) => {
    if (event.type !== "task.acceptGate" || event.taskId !== taskId) return;
    void reload();
  });
  // 每次（重新）连上都对一次账，理由见文件头。
  const linked = useRef(connected);
  useEffect(() => {
    const was = linked.current;
    linked.current = connected;
    if (connected && !was) void reload();
  }, [connected, reload]);

  const running = state?.running ?? null;
  // 「已经跑了 N 分 N 秒」要自己走：这中间服务端一个事件都不会发（命令还在跑），
  // 不走就会定在点下去那一刻的 0 秒上，看着像卡死了。
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [running]);

  // tick 只在这儿用：它每秒 +1 触发重渲染，下面这句才会跟着重算。
  void tick;
  return {
    state,
    error,
    running,
    latest: state?.latest ?? null,
    runningFor: running ? elapsedSince(running.startedAt) : null,
    reload,
  };
}

/** 「已经跑了多久」。两处表面同一套措辞。 */
export function elapsedSince(from: string): string {
  const ms = Math.max(0, Date.now() - new Date(from).getTime());
  const total = Math.floor(ms / 1000);
  const min = Math.floor(total / 60);
  return min > 0 ? `${min} 分 ${total % 60} 秒` : `${total} 秒`;
}
