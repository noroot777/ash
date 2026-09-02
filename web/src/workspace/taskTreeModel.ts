import type { TaskListItem } from "@ash/shared";
import { hasFailed } from "../lib/taskAttention.ts";
import type { TaskStatusIndicator } from "../lib/useTaskReadState.ts";

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
  // true = 接力出去的行也留在树里（任务模式）。默认摘掉：单项目态下它们归下方
  // 「其他机器」那一节，留在主列表里就是同一条任务在侧栏出现两次。
  includeElsewhere?: boolean;
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

// 24 小时年龄闸的豁免名单：哪些行**永不因为旧而被折叠**。
//
// 四类，理由是同一句话「我要一直看得见」的四种形状 —— 用户手动摁下的记号（星标、置顶）、
// 没盖的章（unaccepted）、以及坏在半路的活（失败 / 验证没过）。
//
// 失败这一档不能靠行首那颗点来认：它走 "error"，而 error 只在**未读**时才亮
// （见 useTaskReadState），点开看过一眼就熄了。跟着点走的话，失败的任务只在头 24 小时
// 露个面，之后缩进「显示更多」—— 而失败恰恰是越老越该被人看见的一档。
//
// 判据放在这里而不是留在组件里，是为了跟 previewTasksByAge 挨着、并且能被测试直接钉住：
// 它决定的是「列表里到底看得见谁」，跟 keepVisible 的调用点分开写迟早会漂。
export function keepVisibleInPreview(
  task: Pick<TaskListItem, "starredAt" | "pinnedAt" | "status" | "stage">,
  indicator: TaskStatusIndicator | null,
): boolean {
  return task.starredAt != null
    || task.pinnedAt != null
    || hasFailed(task)
    || indicator === "unaccepted";
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
  const topLevel = tasks.filter((task) => task.parentId === null && !task.archived
    && (options.includeElsewhere || visibleOnThisMachine(task)));
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

export type TaskProjectGroup<T extends TaskListItem = TaskListItem> = {
  projectId: string;
  tasks: T[];
};

// 任务模式下「任务」那一节再按项目分一层。
//
// 项目的先后**跟着行走**：喂进来的 tasks 已经是更新时间倒序，所以谁的最新一条更近，
// 谁就排在最前。按名字或创建时间排会把最活跃的那家沉到底下，而这个列表存在的意义
// 就是「现在谁在动」—— 排序原则跟行一样只认更新时间，不为分组另立一套。
export function groupTasksByProject<T extends TaskListItem>(tasks: T[]): TaskProjectGroup<T>[] {
  const groups = new Map<string, T[]>();
  for (const task of tasks) {
    const bucket = groups.get(task.projectId);
    if (bucket) bucket.push(task);
    else groups.set(task.projectId, [task]);
  }
  return [...groups].map(([projectId, rows]) => ({ projectId, tasks: rows }));
}
