/**
 * 走到设置页「审查者」那一节。派审对话框从三处打开（回复框、审查格、任务头），都不经过
 * WorkspaceShell 的 openSettings，所以跟 Git 工作台的入口（git-workbench/navigation.ts）一样
 * 走地址栏：推一条历史再发一次 popstate，WorkspaceShell 按地址把设置页摆出来。任务参数留着，
 * 浏览器后退就回到刚才那个任务。
 */
export function openReviewerSettings(): void {
  const url = new URL(window.location.href);
  url.searchParams.set("view", "settings");
  url.searchParams.set("settings", "reviewers");
  window.history.pushState(null, "", url.pathname + url.search);
  window.dispatchEvent(new PopStateEvent("popstate"));
}
