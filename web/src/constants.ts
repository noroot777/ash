import type { TaskStatus, Priority } from "@harness/shared";

// Status metadata — ordered for the grouped list view (DESIGN.md §8).
export const STATUSES: { key: TaskStatus; label: string; dot: string; text: string }[] = [
  { key: "running", label: "运行中", dot: "bg-sky-400", text: "text-sky-300" },
  { key: "awaiting_review", label: "等待审核", dot: "bg-violet-400", text: "text-violet-300" },
  { key: "queued", label: "排队中", dot: "bg-amber-400", text: "text-amber-300" },
  { key: "backlog", label: "待排期", dot: "bg-neutral-600", text: "text-neutral-400" },
  { key: "done", label: "完成", dot: "bg-emerald-400", text: "text-emerald-300" },
  { key: "failed", label: "失败", dot: "bg-red-400", text: "text-red-300" },
  { key: "canceled", label: "已取消", dot: "bg-neutral-500", text: "text-neutral-400" },
];

export const STATUS_META: Record<TaskStatus, (typeof STATUSES)[number]> = Object.fromEntries(
  STATUSES.map((s) => [s.key, s]),
) as Record<TaskStatus, (typeof STATUSES)[number]>;

// Priority metadata — ordered high→low. `bars` drives the little bar glyph.
export const PRIORITIES: { key: Priority; label: string; bars: number; color: string }[] = [
  { key: "urgent", label: "紧急", bars: 4, color: "text-red-400" },
  { key: "high", label: "高", bars: 3, color: "text-orange-300" },
  { key: "medium", label: "中", bars: 2, color: "text-amber-300" },
  { key: "low", label: "低", bars: 1, color: "text-neutral-400" },
  { key: "none", label: "无", bars: 0, color: "text-neutral-600" },
];

export const PRIORITY_META: Record<Priority, (typeof PRIORITIES)[number]> = Object.fromEntries(
  PRIORITIES.map((p) => [p.key, p]),
) as Record<Priority, (typeof PRIORITIES)[number]>;

export const PRIORITY_ORDER: Priority[] = ["urgent", "high", "medium", "low", "none"];
