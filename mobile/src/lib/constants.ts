// Status metadata, ported from web. Tailwind class names are replaced with
// plain hex colors for RN. `idle` is kept as precise
// metadata but folded into the running section by the task list, just like web.
import type { TaskStatus } from "@ash/shared";

type StatusMeta = { key: TaskStatus; label: string; color: string };

export const STATUS_META = {
  running: { key: "running", label: "运行中", color: "#5EE6C5" },
  idle: { key: "idle", label: "待命", color: "#94A3B8" },
  paused: { key: "paused", label: "暂停中", color: "#94A3B8" },
  awaiting_review: { key: "awaiting_review", label: "等待审核", color: "#a78bfa" },
  queued: { key: "queued", label: "排队中", color: "#fbbf24" },
  backlog: { key: "backlog", label: "待排期", color: "#8a8a90" },
  done: { key: "done", label: "完成", color: "#34d399" },
  failed: { key: "failed", label: "失败", color: "#FF6B6B" },
  canceled: { key: "canceled", label: "已取消", color: "#737373" },
} satisfies Record<TaskStatus, StatusMeta>;

// Load-bearing grouped-list order. Team idle is intentionally not a separate
// section: the list folds it into running while retaining its slate signal bar.
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
