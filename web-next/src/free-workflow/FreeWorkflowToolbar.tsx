import { useState } from "react";
import type { Task } from "@harness/shared";
import { ArrowSquareOut, MagnifyingGlass, MonitorPlay, SpinnerGap, StopCircle } from "@phosphor-icons/react";
import { api } from "../lib/api.ts";
import { FreeReviewDialog } from "./FreeReviewDialog.tsx";
import { freeReviewBlockingLabel } from "./freeReviewCopy.ts";
import { useFreeWorkflowState } from "./useFreeWorkflowState.ts";

export function FreeWorkflowToolbar({ task, notify }: { task: Task; notify: (message: string) => void }) {
  const free = useFreeWorkflowState(task.id, task.workflowMode === "free");
  const [reviewOpen, setReviewOpen] = useState(false);
  const [previewBusy, setPreviewBusy] = useState(false);
  const activeReview = free.state?.reviews.find((run) => freeReviewBlockingLabel(run) !== null);
  const reviewArmed = !!free.state?.reviewReservation?.armed && !activeReview;
  const taskBusy = task.status === "running" || task.status === "queued";
  const taskReady = task.status !== "backlog";
  const accepted = task.stage === "accepted" || task.stage === "merged";

  const togglePreview = async () => {
    if (previewBusy) return;
    setPreviewBusy(true);
    try {
      if (free.state?.preview.running) {
        await api.stopFreePreview(task.id);
        notify("预览已关闭");
      } else {
        const preview = await api.startFreePreview(task.id);
        notify(preview.url ? `预览已打开：${preview.url}` : "预览已打开");
        if (preview.url) window.open(preview.url, "_blank", "noopener,noreferrer");
      }
      await free.reload(true);
    } catch (error) {
      notify(error instanceof Error ? error.message : "预览操作失败");
    } finally {
      setPreviewBusy(false);
    }
  };

  if (task.workflowMode !== "free" || task.mode !== "single" || task.parentId || task.reviewOf) return null;
  return (
    <>
      <div className="free-workflow-toolbar" aria-label="自由工作流快捷操作">
        <button type="button" className={`is-review${activeReview ? " is-busy" : ""}${reviewArmed ? " is-armed" : ""}`} data-state={activeReview?.status ?? (reviewArmed ? "armed" : "idle")} disabled={!taskReady || accepted || !!activeReview} onClick={() => setReviewOpen(true)}>
          {activeReview?.status === "reviewing" ? <SpinnerGap size={13} className="is-spinning" /> : <MagnifyingGlass size={13} weight="regular" />}
          <span>{activeReview ? freeReviewBlockingLabel(activeReview) : reviewArmed ? "已预约审查" : "派审查"}</span>
          {reviewArmed && <i className="free-review-armed-dot" aria-hidden="true" />}
        </button>
        <button type="button" className={`is-preview${previewBusy ? " is-busy" : ""}`} aria-pressed={!!free.state?.preview.running} disabled={!taskReady || taskBusy || accepted || previewBusy} onClick={() => void togglePreview()}>
          {previewBusy ? <SpinnerGap size={13} className="is-spinning" /> : free.state?.preview.running ? <StopCircle size={13} weight="regular" /> : <MonitorPlay size={13} weight="regular" />}
          <span>{previewBusy ? "处理中" : free.state?.preview.running ? "关闭预览" : "打开预览"}</span>
        </button>
        {free.state?.preview.running && free.state.preview.url && <a href={free.state.preview.url} target="_blank" rel="noreferrer" aria-label="在新窗口打开预览"><ArrowSquareOut size={13} /><span>预览页</span></a>}
      </div>
      {reviewOpen && <FreeReviewDialog taskId={task.id} state={free.state} reservationMode={taskBusy || reviewArmed} onChanged={free.setState} onClose={() => setReviewOpen(false)} notify={notify} />}
    </>
  );
}
