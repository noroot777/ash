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
  /**
   * 这颗按钮此刻正在做的那件事。**三件事必须分开**：`opening` 是「起预览的请求挂着」
   * （可以取消），`closing` 是「关一个已经起来的预览」，`canceling` 是「取消一次启动」。
   * 只用一个 previewBusy 的话，关闭一个已就绪预览时按钮会翻成「启动中·点此取消」，
   * 而且照样能点 —— 用户对着一个正在关的预览，被告知它正在启动、还能再取消一次。
   */
  const [previewAction, setPreviewAction] = useState<null | "opening" | "closing" | "canceling">(null);
  const previewBusy = previewAction !== null;
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

  // 启动那一段（装依赖最长 6 分钟 + 等就绪 2 分钟）**必须有一颗能点的取消**。
  //
  // POST 是同步等到就绪才回来的，所以这段时间里发起的那个页面 previewBusy 一直是 true；
  // 别的页面（或者刷新之后）则从快照里的 preview.starting 看到同一件事。两条路都要能点到
  // 关闭 —— 后端为此专门让 DELETE 不再跟 POST 抢那把锁（free-workflow-preview.ts），
  // 前端这颗按钮如果还是灰的，那套取消逻辑就等于不存在。
  // 「正在启动」= 服务端说它在启动，或者**我这一下正在起**（POST 还挂着）。关闭那一路
  // 不算，否则就是上面说的那种误报。
  const previewStarting = (free.state?.preview.starting ?? false) || previewAction === "opening";
  const cancelPreview = async () => {
    if (previewAction === "canceling" || previewAction === "closing") return;
    setPreviewAction("canceling");
    try {
      const { stopped } = await api.stopFreePreview(task.id);
      notify(stopped ? "已取消启动预览" : "预览已经不在跑了");
    } catch (error) {
      notify(error instanceof Error ? error.message : "取消失败");
    } finally {
      // 起预览那一路的 POST 还没回来（它要等到自己发现被取消），快照照样重拉：
      // 记录已经被删掉了，界面该立刻回到「打开预览」。
      setPreviewAction(null);
      await free.reload(true).catch(() => undefined);
    }
  };

  const togglePreview = async () => {
    if (previewBusy) return;
    const closing = !!free.state?.preview.running;
    setPreviewAction(closing ? "closing" : "opening");
    try {
      if (closing) {
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
      setPreviewAction(null);
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
        {/* 启动中这颗是**可点的取消**，不是一颗灰着的「处理中」：那八分钟里用户唯一想做的
            就是「我不等了」，而后端此刻确实收得掉（记录、pid、装依赖的进程都在盘上）。 */}
        <button type="button" className={`is-preview${previewBusy ? " is-busy" : ""}`} data-state={previewAction === "closing" ? "closing" : previewStarting ? "starting" : free.state?.preview.running ? "running" : "idle"} aria-pressed={!!free.state?.preview.running} disabled={!taskReady || taskBusy || locked || !!reviewing || previewAction === "canceling" || previewAction === "closing" || (waiting && !free.state?.preview.running)} onClick={() => void (previewStarting ? cancelPreview() : togglePreview())}>
          {previewBusy ? <SpinnerGap size={13} className="is-spinning" /> : free.state?.preview.running ? <StopCircle size={13} weight="regular" /> : <MonitorPlay size={13} weight="regular" />}
          <span>{previewAction === "closing" ? "关闭中" : previewAction === "canceling" ? "取消中" : previewStarting ? "启动中·点此取消" : free.state?.preview.running ? "关闭预览" : "打开预览"}</span>
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
      {logOpen && <PreviewLogDialog taskId={task.id} awaitingStart={previewAction === "opening"} onClose={() => setLogOpen(false)} notify={notify} />}
      {reviewOpen && <FreeReviewDialog taskId={task.id} state={free.state} reservationMode={reservationMode} onChanged={free.setState} onClose={() => setReviewOpen(false)} notify={notify} />}
    </>
  );
}
