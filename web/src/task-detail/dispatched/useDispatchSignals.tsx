import { useEffect, useMemo, useRef, useState } from "react";
import type { DispatchSignal, Task, TaskListItem } from "@ash/shared";
import { api } from "../../lib/api.ts";
import { useServerEvents } from "../../lib/events.ts";
import { useCatchUp, useCatchUpLink } from "../../lib/useCatchUp.ts";
import type { FeedAside } from "../feedAsides.ts";
import { DispatchedBubble } from "./DispatchedBubble.tsx";
import { dispatchBubbles, dispatchedSignature } from "./dispatchSignals.ts";

// 派它的那条任务这一页上，派出的任务失败的那几颗气泡（按那一刻插进会话）。
//
// 记录读服务端那一份（刷新后还在原来的位置），不靠页面开着时收到的实时事件来记；实时事件只是
// 「去重读一次」的提示：服务端那一条 `task.dispatchSignals`，以及名下派出的任务此刻的样子变了
// —— 后者跟着任务列表一起到，不多开一条订阅。
//
// 这些都不进这条任务的会话正文、不进它的上下文，也不叫醒它。

const NONE: DispatchSignal[] = [];

function useSignals(taskId: string, dispatched: readonly TaskListItem[]): DispatchSignal[] {
  const [state, setState] = useState<{ taskId: string; signals: DispatchSignal[] }>({ taskId, signals: NONE });
  const catchUp = useCatchUp((signal) => api.taskDispatchSignals(taskId, signal).then(
    (signals) => {
      setState({ taskId, signals });
      return true;
    },
    () => false,
  ), taskId);
  useEffect(() => { void catchUp.run(); }, [catchUp]);
  const connected = useServerEvents((event) => {
    if (event.type === "task.dispatchSignals" && event.taskId === taskId) void catchUp.run();
  });
  useCatchUpLink(catchUp, connected);
  // 名下那几条变了样：失败的那一行跟着那一笔落库，原因在同一个事务里写下。
  const signature = dispatchedSignature(dispatched);
  const seen = useRef(signature);
  useEffect(() => {
    if (seen.current === signature) return;
    seen.current = signature;
    void catchUp.run();
  }, [catchUp, signature]);
  return state.taskId === taskId ? state.signals : NONE;
}

export function useDispatchSignals({ task, allTasks, dispatched, onOpen }: {
  task: Task;
  allTasks: TaskListItem[];
  /** 这条任务直接派出去的那几条（右侧「派出的任务」那一格同一份）。 */
  dispatched: readonly TaskListItem[];
  /** 在左边抽屉里打开一条派出的任务。 */
  onOpen: (taskId: string) => void;
}): { asides: FeedAside[] } {
  const signals = useSignals(task.id, dispatched);
  const asides = useMemo(() => dispatchBubbles(signals, allTasks).map((bubble) => ({
    key: bubble.key, at: bubble.at, node: <DispatchedBubble key={bubble.key} bubble={bubble} onOpen={onOpen} />,
  })), [allTasks, onOpen, signals]);
  return { asides };
}
