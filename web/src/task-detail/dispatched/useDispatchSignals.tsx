import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { DispatchSignal, Task, TaskListItem } from "@ash/shared";
import { api } from "../../lib/api.ts";
import { useServerEvents } from "../../lib/events.ts";
import { useCatchUp, useCatchUpLink } from "../../lib/useCatchUp.ts";
import { AnsweredQuestionCard } from "../QuestionHistory.tsx";
import type { FeedAside } from "../feedAsides.ts";
import { DispatchedBubble } from "./DispatchedBubble.tsx";
import { askingOrder, dispatchedSignature, dispatchFeed } from "./dispatchSignals.ts";

// 派它的那条任务这一页上，派出的任务来问 / 失败的那一摊：会话里那几颗气泡（按那一刻插进会话），
// 回复框那一格此刻轮到谁答。
//
// 记录读服务端那一份（刷新后还在原来的位置），不靠页面开着时收到的实时事件来记；实时事件只是
// 「去重读一次」的提示：服务端那一条 `task.dispatchSignals`，以及名下派出的任务此刻的样子变了
// （来问、答了、失败）—— 后者跟着任务列表一起到，不多开一条订阅。
//
// 这些都不进这条任务的会话正文、不进它的上下文，也不叫醒它：用户定的是派出的任务直接问用户。

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
    if (event.type === "task.dispatchSignals" && event.dispatcherId === taskId) void catchUp.run();
  });
  useCatchUpLink(catchUp, connected);
  // 名下那几条变了样：来问的那一行跟着那一笔落库，答没答过也要重新认一遍。
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
}): { asking: TaskListItem | null; asides: FeedAside[] } {
  const signals = useSignals(task.id, dispatched);
  // 自己在问就是自己那一张（跟改之前同一份 task），否则名下来问的那几条按先后一次一张。
  const asking = task.question ? task : askingOrder(task, dispatched, signals)[0] ?? null;
  const asides = useMemo(() => {
    const { bubbles, answers } = dispatchFeed(signals, allTasks);
    const list: FeedAside[] = bubbles.map((bubble) => ({
      key: bubble.key, at: bubble.at, node: <DispatchedBubble key={bubble.key} bubble={bubble} onOpen={onOpen} />,
    }));
    for (const answer of answers) {
      list.push({
        key: answer.key, at: answer.at,
        node: <AnsweredHere key={answer.key} record={answer.record} title={answer.title} />,
      });
    }
    return list.sort((a, b) => a.at.localeCompare(b.at));
  }, [allTasks, onOpen, signals]);
  return { asking, asides };
}

/** 在这里答的那一题：题目和答案留在你那颗气泡里，下面靠右一句小灰字说送到了谁那儿。 */
function AnsweredHere({ record, title }: { record: Parameters<typeof AnsweredQuestionCard>[0]["record"]; title: string }): ReactNode {
  return (
    <div className="dispatched-answer">
      <AnsweredQuestionCard record={record} />
      <div className="turn-footnote is-trailing"><p className="turn-footnote-line">答复直接送到了「{title}」，它接着跑了</p></div>
    </div>
  );
}
