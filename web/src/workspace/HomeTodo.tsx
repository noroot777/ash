// 首页输入框下面那一列「等你处理」：问你话的、摔了的、干完了还没验收的。口径和侧栏筛选条
// 「需要你处理」那一档是同一份（lib/taskAttention.ts 的 spreadBucket），这里只多给一句为什么。
// 一条都没有就整块不画。
import { useMemo } from "react";
import type { TaskListItem } from "@ash/shared";
import { TaskStatusDot } from "../components/TaskStatusDot.tsx";
import { hasFailed, indexWorkers, spreadBucket, workersFrom } from "../lib/taskAttention.ts";
import type { TaskStatusIndicator } from "../lib/useTaskReadState.ts";
import { localeDate } from "../lib/localeFormat.ts";

const SHOWN = 6;

function why(task: TaskListItem, workers: TaskListItem[]): [TaskStatusIndicator, string] {
  if (task.question) return ["attention", "等你答复"];
  if (task.status === "failed") return ["error", "失败"];
  if (hasFailed(task)) return ["error", "验证没过"];
  if (workers.some((worker) => worker.question)) return ["attention", "执行者在提问"];
  return ["unaccepted", "待验收"];
}

function ago(iso: string, now: number): string {
  const minutes = Math.floor((now - new Date(iso).getTime()) / 60_000);
  if (!Number.isFinite(minutes)) return "";
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)} 小时前`;
  return localeDate(iso, "zh-CN", { month: "numeric", day: "numeric" });
}

/** `rows` 是这一档里的顶层任务（已按作用域筛过）；`all` 用来找团队的执行者。 */
export function HomeTodo({ rows, all, onOpen }: { rows: TaskListItem[]; all: TaskListItem[]; onOpen: (task: TaskListItem) => void }) {
  const todo = useMemo(() => {
    const workers = indexWorkers(all);
    return rows
      .map((task) => ({ task, workers: workersFrom(workers, task.id) }))
      .filter(({ task, workers: own }) => spreadBucket(task, own) === "todo")
      .sort((a, b) => (b.task.updatedAt ?? "").localeCompare(a.task.updatedAt ?? ""));
  }, [all, rows]);
  if (!todo.length) return null;
  const now = Date.now();
  return (
    <section className="home-todo" aria-label="等你处理">
      <h2>等你处理<b>{todo.length}</b></h2>
      <ul>
        {todo.slice(0, SHOWN).map(({ task, workers }) => {
          const [indicator, reason] = why(task, workers);
          return (
            <li key={task.id}>
              <button type="button" onClick={() => onOpen(task)}>
                <TaskStatusDot indicator={indicator} surface="workspace" />
                <span className="home-todo-title">{task.title || "未命名任务"}</span>
                <span className="home-todo-why">{reason}</span>
                <span className="home-todo-when">{task.updatedAt ? ago(task.updatedAt, now) : ""}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {todo.length > SHOWN && <p className="home-todo-more">还有 {todo.length - SHOWN} 条，在侧栏筛选「需要你处理」里看全部。</p>}
    </section>
  );
}
