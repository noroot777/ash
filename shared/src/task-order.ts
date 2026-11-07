import type { TaskListItem } from "./index.ts";

// 任务列表的先后（网页侧栏、飞书 /tasks 共用这一份，两边排出来必须一样）。
//
// 排序的第一原则：**更新时间倒序**，而且只有这一条。
// 从前侧栏把列表按状态切成八大块（运行中 / 暂停中 / … / 失败 / 已取消），
// 时间序只在块内生效，于是刚炸的任务被扔到列表最末，找它得一路滚到底。
// 现在不按状态提升任何一档 —— 失败、待验收这些靠行首圆点的颜色认，不靠位置。
// 置顶（pinnedAt）是唯一的例外，那是用户手动摁下去的。

type Orderable = Pick<TaskListItem, "updatedAt" | "pinnedAt" | "parentId" | "archived" | "handoff">;

/** 接力出去的任务归另一台机器（还在等对面接手的除外）。 */
export function visibleOnThisMachine(task: Pick<TaskListItem, "handoff">): boolean {
  return task.handoff?.direction !== "out" || Boolean(task.handoff.pending);
}

export function byUpdatedDesc(a: Pick<TaskListItem, "updatedAt">, b: Pick<TaskListItem, "updatedAt">): number {
  return b.updatedAt.localeCompare(a.updatedAt);
}

export function sortByUpdated<T extends Pick<TaskListItem, "updatedAt">>(tasks: T[]): T[] {
  return [...tasks].sort(byUpdatedDesc);
}

// 置顶区按用户置顶的先后，同刻再落回更新时间。
export function sortPinned<T extends Pick<TaskListItem, "updatedAt" | "pinnedAt">>(tasks: T[]): T[] {
  return [...tasks].sort((a, b) => (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0) || byUpdatedDesc(a, b));
}

/** 列表里出现的那些行（团队执行者挂在调度台下面、不单独成行；归档的不在列表里）。 */
export function isListedTopLevel(task: Orderable, includeElsewhere = false): boolean {
  return task.parentId === null && !task.archived && (includeElsewhere || visibleOnThisMachine(task));
}

/** 一个项目的任务列表从上到下：置顶的在前，其余按更新时间倒序。 */
export function orderedListTasks<T extends Orderable>(tasks: T[]): T[] {
  const listed = tasks.filter((task) => isListedTopLevel(task));
  return [
    ...sortPinned(listed.filter((task) => task.pinnedAt != null)),
    ...sortByUpdated(listed.filter((task) => task.pinnedAt == null)),
  ];
}
