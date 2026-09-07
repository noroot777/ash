import { useEffect, useState } from "react";
import type { Task } from "@ash/shared";
import { ArrowSquareOut, MagnifyingGlass, MonitorPlay, SpinnerGap, StopCircle, Terminal } from "@phosphor-icons/react";
import { api } from "../lib/api.ts";
import { FreeReviewDialog } from "./FreeReviewDialog.tsx";
import { FreeReviewProgress } from "./FreeReviewProgress.tsx";
import { FreeReviewRepairButton } from "./FreeReviewRepairButton.tsx";
import { PreviewLogDialog } from "./PreviewLogDialog.tsx";
import { freeReviewView } from "./freeReviewCopy.ts";
import { useFreeWorkflowState } from "./useFreeWorkflowState.ts";

export function FreeWorkflowToolbar({ task, notify }: { task: Task; notify: (message: string) => void }) {
  const free = useFreeWorkflowState(task.id, task.workflowMode === "free");
  const [reviewOpen, setReviewOpen] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const [previewBusy, setPreviewBusy] = useState(false);
  // 「这一轮我按过打开预览」——启动期间 hasLog 还没翻真（快照要等 POST 回来才重拉），
  // 但日志文件其实已经在长了。见 togglePreview 里那两行注释：亮起在 POST 之前，
  // 清回在 POST 有结论之后。
  const [logArmed, setLogArmed] = useState(false);
  // 换了任务就作废：这一档说的是「**这个任务**这一轮按过」，跟着旧任务漂过去就是假的。
  useEffect(() => {
    setLogArmed(false);
    setLogOpen(false);
  }, [task.id]);
  const view = freeReviewView(free.state, task);
  const { latestRun, reviewing, stoppedRun, taskBusy, waiting, reservationArmed, reservationMode, repairing, stale } = view;
  const taskReady = task.status !== "backlog";
  // 等待答复/续跑期间**立即发起**的动作（派审/修复/打开预览）后端必拒（409），按钮同步
  // 禁用；「预约」不在其列——后端 reserveFreeReview 根本没有这道门禁，任务正等续跑时预约
  // 一轮「跑完就审」恰恰是该允许的。取消预约、关闭预览是控制类动作，同样不能锁死。
  // waiting / reservationMode 的定义在 freeReviewCopy.ts 里,和 Inspector 共用一份:
  // 两边各写一份的时候就漂过——底部那颗灰、侧栏那颗能点。
  // 接力出去的任务在本机是历史存档:派审/修复/开预览这些发起类动作后端一律 409,
  // 这里按同一口径锁死(取消预约、关预览是清理,照常可点)。
  const locked = task.stage === "accepted" || task.stage === "merged" || task.archived
    || task.handoff?.direction === "out";
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
        // 这一行必须在 await 之前：启动会**同步等到就绪**（最长两分钟），而日志从
        // spawn 之前就在长。等 POST 回来才让「预览日志」出来，等于把最该看日志的那两
        // 分钟锁在门外 —— 用户守着一颗「处理中」，看不到 Maven 正在下什么、前端编到哪。
        setLogArmed(true);
        const preview = await api.startFreePreview(task.id);
        notify(preview.url ? `预览已打开：${preview.url}` : "预览已打开");
        if (preview.url) window.open(preview.url, "_blank", "noopener,noreferrer");
      }
      await free.reload(true);
    } catch (error) {
      // 起失败也要 reload：日志文件这时已经落盘了，reload 之后 `hasLog` 才会翻真、
      // 「预览日志」那颗按钮才出得来 —— 否则用户手上只剩一句转瞬即逝的 toast。
      notify(error instanceof Error ? error.message : "预览操作失败");
      await free.reload(true).catch(() => undefined);
    } finally {
      setPreviewBusy(false);
      // 乐观那一档到此为止，交回给 `hasLog` —— 上面两条路都已经重拉过快照了。
      // **必须清**：有些失败发生在 spawn 之前（多候选时 resolvePreviewCommand 直接 409），
      // 那种情况下根本没有日志文件，留着这一档就是一颗点开只会说「还没有预览日志」的
      // 永久按钮 —— 而多候选恰恰是这个仓库没配预览命令时的默认形状。
      setLogArmed(false);
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
        <button type="button" className={`is-review${reviewing ? " is-busy" : ""}${reservationArmed ? " is-armed" : ""}`} data-state={reviewing ? "reviewing" : reservationArmed ? "armed" : latestRun?.status ?? "idle"} disabled={!taskReady || locked || !!reviewing || (waiting && !reservationMode)} onClick={() => setReviewOpen(true)}>
          {reviewing ? <SpinnerGap size={13} className="is-spinning" /> : <MagnifyingGlass size={13} weight="regular" />}
          <span>{reviewLabel}</span>
          {reservationArmed && <i className="free-review-armed-dot" aria-hidden="true" />}
        </button>
        <button type="button" className={`is-preview${previewBusy ? " is-busy" : ""}`} aria-pressed={!!free.state?.preview.running} disabled={!taskReady || taskBusy || locked || !!reviewing || previewBusy || (waiting && !free.state?.preview.running)} onClick={() => void togglePreview()}>
          {previewBusy ? <SpinnerGap size={13} className="is-spinning" /> : free.state?.preview.running ? <StopCircle size={13} weight="regular" /> : <MonitorPlay size={13} weight="regular" />}
          <span>{previewBusy ? "处理中" : free.state?.preview.running ? "关闭预览" : "打开预览"}</span>
        </button>
        {free.state?.preview.running && free.state.preview.url && <a href={free.state.preview.url} target="_blank" rel="noreferrer" aria-label="在新窗口打开预览"><ArrowSquareOut size={13} /><span>预览页</span></a>}
        {/* 日志入口按 hasLog 给，不按 running 给：预览**起不来**的那一次同样留下了日志，
            而那正是最需要看它的时候。读日志是只读动作，接力/验收锁死也照给。
            logArmed 是启动期间的那一档：hasLog 要等这次 POST 回来才翻真，可日志从
            spawn 之前就在长，最长两分钟。 */}
        {(free.state?.preview.hasLog || logArmed) && (
          <button type="button" className="is-preview-log" data-testid="preview-log-open" onClick={() => setLogOpen(true)}>
            <Terminal size={13} weight="regular" /><span>预览日志</span>
          </button>
        )}
      </div>
      {logOpen && <PreviewLogDialog taskId={task.id} awaitingStart={previewBusy} onClose={() => setLogOpen(false)} notify={notify} />}
      {reviewOpen && <FreeReviewDialog taskId={task.id} state={free.state} reservationMode={reservationMode} onChanged={free.setState} onClose={() => setReviewOpen(false)} notify={notify} />}
    </>
  );
}
