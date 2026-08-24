import type { Task } from "@ash/shared";

export type BulkHandoffSkip = {
  task: Task;
  reason: string;
};

export function partitionBulkHandoffTasks(
  tasks: Task[],
  projectId: string,
): { eligible: Task[]; skipped: BulkHandoffSkip[] } {
  const eligible: Task[] = [];
  const skipped: BulkHandoffSkip[] = [];
  const candidates = tasks.filter((task) => task.projectId === projectId && task.parentId === null && !task.archived);

  for (const task of candidates) {
    let reason: string | null = null;
    if (task.mode !== "single") reason = "目前只支持单飞任务";
    else if (task.queueId != null) reason = "仍在任务队列中";
    else if (task.verifyRound != null) reason = "验证轮尚未结束";
    else if (task.handoff?.direction === "out" && task.handoff.pending) reason = "上次接力仍待确认，需单独收口";
    else if (task.handoff?.direction === "out") reason = "已经接力出去";
    else if (task.handoff?.direction === "in") reason = "从别处接来的任务只能移回来源机器，不能批量转送";

    if (reason) skipped.push({ task, reason });
    else eligible.push(task);
  }

  return { eligible, skipped };
}
