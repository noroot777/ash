import type { Task } from "@ash/shared";

export type BulkHandoffSkip = {
  task: Task;
  reason: string;
};

const normalizedTargetUrl = (url: string): string => url.trim().replace(/\/+$/, "");

export function outboundTasksForTarget(
  tasks: Task[],
  projectId: string,
  targetUrl: string,
  targetFingerprint?: string | null,
): Task[] {
  const normalized = normalizedTargetUrl(targetUrl);
  return tasks
    .filter((task) => task.projectId === projectId
      && task.parentId === null
      && !task.archived
      && task.handoff?.direction === "out"
      && !task.handoff.pending
      && Boolean(task.handoff.peerUrl)
      && (targetFingerprint && task.handoff.peerFp
        ? task.handoff.peerFp === targetFingerprint
        : normalizedTargetUrl(task.handoff.peerUrl!) === normalized))
    .sort((a, b) => (b.handoff?.at ?? b.updatedAt).localeCompare(a.handoff?.at ?? a.updatedAt));
}

export function partitionBulkHandoffTasks(
  tasks: Task[],
  projectId: string,
  targetFingerprint?: string | null,
): { eligible: Task[]; skipped: BulkHandoffSkip[] } {
  const eligible: Task[] = [];
  const skipped: BulkHandoffSkip[] = [];
  const candidates = tasks.filter((task) => task.projectId === projectId && task.parentId === null && !task.archived
    && (task.handoff?.direction !== "out" || Boolean(task.handoff.pending)));

  for (const task of candidates) {
    let reason: string | null = null;
    if (task.mode !== "single") reason = "目前只支持单飞任务";
    else if (task.queueId != null) reason = "仍在任务队列中";
    else if (task.verifyRound != null) reason = "验证轮尚未结束";
    else if (task.handoff?.direction === "out" && task.handoff.pending) reason = "上次接力仍待确认，需单独收口";
    else if (task.handoff?.direction === "out") reason = "已经接力出去";
    else if (task.handoff?.direction === "in"
      && (!task.handoff.peerFp || !targetFingerprint || task.handoff.peerFp !== targetFingerprint)) {
      reason = "从别处接来的任务只能移回来源机器，当前所选主机不是来源机";
    }

    if (reason) skipped.push({ task, reason });
    else eligible.push(task);
  }

  return { eligible, skipped };
}
