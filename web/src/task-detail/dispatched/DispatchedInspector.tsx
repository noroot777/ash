import { useEffect, useState } from "react";
import type { TaskListItem } from "@ash/shared";
import { taskLook } from "../../lib/taskLook.ts";
import { dispatchedMeta, dispatchedOrder, dispatchedWord } from "./dispatchedRows.ts";

// 右侧「派出的任务」那一格：这条任务直接派出去的那几条，一行一个 —— 状态点、标题、一行小字
// （执行器、用时），右端是状态词。点一行在左边抽屉里打开它（会话和回复框都在，能直接对它说话）；
// 要整页进去，抽屉头上有那颗键。
//
// 数据就是任务列表本身（随 SSE 实时合并），新派出去的、状态变了的不用刷新就跟着变。

// 行首那颗点跟侧栏同一张表（lib/taskLook）；状态词就在同一行右端，点不再另报一遍名字。
function StatusMark({ task }: { task: TaskListItem }) {
  const mark = taskLook(task).mark;
  return mark ? <i className={`workspace-status-dot workspace-status-dot--${mark}`} aria-hidden="true" /> : null;
}

const anyTicking = (tasks: readonly TaskListItem[]) => tasks.some((task) => !!task.startedAt && !task.endedAt);

export function DispatchedInspector({
  dispatched,
  openId,
  onOpen,
  head,
}: {
  dispatched: readonly TaskListItem[];
  /** 此刻在左边抽屉里开着的那一条。 */
  openId: string | null;
  onOpen: (taskId: string) => void;
  /** 格头那一句之后跟着的东西（「全部停下」那颗键）。 */
  head?: React.ReactNode;
}) {
  const ticking = anyTicking(dispatched);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, [ticking]);
  const order = dispatchedOrder(dispatched);
  return (
    <div className="dispatched-pane">
      <p className="dispatched-head">
        <span>{[`${dispatched.length} 个`, order].filter(Boolean).join(" · ")}</span>
        {head}
      </p>
      <ul className="dispatched-list" aria-label="派出的任务">
        {dispatched.map((task) => {
          const { word, tone } = dispatchedWord(task);
          const meta = dispatchedMeta(task, now);
          const title = task.title || "未命名任务";
          return (
            <li key={task.id}>
              <button
                type="button"
                className={`dispatched-row${openId === task.id ? " is-open" : ""}`}
                aria-pressed={openId === task.id}
                aria-label={`${title}，${word}${meta ? `，${meta}` : ""}`}
                onClick={() => onOpen(task.id)}
              >
                <span className="dispatched-row__mark"><StatusMark task={task} /></span>
                <span className="dispatched-row__main">
                  <b>{title}</b>
                  {meta && <small>{meta}</small>}
                </span>
                <em className={tone ? `is-${tone}` : undefined}>{word}</em>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
