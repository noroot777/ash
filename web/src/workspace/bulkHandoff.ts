import type { TaskListItem } from "@ash/shared";
import type { TaskScopedHandoffPreflightResult } from "../lib/api.ts";

export type BulkHandoffSkip = {
  task: TaskListItem;
  reason: string;
};

export function bulkPreflightIssue(
  task: TaskListItem,
  probe: TaskScopedHandoffPreflightResult,
  projectId: string,
): string | null {
  const projectAvailable = projectId
    ? probe.projects.some((candidate) => candidate.id === projectId)
    : probe.projects.length > 0;
  if (projectAvailable) return null;

  const status = probe.peer?.peerStatus;
  const downgradedReturn = task.handoff?.direction === "in" && !probe.taskScopedReturn;
  if (status === "pending") {
    return downgradedReturn
      ? "原机没有可用的任务存档，已降级为普通接力；请先在原机批准本机，再重新检查"
      : "目标机尚未批准本机，请先接受接力申请再重新检查";
  }
  if (status === "blocked") {
    return downgradedReturn
      ? "原机没有可用的任务存档，已降级为普通接力；原机当前拒绝本机，请先修改接力来源状态"
      : "目标机已拒绝本机，请先修改接力来源状态";
  }
  return probe.projects.length === 0
    ? "目标机没有可用项目，请先在目标机添加项目"
    : "目标项目已不可用，请重新选择";
}

export function bulkPreflightAllowsRun(successCount: number, failureCount: number, total: number): boolean {
  return successCount > 0 && successCount + failureCount === total;
}

export function bulkTargetProjectId(
  task: TaskListItem,
  probe: TaskScopedHandoffPreflightResult,
  selectedProjectId: string,
): string {
  if (task.handoff?.direction === "in" && probe.taskScopedReturn) {
    return probe.projects[0]?.id ?? "";
  }
  return selectedProjectId;
}

const normalizedTargetUrl = (url: string): string => url.trim().replace(/\/+$/, "");
const sameFingerprint = (left?: string | null, right?: string | null): boolean =>
  Boolean(left && right && left.toLowerCase() === right.toLowerCase());

export function bulkTaskReturnsToTarget(
  task: TaskListItem,
  targetFingerprint: string | null | undefined,
  targetUrl: string,
): boolean {
  if (task.handoff?.direction !== "in" || !task.handoff.peerFp) return false;
  if (targetFingerprint) return sameFingerprint(task.handoff.peerFp, targetFingerprint);

  // 未做过整机配对时设置项没有 peerFp，只把地址相同的接入任务送进正式预检。
  // 真正的免审批授权仍由来源机按任务 marker 里的 peerFp 核验，地址相同不能绕过服务端身份校验。
  if (!task.handoff.peerUrl) return false;
  return normalizedTargetUrl(task.handoff.peerUrl) === normalizedTargetUrl(targetUrl);
}

export function outboundTasksForTarget<T extends TaskListItem>(
  tasks: T[],
  projectId: string,
  targetUrl: string,
  targetFingerprint?: string | null,
): T[] {
  const normalized = normalizedTargetUrl(targetUrl);
  return tasks
    .filter((task) => task.projectId === projectId
      && task.parentId === null
      && !task.archived
      && task.handoff?.direction === "out"
      && !task.handoff.pending
      && Boolean(task.handoff.peerUrl)
      // 非原机把任务安全移回原机后，本地 out 行只是历史存档；原机上的任务标记为
      // returned，不再提供远程代理。把这类存档列进侧栏只会得到 401/409。
      && !sameFingerprint(task.handoff.peerFp, task.handoff.originFp)
      && (targetFingerprint && task.handoff.peerFp
        ? task.handoff.peerFp === targetFingerprint
        : normalizedTargetUrl(task.handoff.peerUrl!) === normalized))
    .sort((a, b) => (b.handoff?.at ?? b.updatedAt).localeCompare(a.handoff?.at ?? a.updatedAt));
}

export function partitionBulkHandoffTasks<T extends TaskListItem>(
  tasks: T[],
  projectId: string,
  targetFingerprint?: string | null,
  targetUrl = "",
): { eligible: T[]; skipped: BulkHandoffSkip[] } {
  const eligible: T[] = [];
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
      && !bulkTaskReturnsToTarget(task, targetFingerprint, targetUrl)) {
      reason = "任务记录的来源机与当前所选主机不一致";
    }

    if (reason) skipped.push({ task, reason });
    else eligible.push(task);
  }

  return { eligible, skipped };
}
