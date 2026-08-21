import { SpinnerGap } from "@phosphor-icons/react";

export function FreeReviewProgress({
  kind,
  compact = false,
}: {
  kind: "auto_rereview" | "task_running";
  compact?: boolean;
}) {
  const label = kind === "auto_rereview"
    ? (compact ? "修改中，完成后自动复审" : "任务修改中，确认完成后自动复审")
    : (compact ? "任务修改中" : "任务正在修改");
  return (
    <span className={`free-review-progress is-${kind}${compact ? " is-compact" : ""}`} role="status">
      <SpinnerGap size={13} className="is-spinning" />
      <span>{label}</span>
    </span>
  );
}
