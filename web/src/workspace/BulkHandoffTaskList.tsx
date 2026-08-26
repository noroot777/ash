import { CheckCircle, SpinnerGap, WarningCircle } from "@phosphor-icons/react";
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
    <section className="handoff-bulk-picks" aria-label={`将${actionName}的任务`}>
      <header>
        <b>{tasks.length} 个正在跑的任务</b>
        <span>先在本机停止，到 {targetName} 接着跑</span>
      </header>
      <ul>
        {tasks.map((task) => {
          const failure = failureByTask.get(task.id);
          const probe = preflights.get(task.id);
          const active = activeTaskId === task.id;
          return (
            <li key={task.id} className={failure ? "is-failed" : active ? "is-active" : ""}>
              <i className="handoff-bulk-pick-dot" aria-hidden="true" />
              <span className="handoff-bulk-pick-title">{task.title || "未命名任务"}</span>
              <span className="handoff-bulk-pick-state">
                {failure ? (
                  <>
                    <WarningCircle size={13} weight="fill" aria-hidden="true" />
                    <span>{failure}</span>
                  </>
                ) : active ? (
                  <>
                    <SpinnerGap size={13} className="is-spinning" aria-hidden="true" />
                    <span>{transferring ? `正在${actionName}…` : "正在检查…"}</span>
                  </>
                ) : probe ? (
                  <>
                    <CheckCircle size={13} weight="fill" aria-hidden="true" />
                    <span>{bulkTaskFacts(probe).join(" · ") || "无附加数据"}</span>
                  </>
                ) : (
                  <span className="is-muted">待检查</span>
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
