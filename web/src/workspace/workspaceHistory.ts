import type { Task } from "@ash/shared";

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

export function pushTaskHistoryEntry(
  task: TaskSelection,
  browser: BrowserNavigation = window,
): boolean {
  const nextUrl = taskSelectionUrl(task, browser.location.pathname);
  if (`${browser.location.pathname}${browser.location.search}` === nextUrl) return false;
  browser.history.pushState(null, "", nextUrl);
  return true;
}
