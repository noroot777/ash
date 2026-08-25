import type { TaskListItem } from "@ash/shared";

// 排序的第一原则：**更新时间倒序**，而且只有这一条。
// 从前这里把列表按状态切成八大块（运行中 / 暂停中 / … / 失败 / 已取消），
// 时间序只在块内生效，于是刚炸的任务被扔到列表最末，找它得一路滚到底。
// 现在不按状态提升任何一档 —— 失败、待验收这些靠行首圆点的颜色认，不靠位置。
// 置顶（pinnedAt）是唯一的例外，那是用户手动摁下去的。

export type TaskTreeSectionKey = "pinned" | "rest";

export type TaskTreeSection<T extends TaskListItem = TaskListItem> = {
  key: TaskTreeSectionKey;
  label: string;
  count: number;
  tasks: T[];
};

export type TaskTreeOptions = {
  // true = 置顶单独成节（主工作区）；false = 不分节，置顶仍排在最前（其他项目的折叠列表）。
  unifiedPinned?: boolean;
};

export type TaskPreview<T extends TaskListItem = TaskListItem> = {
  visible: T[];
  hidden: T[];
};

export const TASK_PREVIEW_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function visibleOnThisMachine(task: TaskListItem): boolean {
  return task.handoff?.direction !== "out" || Boolean(task.handoff.pending);
}

function byUpdatedDesc(a: TaskListItem, b: TaskListItem): number {
  return b.updatedAt.localeCompare(a.updatedAt);
}

function sortByUpdated<T extends TaskListItem>(tasks: T[]): T[] {
  return [...tasks].sort(byUpdatedDesc);
}

// 置顶区按用户置顶的先后，同刻再落回更新时间。
function sortPinned<T extends TaskListItem>(tasks: T[]): T[] {
  return [...tasks].sort((a, b) => (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0) || byUpdatedDesc(a, b));
}

// keepVisible 命中的行**永不因为旧而被藏**（星标、待你验收的）——
// 用户给的软记号和没盖的章都属于「我要一直看得见」，24 小时的年龄闸对它们不适用。
export function previewTasksByAge<T extends TaskListItem>(
  tasks: T[],
  nowMs = Date.now(),
  keepVisible?: (task: TaskListItem) => boolean,
): TaskPreview<T> {
  const cutoff = nowMs - TASK_PREVIEW_MAX_AGE_MS;
  const visible: T[] = [];
  const hidden: T[] = [];
  for (const task of tasks) {
    const updatedAt = Date.parse(task.updatedAt);
    const stale = Number.isFinite(updatedAt) && updatedAt < cutoff && !keepVisible?.(task);
    (stale ? hidden : visible).push(task);
  }
  if (visible.length > 0 || hidden.length === 0) return { visible, hidden };

  const latest = hidden.reduce((candidate, task) => (
    Date.parse(task.updatedAt) > Date.parse(candidate.updatedAt) ? task : candidate
  ));
  return {
    visible: [latest],
    hidden: hidden.filter((task) => task.id !== latest.id),
  };
}

// 选中被预览藏住的任务时，只自动展开一次。同一条选中项上用户点了收起，
// 不能再拿「它还在 hidden 里」把列表顶开 —— 否则收起按钮看起来是坏的。
export function advanceHiddenReveal(lastKey: string | null, revealKey: string | null): { lastKey: string | null; reveal: boolean } {
  if (!revealKey) return { lastKey: null, reveal: false };
  if (lastKey === revealKey) return { lastKey, reveal: false };
  return { lastKey: revealKey, reveal: true };
}

export function buildTaskTree<T extends TaskListItem>(tasks: T[], options: TaskTreeOptions = {}): TaskTreeSection<T>[] {
  const topLevel = tasks.filter((task) => task.parentId === null && !task.archived && visibleOnThisMachine(task));
  const pinned = sortPinned(topLevel.filter((task) => task.pinnedAt != null));
  const rest = sortByUpdated(topLevel.filter((task) => task.pinnedAt == null));

  // 不分节时（其他项目那种折叠列表）只出一节，置顶仍排在最前。
  if (!options.unifiedPinned) {
    const all = [...pinned, ...rest];
    return all.length ? [{ key: "rest" as const, label: "任务", count: all.length, tasks: all }] : [];
  }

  return ([
    { key: "pinned", label: "置顶", tasks: pinned },
    { key: "rest", label: "任务", tasks: rest },
  ] as const)
    .filter((section) => section.tasks.length > 0)
    .map((section) => ({ key: section.key, label: section.label, count: section.tasks.length, tasks: section.tasks }));
}

export function orderedTopLevelTasks<T extends TaskListItem>(tasks: T[], options: TaskTreeOptions = {}): T[] {
  return buildTaskTree(tasks, options).flatMap((section) => section.tasks);
}
