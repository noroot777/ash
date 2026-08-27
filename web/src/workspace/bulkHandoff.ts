import type { TaskListItem } from "@ash/shared";
import type { TaskScopedHandoffPreflightResult } from "../lib/api.ts";

export type BulkHandoffSkip = {
  task: TaskListItem;
  reason: string;
};

// 与「正式接力会先停止它们」的警告同一套判据：只有这两种状态的任务真的占着执行槽。
export const isLiveBulkTask = (task: TaskListItem): boolean =>
  task.status === "running" || task.status === "queued";

export function bulkPreflightIssue(
  probe: TaskScopedHandoffPreflightResult,
  projectId: string,
): string | null {
  const projectAvailable = projectId
    ? probe.projects.some((candidate) => candidate.id === projectId)
    : probe.projects.length > 0;
  if (projectAvailable) return null;

  const status = probe.peer?.peerStatus;
  if (status === "pending") {
    return "目标机尚未批准本机，请先接受接力申请再重新检查";
  }
  if (status === "blocked") {
    return "目标机已拒绝本机，请先修改接力来源状态";
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

const normalizedTargetUrl = (raw: string): string => {
  const trimmed = raw.trim().replace(/\/+$/, "").replace(/\/api$/, "");
  try {
    const url = new URL(trimmed);
    const rawHost = url.hostname.toLowerCase();
    const host = rawHost === "localhost" || rawHost === "127.0.0.1"
      || rawHost === "[::1]" || rawHost === "::1" ? "loopback" : rawHost;
    const port = url.port || (url.protocol === "https:" ? "443" : "80");
    return `${url.protocol}//${host}:${port}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return trimmed;
  }
};
export const bulkTargetAddressHintMatches = (left: string, right: string): boolean =>
  normalizedTargetUrl(left) === normalizedTargetUrl(right);

const shortFingerprint = (fingerprint: string): string =>
  (fingerprint.slice(0, 20).toUpperCase().match(/.{1,4}/g) ?? []).join("-");

export function bulkIdentityMismatchWarning(
  expectedFingerprints: (string | null | undefined)[],
  actualFingerprint: string,
): string {
  const expected = [...new Set(expectedFingerprints.filter((item): item is string => Boolean(item)))]
    .map(shortFingerprint);
  const remembered = expected.length === 1
    ? expected[0]
    : expected.length > 1 ? expected.join("、") : "未知";
  return `目标机的身份和上次不一样：接入任务记住的是 ${remembered}，这次是 ${shortFingerprint(actualFingerprint)}。`
    + "可能是来源机重装过，也可能是这个地址现在指向了别的机器。不要向它发送接力申请；请先核对对端设置页指纹。";
}

export function bulkIdentityUnavailableWarning(): string {
  return "未能核对目标机身份（可能离线、地址不可达或版本过旧）。以下移回任务仅按本机保存的地址推断；"
    + "正式移回仍会再次校验指纹。请恢复连接并先核对来源机设置页指纹。";
}

const sameFingerprint = (left?: string | null, right?: string | null): boolean =>
  Boolean(left && right && left.toLowerCase() === right.toLowerCase());

export function bulkTaskReturnsToTarget(
  task: TaskListItem,
  targetFingerprint: string | null | undefined,
): boolean {
  return task.handoff?.direction === "in"
    && sameFingerprint(task.handoff.peerFp, targetFingerprint);
}

const bulkTaskBaseReason = (task: TaskListItem): { reason: string } | null => {
  // 先划候选池：批量接力搬的是「此刻还在跑的活」，不是项目搬家。已经收工的任务留在
  // 本机就行；真要单独搬某一条历史任务，走任务详情里的单任务接力。
  if (!isLiveBulkTask(task)) return { reason: "没有在运行，批量接力只移动正在跑的任务" };
  if (task.mode !== "single") return { reason: "目前只支持单飞任务" };
  if (task.queueId != null) return { reason: "仍在任务队列中" };
  if (task.verifyRound != null) return { reason: "验证轮尚未结束" };
  if (task.handoff?.direction === "out" && task.handoff.pending) {
    return { reason: "上次接力仍待确认，需单独收口" };
  }
  if (task.handoff?.direction === "out") return { reason: "已经接力出去" };
  return null;
};

export function bulkReturnCandidates<T extends TaskListItem>(tasks: T[], projectId: string): T[] {
  return tasks.filter((task) => task.projectId === projectId
    && task.parentId === null
    && !task.archived
    && !bulkTaskBaseReason(task)
    && task.handoff?.direction === "in"
    && Boolean(task.handoff.peerFp));
}

export function resolveBulkTargetIdentity<T extends TaskListItem>(
  candidates: T[],
  targetUrl: string,
  actualFingerprint: string,
): { returnFingerprint: string | null; mismatchExpectedFingerprints: string[] } {
  if (candidates.some((task) => sameFingerprint(task.handoff?.peerFp, actualFingerprint))) {
    // 地址可能换了写法（LAN IP / 主机名），在线时仍以真实身份认出原来源机。
    return { returnFingerprint: actualFingerprint, mismatchExpectedFingerprints: [] };
  }
  const expectedAtAddress = candidates
    .filter((task) => task.handoff?.peerUrl
      && bulkTargetAddressHintMatches(task.handoff.peerUrl, targetUrl))
    .flatMap((task) => task.handoff?.peerFp ? [task.handoff.peerFp] : []);
  if (expectedAtAddress.length === 0) {
    // 目标地址从未声称是这些接入任务的来源：这是正常的新出站目标，不是换机。
    return { returnFingerprint: null, mismatchExpectedFingerprints: [] };
  }
  return {
    returnFingerprint: null,
    mismatchExpectedFingerprints: [...new Set(expectedAtAddress)],
  };
}

export function groupBulkHandoffFailures<T extends TaskListItem>(
  failures: { task: T; reason: string }[],
): { reason: string; tasks: T[] }[] {
  const grouped = new Map<string, T[]>();
  for (const failure of failures) {
    const rows = grouped.get(failure.reason) ?? [];
    rows.push(failure.task);
    grouped.set(failure.reason, rows);
  }
  return [...grouped].map(([reason, tasks]) => ({ reason, tasks }));
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
  returnOnly = false,
): { eligible: T[]; skipped: BulkHandoffSkip[] } {
  const eligible: T[] = [];
  const skipped: BulkHandoffSkip[] = [];
  const candidates = tasks.filter((task) => task.projectId === projectId && task.parentId === null && !task.archived
    && (task.handoff?.direction !== "out" || Boolean(task.handoff.pending)));

  for (const task of candidates) {
    let block = bulkTaskBaseReason(task);
    if (!block && returnOnly && task.handoff?.direction !== "in") {
      block = { reason: "当前目标仅授予接入任务移回权限，本地任务不会随本批次发送" };
    }
    if (!block && task.handoff?.direction === "in"
      && !bulkTaskReturnsToTarget(task, targetFingerprint)) {
      block = { reason: "未能确认任务来源机就是当前所选主机" };
    }

    if (block) skipped.push({ task, ...block });
    else eligible.push(task);
  }

  return { eligible, skipped };
}
