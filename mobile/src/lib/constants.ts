// Status & priority metadata, ported from web/src/constants.ts. Tailwind class
// names are replaced with plain hex colors for RN. The STATUSES array order is
// load-bearing: it drives the grouped list view (running → … → canceled).
import type { TaskStatus, Priority } from "@harness/shared";

export const STATUSES: { key: TaskStatus; label: string; color: string }[] = [
  { key: "running", label: "运行中", color: "#38bdf8" },
  { key: "awaiting_review", label: "等待审核", color: "#a78bfa" },
  { key: "queued", label: "排队中", color: "#fbbf24" },
  { key: "backlog", label: "待排期", color: "#8a8a90" },
  { key: "done", label: "完成", color: "#34d399" },
  { key: "failed", label: "失败", color: "#f87171" },
  { key: "canceled", label: "已取消", color: "#737373" },
];

export const STATUS_META = Object.fromEntries(STATUSES.map((s) => [s.key, s])) as Record<
  TaskStatus,
  (typeof STATUSES)[number]
>;

export const PRIORITIES: { key: Priority; label: string; bars: number; color: string }[] = [
  { key: "urgent", label: "紧急", bars: 4, color: "#f87171" },
  { key: "high", label: "高", bars: 3, color: "#fdba74" },
  { key: "medium", label: "中", bars: 2, color: "#fcd34d" },
  { key: "low", label: "低", bars: 1, color: "#a3a3a3" },
  { key: "none", label: "无", bars: 0, color: "#525252" },
];

export const PRIORITY_META = Object.fromEntries(PRIORITIES.map((p) => [p.key, p])) as Record<
  Priority,
  (typeof PRIORITIES)[number]
>;
