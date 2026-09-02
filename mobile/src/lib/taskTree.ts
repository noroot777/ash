// 任务列表的**排序与折叠**。规则与 web 的 `web/src/workspace/taskTreeModel.ts` 一一对应，
// 逐条搬过来（没往 shared 放：worktree 下 shared 的软链解析有坑，而这套规则只有两个前端
// 用得上）。改这里的任何一条，去那边同步。
//
// 排序的第一原则：**更新时间倒序，而且只有这一条**。
// 从前 web 把列表按状态切成八大块（运行中 / 暂停中 / … / 失败 / 已取消），时间序只在块内
// 生效，于是刚炸的任务被扔到列表最末，找它得一路滚到底。现在不按状态提升任何一档 ——
// 失败、待验收、等你答复这些靠行内的颜色和标识认（见 TaskStatusChips），不靠位置。
// 置顶（pinnedAt）是唯一的例外，那是用户手动摁下去的。
import { isAcceptedStage, type TaskListItem } from "@ash/shared";
import { isTeamSettled, teamNeverStarted, workersOf } from "@ash/shared/team";

export const TASK_PREVIEW_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export type TaskTreeSectionKey = "pinned" | "rest";
export type TaskTreeSection = {
  key: TaskTreeSectionKey;
  label: string;
  tasks: TaskListItem[];
};

export type TaskPreview = {
  visible: TaskListItem[];
  hidden: TaskListItem[];
};

/** 接力出去的任务在本机是历史存档，列表里不留行（还没确认送达的除外）。 */
export function visibleOnThisMachine(task: TaskListItem): boolean {
  return task.handoff?.direction !== "out" || Boolean(task.handoff.pending);
}

function byUpdatedDesc(a: TaskListItem, b: TaskListItem): number {
  return b.updatedAt.localeCompare(a.updatedAt);
}

export function sortByUpdated<T extends TaskListItem>(tasks: T[]): T[] {
  return [...tasks].sort(byUpdatedDesc);
}

// 置顶区按用户置顶的先后，同刻再落回更新时间。
function sortPinned<T extends TaskListItem>(tasks: T[]): T[] {
  return [...tasks].sort((a, b) => (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0) || byUpdatedDesc(a, b));
}

/** 不分节的排法（分组视图那种）：置顶仍排最前，其余更新时间倒序。 */
export function sortForList<T extends TaskListItem>(tasks: T[]): T[] {
  return [
    ...sortPinned(tasks.filter((task) => task.pinnedAt != null)),
    ...sortByUpdated(tasks.filter((task) => task.pinnedAt == null)),
  ];
}

/** 顶层活跃任务分成「置顶 / 任务」两节；空节不出现。执行者与归档不在其中。 */
export function buildTaskTree(tasks: TaskListItem[]): TaskTreeSection[] {
  const topLevel = tasks.filter(
    (task) => task.parentId === null && !task.archived && visibleOnThisMachine(task),
  );
  const sections: TaskTreeSection[] = [
    { key: "pinned", label: "置顶", tasks: sortPinned(topLevel.filter((task) => task.pinnedAt != null)) },
    { key: "rest", label: "任务", tasks: sortByUpdated(topLevel.filter((task) => task.pinnedAt == null)) },
  ];
  return sections.filter((section) => section.tasks.length > 0);
}

/**
 * 24 小时没更新的收进折叠区。keepVisible 命中的行**永不因为旧而被藏**（星标、置顶、
 * 等你验收的）—— 用户给的软记号和没盖的章都属于「我要一直看得见」。
 * 全都旧时至少留最新那一条露在外面，否则整节只剩一个「显示另外 N 条」。
 */
export function previewTasksByAge(
  tasks: TaskListItem[],
  nowMs: number,
  keepVisible?: (task: TaskListItem) => boolean,
): TaskPreview {
  const cutoff = nowMs - TASK_PREVIEW_MAX_AGE_MS;
  const visible: TaskListItem[] = [];
  const hidden: TaskListItem[] = [];
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

/**
 * 打开了一条被折叠藏住的任务时，只自动展开一次。同一条上用户点了收起，不能再拿
 * 「它还在 hidden 里」把列表顶开 —— 否则收起按钮看起来是坏的。
 */
export function advanceHiddenReveal(
  lastKey: string | null,
  revealKey: string | null,
): { lastKey: string | null; reveal: boolean } {
  if (!revealKey) return { lastKey: null, reveal: false };
  if (lastKey === revealKey) return { lastKey, reveal: false };
  return { lastKey: revealKey, reveal: true };
}

// 「干完了但我还没盖章」。stage 多数时候是 null —— 只有走过 report_stage 的任务才有值，
// null 一律算**没验收**：用户要的是「凡是我没点过验收的都得看得见」。团队的「干完了」
// 写在执行者身上（调度台自己没有 done 终态），所以要连执行者一起判。
function awaitsAcceptance(task: TaskListItem, allTasks: TaskListItem[]): boolean {
  if (isAcceptedStage(task.stage)) return false;
  if (task.stage === "awaiting_acceptance") return true;
  if (task.mode === "team" && !task.parentId) {
    if (teamNeverStarted(task.status)) return false;
    return isTeamSettled(task.status === "running", workersOf(allTasks, task.id));
  }
  return task.status === "done";
}

/**
 * 年龄闸的豁免名单。判据与 web 的 keepVisible 同源：星标、置顶、等你验收的行永不因旧
 * 被藏起来 —— 一个是用户手动按的记号，一个是没盖的章，都属于「我要一直看得见」。
 */
export function keepVisibleFor(allTasks: TaskListItem[]): (task: TaskListItem) => boolean {
  return (task) =>
    task.starredAt != null || task.pinnedAt != null || awaitsAcceptance(task, allTasks);
}
