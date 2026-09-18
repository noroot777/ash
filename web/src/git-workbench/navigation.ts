import type { GitView } from "@ash/shared/git-workbench";

export interface GitLocation {
  projectId: string;
  view?: GitView;
  root?: string;
  taskId?: string;
  ref?: string;
  /** 指定要打开的那一条提交（完整 sha）。历史视图会选中它并把它滚进视野。 */
  commit?: string;
}
export const GIT_VIEWS: GitView[] = [
  "changes",
  "history",
  "branches",
  "stash",
  "tags",
  "worktrees",
  "log",
];
export function gitWorkbenchUrl(location: GitLocation): string {
  const url = new URL(window.location.href);
  const taskId =
    location.taskId ||
    (location.root &&
    location.root === url.searchParams.get("gitRoot") &&
    location.projectId === url.searchParams.get("project")
      ? url.searchParams.get("gitTask")
      : null);
  url.search = new URLSearchParams({
    project: location.projectId,
    view: "git",
    gitView: location.view || "changes",
    ...(location.root ? { gitRoot: location.root } : {}),
    ...(taskId ? { gitTask: taskId } : {}),
    ...(location.ref ? { gitRef: location.ref } : {}),
    ...(location.commit ? { gitCommit: location.commit } : {}),
  }).toString();
  return url.pathname + url.search;
}
export function openGitWorkbench(location: GitLocation): void {
  window.history.pushState(null, "", gitWorkbenchUrl(location));
  window.dispatchEvent(new PopStateEvent("popstate"));
}
export function readGitLocation(): Omit<GitLocation, "projectId"> {
  const params = new URLSearchParams(window.location.search);
  return {
    view: GIT_VIEWS.find((view) => view === params.get("gitView")) || "changes",
    root: params.get("gitRoot") || undefined,
    taskId: params.get("gitTask") || undefined,
    ref: params.get("gitRef") || undefined,
    commit: params.get("gitCommit") || undefined,
  };
}
