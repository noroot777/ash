import { SpinnerGap } from "@phosphor-icons/react";
import type { TaskListItem } from "@ash/shared";
import type { TaskScopedHandoffPreflightResult } from "../lib/api.ts";

// 一行任务要带走什么，用短事实说清楚：这是弹窗里唯一值得用户逐条读的信息。
export function bulkTaskFacts(probe: TaskScopedHandoffPreflightResult): string[] {
  const facts: string[] = [];
  if (probe.local.sessions > 0) {
    const missing = probe.local.sessions - probe.local.sessionFilesFound;
    facts.push(missing > 0
      ? `会话 ${probe.local.sessions} 个（缺 ${missing} 份，对端全新起跑）`
      : `会话 ${probe.local.sessions} 个`);
  }
  if (probe.local.git === "bundle") facts.push("带 Git 分支/改动");
  if (probe.local.uploads > 0) facts.push(`附件 ${probe.local.uploads} 个`);
  if (probe.local.pendingMessages > 0) facts.push(`待发消息 ${probe.local.pendingMessages} 条`);
  if (probe.local.schedule) facts.push("带定时计划");
  return facts;
}

// 就是一个默认展开的普通折叠列表：一行 summary，下面每条任务一行标题加一行小字。
export function BulkHandoffTaskList({
  tasks,
  preflights,
  failures,
  activeTaskId,
  transferring,
  actionName,
  targetName,
}: {
  tasks: TaskListItem[];
  preflights: Map<string, TaskScopedHandoffPreflightResult>;
  failures: { task: TaskListItem; reason: string }[];
  activeTaskId: string | null;
  transferring: boolean;
  actionName: string;
  targetName: string;
}) {
  const failureByTask = new Map(failures.map((failure) => [failure.task.id, failure.reason]));
  return (
    <details className="handoff-bulk-list" open>
      <summary>{actionName} {tasks.length} 个正在跑的任务，先在本机停止，到 {targetName} 接着跑</summary>
      <ul>
        {tasks.map((task) => {
          const failure = failureByTask.get(task.id);
          const probe = preflights.get(task.id);
          const active = activeTaskId === task.id;
          return (
            <li key={task.id} className={failure ? "is-failed" : ""}>
              <b>{task.title || "未命名任务"}</b>
              <span>
                {active && <SpinnerGap size={11} className="is-spinning" aria-hidden="true" />}
                {failure
                  ?? (active
                    ? `正在${transferring ? actionName : "检查"}…`
                    : probe
                      ? bulkTaskFacts(probe).join(" · ") || "无附加数据"
                      : "待检查")}
              </span>
            </li>
          );
        })}
      </ul>
    </details>
  );
}
