import type { Task, TaskHandoff } from "@ash/shared";

type TaskSelection = Pick<Task, "id" | "projectId">;

type BrowserNavigation = {
  history: Pick<History, "pushState">;
  location: Pick<Location, "pathname" | "search">;
};

export function taskSelectionUrl(task: TaskSelection, pathname: string): string {
  const params = new URLSearchParams();
  params.set("project", task.projectId);
  params.set("task", task.id);
  return `${pathname}?${params.toString()}`;
}

export function normalizedWorkspaceUrl(
  pathname: string,
  search: string,
  hash: string,
): string | null {
  if (pathname === "/") return null;
  const params = new URLSearchParams(search);
  const legacyTask = pathname.match(/^\/tasks\/([^/]+)\/?$/);
  if (legacyTask?.[1]) {
    let taskId = legacyTask[1];
    try { taskId = decodeURIComponent(taskId); } catch { /* 保留原始片段，避免畸形 URL 让应用白屏。 */ }
    params.set("task", taskId);
  }
  const query = params.toString();
  return `/${query ? `?${query}` : ""}${hash}`;
}

export function selectedTaskProjectId(
  tasks: readonly TaskSelection[],
  taskId: string | null,
): string | null {
  return taskId ? tasks.find((task) => task.id === taskId)?.projectId ?? null : null;
}

export function remoteTaskUrl(peerUrl: string, taskId: string, projectId?: string | null): string {
  const params = new URLSearchParams();
  if (projectId) params.set("project", projectId);
  params.set("task", taskId);
  return `${peerUrl.replace(/\/+$/, "")}/?${params.toString()}`;
}

export function handoffTaskHref(taskId: string, handoff: Pick<TaskHandoff,
  "peerUrl" | "peerTaskId" | "targetProjectId">): string | null {
  if (!handoff.peerUrl) return null;
  return handoff.targetProjectId
    ? remoteTaskUrl(handoff.peerUrl, handoff.peerTaskId, handoff.targetProjectId)
    : `/api/tasks/${encodeURIComponent(taskId)}/handoff/open`;
}

export function pushTaskHistoryEntry(
  task: TaskSelection,
  browser: BrowserNavigation = window,
): boolean {
  const nextUrl = taskSelectionUrl(task, browser.location.pathname);
  if (`${browser.location.pathname}${browser.location.search}` === nextUrl) return false;
  browser.history.pushState(null, "", nextUrl);
  return true;
}
