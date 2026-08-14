import { useState } from "react";
import type { Task } from "@harness/shared";
import { ArrowSquareOut, MagnifyingGlass, MonitorPlay, SpinnerGap, StopCircle } from "@phosphor-icons/react";
import { api } from "../lib/api.ts";
import { FreeReviewDialog } from "./FreeReviewDialog.tsx";
import { FreeReviewProgress } from "./FreeReviewProgress.tsx";
import { FreeReviewRepairButton } from "./FreeReviewRepairButton.tsx";
import { freeReviewView } from "./freeReviewCopy.ts";
import { useFreeWorkflowState } from "./useFreeWorkflowState.ts";

export function FreeWorkflowToolbar({ task, notify }: { task: Task; notify: (message: string) => void }) {
  const free = useFreeWorkflowState(task.id, task.workflowMode === "free");
  const [reviewOpen, setReviewOpen] = useState(false);
  const [previewBusy, setPreviewBusy] = useState(false);
  const view = freeReviewView(free.state, task);
  const { latestRun, reviewing, stoppedRun, taskBusy, reservationArmed, repairing, stale } = view;
  const taskReady = task.status !== "backlog";
  // 等待答复/续跑期间**发起类**动作（派审/修复/打开预览）后端必拒（409），按钮同步禁用；
  // 取消预约、关闭预览是控制类动作，后端不设 waiting 门禁，不能一并锁死——预约挂着时
  // 用户必须能取消，预览开着时必须能收掉端口。
  const waiting = !!task.question || !!task.resumePrompt;
  const locked = task.stage === "accepted" || task.stage === "merged" || task.archived;
  const reservationMode = taskBusy || reservationArmed;
  const reviewLabel = reviewing
    ? "审查中"
    : reservationArmed
      ? "已预约复审"
      : reservationMode
        ? "预约复审"
        : stale
          ? "审查新改动"
          : free.state?.reviews.some((run) => run.target?.kind !== "accepted_merge")
            ? (stoppedRun ? "直接再审" : "再审")
            : "派审查";
  // 未通过的意见只在结论**可证明仍然新鲜**时才是「当前待办」：stale（代码变过）和
  // unknown（缺锚点/工作区不可读）都不给修复入口——后端同样只在能核对时放行。

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
        {repairing && <FreeReviewProgress compact kind={view.autoRereview ? "auto_rereview" : "task_running"} />}
        {stoppedRun && !taskBusy && view.freshness === "fresh" ? (
          <FreeReviewRepairButton
            taskId={task.id}
            run={stoppedRun}
            compact
            className="is-review is-repair"
            disabled={!taskReady || locked || waiting}
            onChanged={free.setState}
            notify={notify}
          />
        ) : null}
        <button type="button" className={`is-review${reviewing ? " is-busy" : ""}${reservationArmed ? " is-armed" : ""}`} data-state={reviewing ? "reviewing" : reservationArmed ? "armed" : latestRun?.status ?? "idle"} disabled={!taskReady || locked || !!reviewing || (waiting && !reservationArmed)} onClick={() => setReviewOpen(true)}>
          {reviewing ? <SpinnerGap size={13} className="is-spinning" /> : <MagnifyingGlass size={13} weight="regular" />}
          <span>{reviewLabel}</span>
          {reservationArmed && <i className="free-review-armed-dot" aria-hidden="true" />}
        </button>
        <button type="button" className={`is-preview${previewBusy ? " is-busy" : ""}`} aria-pressed={!!free.state?.preview.running} disabled={!taskReady || taskBusy || locked || !!reviewing || previewBusy || (waiting && !free.state?.preview.running)} onClick={() => void togglePreview()}>
          {previewBusy ? <SpinnerGap size={13} className="is-spinning" /> : free.state?.preview.running ? <StopCircle size={13} weight="regular" /> : <MonitorPlay size={13} weight="regular" />}
          <span>{previewBusy ? "处理中" : free.state?.preview.running ? "关闭预览" : "打开预览"}</span>
        </button>
        {free.state?.preview.running && free.state.preview.url && <a href={free.state.preview.url} target="_blank" rel="noreferrer" aria-label="在新窗口打开预览"><ArrowSquareOut size={13} /><span>预览页</span></a>}
      </div>
      {reviewOpen && <FreeReviewDialog taskId={task.id} state={free.state} reservationMode={reservationMode} onChanged={free.setState} onClose={() => setReviewOpen(false)} notify={notify} />}
    </>
  );
}
