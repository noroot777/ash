// Status & priority metadata, ported from web/src/constants.ts. Tailwind class
// names are replaced with plain hex colors for RN. The STATUSES array order is
// load-bearing: it drives the grouped list view (running → … → canceled).
import type { TaskStatus, Priority } from "@harness/shared";

export const STATUSES: { key: TaskStatus; label: string; color: string }[] = [
  { key: "running", label: "运行中", color: "#5EE6C5" },
  { key: "awaiting_review", label: "等待审核", color: "#a78bfa" },
  { key: "queued", label: "排队中", color: "#fbbf24" },
  { key: "backlog", label: "待排期", color: "#8a8a90" },
  { key: "done", label: "完成", color: "#34d399" },
  { key: "failed", label: "失败", color: "#FF6B6B" },
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

// 创建任务时的「启动时机」——四种互斥:仅创建 / 立即执行 / 定时一次性 / 定时循环。
// `btn` 是该模式下底部主按钮的文案。默认 run（与 web 端一致）。
export type LaunchMode = "create" | "run" | "once" | "cron";
export const LAUNCH_MODES: { key: LaunchMode; label: string; btn: string }[] = [
  { key: "create", label: "仅创建", btn: "创建任务" },
  { key: "run", label: "立即执行", btn: "创建并执行" },
  { key: "once", label: "定时一次", btn: "创建并定时" },
  { key: "cron", label: "定时循环", btn: "创建并定时" },
];

// 手机无 hover —— cron 示例要可见地显示在输入框下方（web 端放在 input title 里）。
export const CRON_EXAMPLES = "例:0 9 * * 1-5 工作日9点 · */30 * * * * 每半小时";
