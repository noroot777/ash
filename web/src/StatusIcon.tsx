import {
  taskDisplayStatus,
  type TaskDisplayStatusKey,
  type TaskStage,
  type TaskStatus,
} from "@harness/shared";

// 状态只用一个 6–8px 小色点表达。key 必须来自 shared 的 taskDisplayStatus，
// 这样 status × stage × awaitingAnswer 的优先级不会在各个页面各写一遍。
const DISPLAY_COLOR: Record<TaskDisplayStatusKey, string> = {
  backlog: "#9ca1a9",
  queued: "#9499a1",
  running: "#e2b203",
  idle: "#64748b",
  awaiting_review: "#8b5cf6",
  paused: "#64748b",
  done: "#5e6ad2",
  failed: "#eb5757",
  canceled: "#9ca1a9",
  awaiting_answer: "#06b6d4",
  implemented: "#3b82f6",
  verifying: "#d9a406",
  verified: "#22a06b",
  verify_failed: "#f06449",
  awaiting_acceptance: "#8b5cf6",
  merged: "#5e6ad2",
  accepted: "#22a06b",
};

export function displayStatusColor(key: TaskDisplayStatusKey): string {
  return DISPLAY_COLOR[key];
}

// 给时间轴等不能直接渲染组件的地方复用。旧调用只传 status/awaitingAnswer 仍成立。
export function statusColor(
  status: TaskStatus,
  awaitingAnswer = false,
  stage?: TaskStage | null,
): string {
  return displayStatusColor(taskDisplayStatus(status, stage, awaitingAnswer).key);
}

export function StatusIcon({
  status,
  stage,
  size = 7,
  awaitingAnswer = false,
  title,
  className = "",
}: {
  status: TaskStatus;
  stage?: TaskStage | null;
  size?: number;
  awaitingAnswer?: boolean;
  title?: string;
  className?: string;
}) {
  const display = taskDisplayStatus(status, stage, awaitingAnswer);
  const color = displayStatusColor(display.key);
  const dotSize = Math.max(6, Math.min(8, size));

  return (
    <span
      role="img"
      aria-label={title ?? display.label}
      title={title ?? display.label}
      className={`inline-flex shrink-0 items-center justify-center ${className}`}
      style={{ width: dotSize, height: dotSize }}
    >
      <span
        aria-hidden
        className={`block h-full w-full rounded-full ${awaitingAnswer ? "animate-pulse motion-reduce:animate-none" : ""}`}
        style={{
          backgroundColor: color,
          boxShadow: `0 0 0 1px ${color}24`,
        }}
      />
    </span>
  );
}
