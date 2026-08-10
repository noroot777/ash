import { SpinnerGap } from "@phosphor-icons/react";

export function FreeReviewProgress({
  kind,
  compact = false,
}: {
  kind: "manual_repairing" | "reworking" | "task_running";
  compact?: boolean;
}) {
  const label = kind === "manual_repairing"
    ? (compact ? "按意见修复中" : "正在按审查意见修复")
    : (compact ? "任务修改中" : "任务正在修改");
  return (
    <span className={`free-review-progress is-${kind}${compact ? " is-compact" : ""}`} role="status">
      <SpinnerGap size={13} className="is-spinning" />
      <span>{label}</span>
    </span>
  );
}
