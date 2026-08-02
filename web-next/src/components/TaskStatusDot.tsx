import { CircleDashed } from "@phosphor-icons/react";
import type { TaskStatusIndicator } from "../lib/useTaskReadState.ts";

const INDICATOR_LABELS: Record<TaskStatusIndicator, string> = {
  pending: "尚未开始",
  active: "运行中或排队中",
  attention: "需要人工输入",
  success: "已完成，有未读动态",
  error: "失败或取消，有未读动态",
};

export function TaskStatusDot({
  indicator,
  surface,
  small = false,
}: {
  indicator: TaskStatusIndicator;
  surface: "workspace" | "team";
  small?: boolean;
}) {
  const base = surface === "workspace" ? "workspace-status-dot" : "team-status-dot";
  const label = INDICATOR_LABELS[indicator];
  return (
    <i
      className={`${base} ${base}--${indicator}${small ? ` ${base}--small` : ""}`}
      title={label}
      aria-label={label}
    >
      {surface === "workspace" && indicator === "pending" && (
        <CircleDashed className="workspace-status-dot-icon" weight="regular" aria-hidden="true" />
      )}
    </i>
  );
}
