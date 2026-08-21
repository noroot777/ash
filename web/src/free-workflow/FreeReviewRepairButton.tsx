import { useState } from "react";
import type { FreeReviewRun } from "@ash/shared";
import { SpinnerGap, Wrench } from "@phosphor-icons/react";
import { api, type FreeWorkflowApiState } from "../lib/api.ts";

export function FreeReviewRepairButton({
  taskId,
  run,
  compact = false,
  className,
  disabled = false,
  onChanged,
  notify,
}: {
  taskId: string;
  run: FreeReviewRun;
  compact?: boolean;
  className?: string;
  disabled?: boolean;
  onChanged: (state: FreeWorkflowApiState) => void;
  notify: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);

  const repair = async () => {
    if (busy || disabled) return;
    setBusy(true);
    try {
      onChanged(await api.repairFreeReview(taskId));
      notify(`已按第 ${run.currentRound} 轮审查意见发起修复；可立即预约完成后的复审`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "发起审查修复失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      className={className}
      data-state={busy ? "starting-repair" : "stopped"}
      disabled={disabled || busy}
      onClick={() => void repair()}
    >
      {busy ? <SpinnerGap size={13} className="is-spinning" /> : <Wrench size={13} weight="bold" />}
      <span>{busy ? "正在发起修复" : compact ? "按意见修复" : `按第 ${run.currentRound} 轮意见修复`}</span>
    </button>
  );
}
