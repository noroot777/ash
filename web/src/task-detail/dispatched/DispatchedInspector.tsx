import { useEffect, useMemo, useState } from "react";
import type { Task, TaskListItem } from "@ash/shared";
import { taskLook } from "../../lib/taskLook.ts";
import { dispatchHolderOf, dispatchHoldPhrase, dispatchedLive } from "../../lib/dispatchHold.ts";
import type { Notify } from "../../lib/notify.ts";
import { dispatchedMeta, dispatchedOrder, dispatchedWord } from "./dispatchedRows.ts";
import { DispatchHoldKey } from "./DispatchHoldKey.tsx";

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
  task,
  allTasks,
  dispatched,
  openId,
  onOpen,
  onOpenTask,
  onTaskUpdated,
  notify,
}: {
  /** 派活的这一条（这一格挂在它的详情页上）。 */
  task: Pick<TaskListItem, "id" | "dispatchHoldAt" | "dispatchHoldPendingAt">;
  allTasks: readonly TaskListItem[];
  dispatched: readonly TaskListItem[];
  /** 此刻在左边抽屉里开着的那一条。 */
  openId: string | null;
  onOpen: (taskId: string) => void;
  onOpenTask: (taskId: string) => void;
  onTaskUpdated: (task: Task) => void;
  notify: Notify;
}) {
  const ticking = anyTicking(dispatched);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, [ticking]);
  const order = dispatchedOrder(dispatched);
  // 这一条自己被更上面的按住了：停 / 续得去那一条，这里只说是谁、能点过去，不出自己那颗键。
  const byId = useMemo(() => new Map(allTasks.map((item) => [item.id, item] as const)), [allTasks]);
  const holder = dispatchHolderOf(task.id, byId);
  const live = useMemo(() => dispatchedLive(allTasks, task.id), [allTasks, task.id]);
  const head = [`${dispatched.length} 个`, order, task.dispatchHoldAt ? (task.dispatchHoldPendingAt ? "正在停下" : "已全部停下") : null].filter(Boolean).join(" · ");
  return (
    <div className={`dispatched-pane${task.dispatchHoldAt ? " is-held" : ""}`}>
      {!holder && <DispatchHoldKey task={task} live={live} onTaskUpdated={onTaskUpdated} notify={notify} />}
      <p className="dispatched-head">
        <span>{head}</span>
        {holder && (
          <button type="button" className="dispatched-head__holder" onClick={() => onOpenTask(holder.id)}>
            {dispatchHoldPhrase(holder)}
          </button>
        )}
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
