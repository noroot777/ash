import type { Task, TaskStatus } from "@harness/shared";

type TaskGroup = {
  key: string;
  label: string;
  matches: (task: Task) => boolean;
};

type TaskSection = {
  key: "collab" | "single";
  label: string;
  matches: (task: Task) => boolean;
  groups: readonly TaskGroup[];
};

export type TaskTreeSection = {
  key: "pinned" | TaskSection["key"];
  label: string;
  matches: (task: Task) => boolean;
  count: number;
  tasks: Task[];
};

export type TaskTreeOptions = {
  unifiedPinned?: boolean;
};

const PRIORITY_ORDER: Task["priority"][] = ["urgent", "high", "medium", "low", "none"];

const COLLAB_GROUPS: TaskGroup[] = [
  {
    key: "active",
    label: "进行中",
    matches: (task) => task.stage !== "accepted",
  },
  {
    key: "accepted",
    label: "已验收",
    matches: (task) => task.stage === "accepted",
  },
];

const STATUS_GROUPS: { key: Exclude<TaskStatus, "idle">; label: string }[] = [
  { key: "running", label: "运行中" },
  { key: "paused", label: "暂停中" },
  { key: "awaiting_review", label: "等待审核" },
  { key: "queued", label: "排队中" },
  { key: "backlog", label: "待排期" },
  { key: "done", label: "完成" },
  { key: "failed", label: "失败" },
  { key: "canceled", label: "已取消" },
];

const TASK_SECTIONS: readonly TaskSection[] = [
  {
    key: "collab",
    label: "协作任务",
    matches: (task) => task.mode === "team" || task.mode === "duet",
    groups: COLLAB_GROUPS,
  },
  {
    key: "single",
    label: "普通任务",
    matches: (task) => task.mode === "single",
    groups: [
      ...STATUS_GROUPS.map((status) => ({
        key: status.key,
        label: status.label,
        matches: (task: Task) => groupedStatus(task) === status.key,
      })),
    ],
  },
];

function groupedStatus(task: Task): TaskStatus {
  return task.mode === "team" && task.status === "idle" ? "running" : task.status;
}

function sortTasks(tasks: Task[], pinned: boolean): Task[] {
  return [...tasks].sort(
    (a, b) =>
      (pinned ? (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0) : 0) ||
      PRIORITY_ORDER.indexOf(a.priority) - PRIORITY_ORDER.indexOf(b.priority) ||
      b.createdAt.localeCompare(a.createdAt),
  );
}

export function buildTaskTree(tasks: Task[], options: TaskTreeOptions = {}): TaskTreeSection[] {
  const topLevel = tasks.filter((task) => task.parentId === null && !task.archived);
  const pinnedTasks = sortTasks(topLevel.filter((task) => task.pinnedAt != null), true);
  const sections: TaskTreeSection[] = TASK_SECTIONS.map((section) => {
    const sectionTasks = topLevel.filter(
      (task) => section.matches(task) && (!options.unifiedPinned || task.pinnedAt == null),
    );
    const ordered = [
      ...(options.unifiedPinned ? [] : sortTasks(sectionTasks.filter((task) => task.pinnedAt != null), true)),
      ...section.groups.flatMap((group) => sortTasks(
        sectionTasks.filter((task) => task.pinnedAt == null && group.matches(task)),
        false,
      )),
    ];
    return { key: section.key, label: section.label, matches: section.matches, count: sectionTasks.length, tasks: ordered };
  }).filter((section) => section.count > 0);
  if (!options.unifiedPinned || pinnedTasks.length === 0) return sections;
  return [{
    key: "pinned",
    label: "置顶",
    matches: (task) => task.pinnedAt != null,
    count: pinnedTasks.length,
    tasks: pinnedTasks,
  }, ...sections];
}

export function orderedTopLevelTasks(tasks: Task[], options: TaskTreeOptions = {}): Task[] {
  return buildTaskTree(tasks, options).flatMap((section) => section.tasks);
}
