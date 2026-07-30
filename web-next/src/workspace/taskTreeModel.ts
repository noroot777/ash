import type { Task, TaskStatus } from "@harness/shared";

type TaskGroup = {
  key: string;
  label: string;
  matches: (task: Task) => boolean;
  pinned?: boolean;
};

type TaskSection = {
  key: "collab" | "single";
  label: string;
  matches: (task: Task) => boolean;
  groups: readonly TaskGroup[];
};

export type TaskTreeGroup = TaskGroup & {
  collapseKey: string;
  tasks: Task[];
};
export type TaskTreeSection = Omit<TaskSection, "groups"> & {
  count: number;
  groups: TaskTreeGroup[];
};

const PRIORITY_ORDER: Task["priority"][] = ["urgent", "high", "medium", "low", "none"];

const PINNED_GROUP: TaskGroup = {
  key: "pinned",
  label: "置顶",
  matches: (task) => task.pinnedAt != null,
  pinned: true,
};

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
    matches: (task) => task.mode === "team" || task.mode === "debate",
    groups: [PINNED_GROUP, ...COLLAB_GROUPS],
  },
  {
    key: "single",
    label: "普通任务",
    matches: (task) => task.mode === "single",
    groups: [
      PINNED_GROUP,
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

export function buildTaskTree(tasks: Task[]): TaskTreeSection[] {
  const topLevel = tasks.filter((task) => task.parentId === null && !task.archived);
  return TASK_SECTIONS.map((section) => {
    const sectionTasks = topLevel.filter(section.matches);
    const groups = section.groups
      .map((group) => ({
        ...group,
        collapseKey: `${section.key}:${group.key}`,
        tasks: sortTasks(
          sectionTasks.filter(
            (task) => group.matches(task) && (group.pinned || task.pinnedAt == null),
          ),
          !!group.pinned,
        ),
      }))
      .filter((group) => group.tasks.length > 0);
    return { ...section, count: sectionTasks.length, groups };
  }).filter((section) => section.count > 0);
}

export function orderedTopLevelTasks(tasks: Task[]): Task[] {
  return buildTaskTree(tasks).flatMap((section) => section.groups.flatMap((group) => group.tasks));
}
