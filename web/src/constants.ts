import type { TaskStatus, Priority } from "@harness/shared";

// 完整状态 metadata。paused 跟 running 是「进行中」的两个面：前者跑到检查点等续跑，
// 后者正在执行。idle 是团队调度台专有状态：进程在线但这一刻没在说话（`/team`）。
// 它仍需要完整的图标、配色和 label，但任务列表不再为它单独渲染「待命」分组，而是把
// idle 的团队任务归入「运行中」。分组顺序由下面的 STATUSES 单独维护。
//
// 配色上 cyan 已经让给「有人在问你话」（见 StatusIcon.tsx），所以 paused/idle 一起
// 收到中性的 slate：它们都是「harness 自己会推进，不用你管」。
type StatusMeta = { key: TaskStatus; label: string; dot: string; text: string };

export const STATUS_META = {
  running: { key: "running", label: "运行中", dot: "bg-sky-400", text: "text-sky-300" },
  idle: { key: "idle", label: "待命", dot: "bg-slate-400", text: "text-slate-300" },
  paused: { key: "paused", label: "暂停中", dot: "bg-slate-400", text: "text-slate-300" },
  awaiting_review: { key: "awaiting_review", label: "等待审核", dot: "bg-violet-400", text: "text-violet-300" },
  queued: { key: "queued", label: "排队中", dot: "bg-amber-400", text: "text-amber-300" },
  backlog: { key: "backlog", label: "待排期", dot: "bg-neutral-600", text: "text-neutral-400" },
  done: { key: "done", label: "完成", dot: "bg-emerald-400", text: "text-emerald-300" },
  failed: { key: "failed", label: "失败", dot: "bg-red-400", text: "text-red-300" },
  canceled: { key: "canceled", label: "已取消", dot: "bg-neutral-500", text: "text-neutral-400" },
} satisfies Record<TaskStatus, StatusMeta>;

// 任务列表的状态分组渲染顺序。idle 不单独成组，见上方说明。
export const STATUSES: StatusMeta[] = [
  STATUS_META.running,
  STATUS_META.paused,
  STATUS_META.awaiting_review,
  STATUS_META.queued,
  STATUS_META.backlog,
  STATUS_META.done,
  STATUS_META.failed,
  STATUS_META.canceled,
];

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
