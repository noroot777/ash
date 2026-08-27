import type { Task, TaskHandoff } from "@ash/shared";
import type { TaskScopeKind } from "./taskScope.ts";

type TaskSelection = Pick<Task, "id" | "projectId">;

type BrowserNavigation = {
  history: Pick<History, "pushState">;
  location: Pick<Location, "pathname" | "search">;
};

// 作用域要一起写进 URL：在「任务模式」里点开一行也压一条历史，回退时 URL 上没有 scope=tasks
// 的话会被读成单项目态 —— 按一下后退，列表悄悄从「任务模式」缩回一家，这不是后退该做的事。
export function taskSelectionUrl(task: TaskSelection, pathname: string, scope: TaskScopeKind = "project"): string {
  const params = new URLSearchParams();
  if (scope === "tasks") params.set("scope", "tasks");
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
  // 领取 key / 加入项目的链接是**真实路径**,由 AuthGate 自己认。归一化会把它们
  // 一律改写成 "/",于是用户点开邮件里那条链接只会看到一个普通工作台。
  if (/^\/(claim|join)\//.test(pathname)) return null;
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
  scope: TaskScopeKind = "project",
): boolean {
  const nextUrl = taskSelectionUrl(task, browser.location.pathname, scope);
  if (`${browser.location.pathname}${browser.location.search}` === nextUrl) return false;
  browser.history.pushState(null, "", nextUrl);
  return true;
}
