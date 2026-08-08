import { useState } from "react";
import type { Task } from "@harness/shared";
import { ArrowSquareOut, GitMerge, MagnifyingGlass, MonitorPlay, SpinnerGap, StopCircle } from "@phosphor-icons/react";
import { api } from "../lib/api.ts";
import { ConfirmDialog } from "../task-detail/ConfirmDialog.tsx";
import { FreeReviewDialog } from "./FreeReviewDialog.tsx";
import { useFreeWorkflowState } from "./useFreeWorkflowState.ts";

export function FreeWorkflowToolbar({ task, notify }: { task: Task; notify: (message: string) => void }) {
  const free = useFreeWorkflowState(task.id, task.workflowMode === "free");
  const [reviewOpen, setReviewOpen] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [mergeBusy, setMergeBusy] = useState(false);
  const activeReview = free.state?.reviews.find((run) => run.status === "reviewing" || run.status === "repairing");
  const taskBusy = task.status === "running" || task.status === "queued";
  const taskReady = task.status !== "backlog";
  const mergeStarted = free.state?.merge.status === "merging" || free.state?.merge.status === "merged";

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

  const merge = async () => {
    setMergeBusy(true);
    try {
      const result = await api.mergeFreeWorkflow(task.id);
      notify(result.message);
      setMergeOpen(false);
      await free.reload(true);
    } catch (error) {
      notify(error instanceof Error ? error.message : "合并清理失败");
    } finally {
      setMergeBusy(false);
    }
  };

  if (task.workflowMode !== "free" || task.mode !== "single" || task.parentId || task.reviewOf) return null;
  return (
    <>
      <div className="free-workflow-toolbar" aria-label="自由工作流快捷操作">
        <button type="button" className="is-review" data-state={activeReview?.status ?? "idle"} disabled={!taskReady || taskBusy || mergeStarted || !!activeReview} onClick={() => setReviewOpen(true)}>
          <span className="free-workflow-action-icon">{activeReview?.status === "reviewing" ? <SpinnerGap size={14} className="is-spinning" /> : <MagnifyingGlass size={14} weight="bold" />}</span>
          <span>{activeReview?.status === "reviewing" ? "审查中" : activeReview?.status === "repairing" ? "等待修复" : "派审查"}</span>
        </button>
        <button type="button" className="is-preview" aria-pressed={!!free.state?.preview.running} disabled={!taskReady || taskBusy || mergeStarted || previewBusy} onClick={() => void togglePreview()}>
          <span className="free-workflow-action-icon">{previewBusy ? <SpinnerGap size={14} className="is-spinning" /> : free.state?.preview.running ? <StopCircle size={14} weight="bold" /> : <MonitorPlay size={14} weight="bold" />}</span>
          <span>{previewBusy ? "处理中" : free.state?.preview.running ? "关闭预览" : "打开预览"}</span>
        </button>
        <button type="button" className="is-merge" data-state={free.state?.merge.status ?? "idle"} disabled={!taskReady || taskBusy || !!activeReview || mergeBusy || free.state?.merge.status === "merged"} onClick={() => setMergeOpen(true)}>
          <span className="free-workflow-action-icon">{mergeBusy ? <SpinnerGap size={14} className="is-spinning" /> : <GitMerge size={14} weight="bold" />}</span>
          <span>{free.state?.merge.status === "merged" ? "已合并清理" : "合并&清理"}</span>
        </button>
        {free.state?.preview.running && free.state.preview.url && <a href={free.state.preview.url} target="_blank" rel="noreferrer" aria-label="在新窗口打开预览"><ArrowSquareOut size={13} /><span>预览页</span></a>}
      </div>
      {reviewOpen && <FreeReviewDialog taskId={task.id} state={free.state} onDispatched={free.setState} onClose={() => setReviewOpen(false)} notify={notify} />}
      {mergeOpen && <ConfirmDialog title="合并并清理" message={free.state?.preview.running ? "将安全合并任务分支、清理 worktree 和分支，并先关闭当前预览。" : "将安全合并任务分支，并清理任务 worktree 与分支。"} confirmLabel="合并&清理" busy={mergeBusy} onConfirm={() => void merge()} onClose={() => setMergeOpen(false)} />}
    </>
  );
}
