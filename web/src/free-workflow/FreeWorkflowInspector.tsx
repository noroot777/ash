import { useMemo, useRef, useState } from "react";
import type {
  FreeReviewRound,
  FreeReviewRun,
  FreeWorkflowExecution,
  FreeWorkflowPreviewEvent,
  Task,
} from "@ash/shared";
import {
  CaretRight,
  CheckCircle,
  GitCommit,
  MagnifyingGlass,
  MonitorPlay,
  SpinnerGap,
  StopCircle,
  WarningCircle,
  Wrench,
} from "@phosphor-icons/react";
import { ImagePreviewGroup } from "../components/ImagePreview.tsx";
import { MarkdownBody } from "../components/MarkdownBody.tsx";
import { api, type FreeWorkflowApiState } from "../lib/api.ts";
import { ReviewEvidenceDrawer } from "../review/ReviewEvidenceDrawer.tsx";
import { ReviewScreenshotStrip } from "../review/ReviewScreenshotStrip.tsx";
import { FreeReviewDialog } from "./FreeReviewDialog.tsx";
import { FreeReviewProgress } from "./FreeReviewProgress.tsx";
import { FreeReviewRepairButton } from "./FreeReviewRepairButton.tsx";
import { freeReviewView } from "./freeReviewCopy.ts";
import { useFreeWorkflowState } from "./useFreeWorkflowState.ts";

type Activity =
  | { type: "execution"; at: string; key: string; execution: FreeWorkflowExecution }
  | { type: "review"; at: string; key: string; run: FreeReviewRun; round: FreeReviewRound }
  | { type: "preview"; at: string; key: string; event: FreeWorkflowPreviewEvent };

type ReviewActivity = Extract<Activity, { type: "review" }>;

function actualActivities(state: FreeWorkflowApiState | null): Activity[] {
  if (!state) return [];
  const activities: Activity[] = [
    ...(state.executions ?? []).map((execution): Activity => ({
      type: "execution", at: execution.startedAt, key: `execution-${execution.id}`, execution,
    })),
    ...state.reviews.flatMap((run) => run.rounds.map((round): Activity => ({
      type: "review", at: round.startedAt, key: `review-${run.id}-${round.round}`, run, round,
    }))),
    ...state.previewEvents.map((event): Activity => ({ type: "preview", at: event.occurredAt, key: `preview-${event.id}`, event })),
  ];
  return activities.sort((a, b) => a.at.localeCompare(b.at) || a.key.localeCompare(b.key));
}

const TIME_FORMAT = new Intl.DateTimeFormat("zh-CN", {
  month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
});

function timeText(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : TIME_FORMAT.format(date);
}

function durationText(startedAt: string, endedAt: string | null): string | null {
  if (!endedAt) return null;
  const ms = Date.parse(endedAt) - Date.parse(startedAt);
  if (!Number.isFinite(ms) || ms < 0) return null;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  return `${hours} 小时 ${minutes % 60} 分钟`;
}

function timing(startedAt: string, endedAt: string | null): string {
  const duration = durationText(startedAt, endedAt);
  return `${timeText(startedAt)}${duration ? ` · ${duration}` : ""}`;
}

function executionLabel(execution: FreeWorkflowExecution): string {
  if (execution.status === "running") return "正在进行";
  if (execution.status === "completed") return "已完成";
  if (execution.status === "paused") return "已暂停";
  if (execution.status === "canceled") return "已取消";
  return "执行失败";
}

function reviewRoundLabel(round: FreeReviewRound): string {
  if (round.status === "reviewing") return "审查中";
  if (round.conclusion === "verified") return "已通过";
  if (round.conclusion === "verify_failed") return "未通过";
  return "异常";
}

function reviewKey(runId: string, round: number): string {
  return `${runId}:${round}`;
}

function reviewStatusIcon(round: FreeReviewRound) {
  if (round.status === "reviewing") return <SpinnerGap size={11} className="is-spinning" />;
  if (round.conclusion === "verified") return <CheckCircle size={11} weight="fill" />;
  return <WarningCircle size={11} weight="fill" />;
}

export function FreeWorkflowInspector({
  task,
  reviewOnly = false,
  onOpenReview,
  onOpenTask,
  notify,
}: {
  task: Task;
  reviewOnly?: boolean;
  onOpenReview?: () => void;
  onOpenTask?: (taskId: string) => void;
  notify?: (message: string) => void;
}) {
  const free = useFreeWorkflowState(task.id);
  const [selectedReviewKey, setSelectedReviewKey] = useState<string | null>(null);
  const [reviewDialogOpen, setReviewDialogOpen] = useState(false);
  const [postMergeDialogOpen, setPostMergeDialogOpen] = useState(false);
  const [repairBusy, setRepairBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const workflowListRef = useRef<HTMLOListElement>(null);
  const reviewListRef = useRef<HTMLDivElement>(null);
  const postMergeReviewListRef = useRef<HTMLDivElement>(null);
  const state = free.state;
  const activities = useMemo(() => actualActivities(state), [state]);
  const latestPreviewEvent = state?.previewEvents.at(-1);
  const reviewActivities = activities.filter((activity): activity is ReviewActivity => activity.type === "review");
  const workspaceReviewActivities = reviewActivities.filter((activity) => activity.run.target?.kind !== "accepted_merge");
  const postMergeReviewActivities = reviewActivities.filter((activity) => activity.run.target?.kind === "accepted_merge");
  const opened = selectedReviewKey
    ? reviewActivities.find((activity) => reviewKey(activity.run.id, activity.round.round) === selectedReviewKey) ?? null
    : null;
  const latestReview = workspaceReviewActivities.at(-1);
  const postMergeRuns = state?.reviews.filter((run) => run.target?.kind === "accepted_merge") ?? [];
  const latestPostMerge = postMergeRuns[0];
  const latestPostMergeRound = latestPostMerge?.rounds.at(-1);
  const postMergeRepairTaskId = latestPostMerge?.target?.kind === "accepted_merge"
    ? latestPostMerge.target.repairTaskId
    : null;
  const acceptedTarget = task.stage === "accepted" && task.acceptedTargetBranch && task.acceptedBaseCommit && task.acceptedMergeCommit
    ? { branch: task.acceptedTargetBranch, baseCommit: task.acceptedBaseCommit, mergeCommit: task.acceptedMergeCommit }
    : null;
  const view = freeReviewView(state, task);
  const { latestRun, reviewing, stoppedRun, taskBusy, reservationArmed, repairing, stale } = view;
  const taskReady = task.status !== "backlog";
  // waiting 只锁发起类动作（派审/修复），取消预约的入口不能一并锁死（同 Toolbar）。
  const waiting = !!task.question || !!task.resumePrompt;
  const locked = task.stage === "accepted" || task.stage === "merged" || !!task.archived;
  const reservationMode = taskBusy || reservationArmed;
  const reviewActionLabel = reviewing
    ? "审查进行中"
    : reservationArmed
      ? "调整预约复审"
      : reservationMode
        ? "预约复审"
        : stale
          ? "审查新改动"
          : workspaceReviewActivities.length ? "再审一轮" : "派审查";
  const exhausted = stoppedRun && stoppedRun.currentRound > stoppedRun.retryLimit;
  const overviewDetail = reviewing
    ? `第 ${reviewing.currentRound} 轮审查中`
    : repairing
      ? `第 ${latestRun?.currentRound ?? 1} 轮未通过 · 任务修改中`
      : stoppedRun && stale
        ? `第 ${stoppedRun.currentRound} 轮未通过 · 之后代码有变化，建议审查新改动`
        : stoppedRun
          ? `第 ${stoppedRun.currentRound} 轮未通过${view.autoRereview ? " · 修复后自动复审" : exhausted ? " · 自动复审已停止" : ""}`
          : stale
            ? "已通过，但之后代码有变化 · 结论可能过期"
            : view.freshness === "unknown" && latestRun?.status === "passed"
              ? "已通过 · 无法确认结论是否仍对应当前代码"
              : latestReview ? `最近一轮${reviewRoundLabel(latestReview.round)}` : "尚未派审";
  const overviewStatus = repairing ? "repairing" : stale ? "stale" : null;

  if (free.loading && !free.state) return <div className="free-workflow-inspector is-loading"><SpinnerGap size={14} className="is-spinning" />正在生成实际工作流…</div>;
  if (free.error && !free.state) return <div className="free-workflow-inspector is-loading is-error"><WarningCircle size={14} />{free.error}</div>;

  const selectReview = (run: FreeReviewRun, round: FreeReviewRound) => {
    const key = reviewKey(run.id, round.round);
    setSelectedReviewKey((current) => current === key ? null : key);
  };

  const openLatestPostMerge = () => {
    if (latestPostMerge && latestPostMergeRound) selectReview(latestPostMerge, latestPostMergeRound);
  };

  const createPostMergeRepair = async () => {
    if (!latestPostMerge || repairBusy || !notify || !onOpenTask) return;
    setRepairBusy(true);
    try {
      const repair = await api.createPostMergeRepairTask(task.id, latestPostMerge.id);
      await free.reload(true);
      notify(`已创建独立修复任务「${repair.title}」`);
      onOpenTask(repair.id);
    } catch (error) {
      notify(error instanceof Error ? error.message : "修复任务创建失败");
    } finally {
      setRepairBusy(false);
    }
  };

  const drawer = opened && (
    <ImagePreviewGroup isolated>
      <ReviewEvidenceDrawer
        anchorRef={rootRef}
        keepOpenRef={reviewOnly
          ? opened.run.target?.kind === "accepted_merge" ? postMergeReviewListRef : reviewListRef
          : workflowListRef}
        title={opened.run.target?.kind === "accepted_merge"
          ? `合并结果审查 · ${opened.run.target.mergeCommit.slice(0, 8)}`
          : `第 ${opened.round.round} 轮审查`}
        subtitle={`${reviewRoundLabel(opened.round)} · ${opened.run.reviewerName} · ${opened.run.checkMode === "logic" ? "逻辑检查" : "语法检查"}`}
        onClose={() => setSelectedReviewKey(null)}
        footer={opened.round.screenshots.length ? (
          <ReviewScreenshotStrip items={opened.round.screenshots.map((name) => ({
            key: name,
            name,
            src: api.freeReviewFileUrl(task.id, opened.run.id, opened.round.round, name),
            label: `第 ${opened.round.round} 轮 · ${name}`,
          }))} />
        ) : undefined}
      >
        <div className="review-round-body">
          {opened.round.reportMarkdown ? <MarkdownBody text={opened.round.reportMarkdown} /> : <p>报告尚未生成。</p>}
        </div>
      </ReviewEvidenceDrawer>
    </ImagePreviewGroup>
  );

  if (reviewOnly) {
    return (
      <>
        <div className="review-inspector free-workflow-review-inspector" aria-label="自由任务审查" ref={rootRef}>
          {acceptedTarget && (
            <section className="post-merge-review-card" aria-label="合并结果审查">
              <header>
                <span><GitCommit size={13} /></span>
                <div>
                  <b>合并结果</b>
                  <small>{acceptedTarget.branch} · {acceptedTarget.baseCommit.slice(0, 8)} → {acceptedTarget.mergeCommit.slice(0, 8)}</small>
                </div>
                <em>可选</em>
              </header>
              <p>{latestPostMerge?.status === "reviewing"
                ? "正在冻结的验收快照上审查，原任务仍保持已验收。"
                : latestPostMerge?.status === "passed"
                  ? "最近一次合并结果审查已通过。"
                  : latestPostMerge?.status === "stopped"
                    ? "最近一次审查未通过；可另建修复任务，不会重开原任务。"
                    : latestPostMerge?.status === "failed"
                      ? "最近一次审查异常停止，可重新发起。"
                      : "需要时再检查最终集成状态，不影响已完成验收。"}</p>
              <div>
                {latestPostMergeRound && (
                  <button type="button" onClick={openLatestPostMerge}>
                    <MagnifyingGlass size={12} />{latestPostMerge?.status === "reviewing" ? "查看审查进度" : "查看审查结果"}
                  </button>
                )}
                {latestPostMerge?.status === "stopped" && !postMergeRepairTaskId && onOpenTask && (
                  <button type="button" disabled={repairBusy} onClick={() => void createPostMergeRepair()}>
                    {repairBusy ? <SpinnerGap size={12} className="is-spinning" /> : <Wrench size={12} />}{repairBusy ? "创建中…" : "创建修复任务"}
                  </button>
                )}
                {postMergeRepairTaskId && onOpenTask && (
                  <button type="button" onClick={() => onOpenTask(postMergeRepairTaskId)}><CaretRight size={12} />打开修复任务</button>
                )}
                {latestPostMerge?.status !== "reviewing" && (
                  <button type="button" onClick={() => setPostMergeDialogOpen(true)}>
                    <MagnifyingGlass size={12} />{latestPostMerge ? "再审一次" : "开始审查"}
                  </button>
                )}
              </div>
            </section>
          )}
          <section className="review-inspector__overview">
            <header>
              <span className={`review-inspector__status${overviewStatus ? ` is-${overviewStatus}` : latestReview?.round.conclusion ? ` is-${latestReview.round.conclusion}` : ""}`}>
                {repairing
                  ? <SpinnerGap size={13} className="is-spinning" />
                  : stale
                    ? <MagnifyingGlass size={13} />
                    : latestReview ? reviewStatusIcon(latestReview.round) : <MagnifyingGlass size={13} />}
              </span>
              <div>
                <b>{workspaceReviewActivities.length ? `${workspaceReviewActivities.length} 轮审查` : "实现阶段审查"}</b>
                <small>{overviewDetail}</small>
              </div>
            </header>
            <div className="review-inspector__actions">
              {repairing && <FreeReviewProgress kind={view.autoRereview ? "auto_rereview" : "task_running"} />}
              {stoppedRun && !taskBusy && view.freshness === "fresh" && notify && (
                <FreeReviewRepairButton
                  taskId={task.id}
                  run={stoppedRun}
                  className="is-repair"
                  disabled={!taskReady || locked || waiting}
                  onChanged={free.setState}
                  notify={notify}
                />
              )}
              {!locked && <button
                type="button"
                disabled={!taskReady || locked || !!reviewing || !notify || (waiting && !reservationArmed)}
                onClick={() => setReviewDialogOpen(true)}
              >
                {reviewing ? <SpinnerGap size={13} className="is-spinning" /> : <MagnifyingGlass size={13} />}
                <span>{reviewActionLabel}</span>
              </button>}
              {onOpenReview && <button type="button" onClick={onOpenReview}><span>打开改动工作区</span><CaretRight size={13} /></button>}
            </div>
          </section>

          <section className="review-inspector__targets" aria-label="自由审查轮次">
            <header>
              <b>审查记录</b>
              <small>{workspaceReviewActivities.length ? `已记录 ${workspaceReviewActivities.length} 轮审查，点开在左侧看报告与截图` : "结论、报告与截图集中保存在这里"}</small>
            </header>
            <div ref={reviewListRef}>
              {!workspaceReviewActivities.length && <p className="review-inspector__empty">{locked ? "该任务在验收前没有实现阶段审查记录。" : "点击上方“派审查”，选择审查者、检查类型和自动复审次数。"}</p>}
              {workspaceReviewActivities.map((activity) => {
                const key = reviewKey(activity.run.id, activity.round.round);
                const failed = activity.round.status !== "reviewing" && activity.round.conclusion !== "verified";
                return (
                  <button
                    type="button"
                    key={key}
                    className={key === selectedReviewKey ? "is-selected" : failed ? "is-failed" : ""}
                    aria-expanded={key === selectedReviewKey}
                    onClick={() => selectReview(activity.run, activity.round)}
                  >
                    <span>
                      <b>第 {activity.round.round} 轮</b>
                      <small>{activity.run.reviewerName} · {activity.run.checkMode === "logic" ? "逻辑检查" : "语法检查"} · {timing(activity.round.startedAt, activity.round.endedAt)}</small>
                    </span>
                    <em>{reviewStatusIcon(activity.round)}{reviewRoundLabel(activity.round)}</em>
                  </button>
                );
              })}
            </div>
          </section>
          {postMergeReviewActivities.length > 0 && (
            <section className="review-inspector__targets post-merge-review-records" aria-label="合并结果审查记录">
              <header><b>合并结果审查</b><small>固定针对验收快照；失败不会重开原任务</small></header>
              <div ref={postMergeReviewListRef}>
                {postMergeReviewActivities.map((activity) => {
                  const key = reviewKey(activity.run.id, activity.round.round);
                  const failed = activity.round.status !== "reviewing" && activity.round.conclusion !== "verified";
                  return (
                    <button type="button" key={key} className={key === selectedReviewKey ? "is-selected" : failed ? "is-failed" : ""} aria-expanded={key === selectedReviewKey} onClick={() => selectReview(activity.run, activity.round)}>
                      <span><b>{activity.run.target?.kind === "accepted_merge" ? `${activity.run.target.branch}@${activity.run.target.mergeCommit.slice(0, 8)}` : "验收快照"}</b><small>{activity.run.reviewerName} · {timing(activity.round.startedAt, activity.round.endedAt)}</small></span>
                      <em>{reviewStatusIcon(activity.round)}{reviewRoundLabel(activity.round)}</em>
                    </button>
                  );
                })}
              </div>
            </section>
          )}
        </div>
        {drawer}
        {reviewDialogOpen && notify && (
          <FreeReviewDialog
            taskId={task.id}
            state={state}
            reservationMode={reservationMode}
            onChanged={free.setState}
            onClose={() => setReviewDialogOpen(false)}
            notify={notify}
          />
        )}
        {postMergeDialogOpen && notify && acceptedTarget && (
          <FreeReviewDialog taskId={task.id} state={state} reservationMode={false} postMergeTarget={acceptedTarget} onChanged={free.setState} onClose={() => setPostMergeDialogOpen(false)} notify={notify} />
        )}
      </>
    );
  }

  return (
    <>
      <div className="free-workflow-inspector" ref={rootRef}>
        <section className="free-workflow-generated">
          <header><span>根据实际情况生成</span><small>这里不预判下一步，只记录真正发生过的操作。</small></header>
          <ol ref={workflowListRef}>
            {activities.map((activity) => {
              if (activity.type === "execution") {
                const running = activity.execution.status === "running";
                const warning = activity.execution.status !== "completed" && !running;
                return <li key={activity.key} className={running ? "is-active" : warning ? "is-warning" : "is-done"}>
                  <span>{running ? <SpinnerGap size={14} className="is-spinning" /> : warning ? <WarningCircle size={14} /> : <CheckCircle size={14} weight="fill" />}</span>
                  <div><b>任务执行</b><small>{executionLabel(activity.execution)} · {timing(activity.execution.startedAt, activity.execution.endedAt)}</small></div>
                </li>;
              }
              if (activity.type === "review") {
                const active = activity.round.status === "reviewing";
                const passed = activity.round.conclusion === "verified";
                const key = reviewKey(activity.run.id, activity.round.round);
                return <li key={activity.key} className={active ? "is-active" : passed ? "is-done" : "is-warning"}>
                  <button type="button" aria-expanded={selectedReviewKey === key} onClick={() => selectReview(activity.run, activity.round)}>
                    <span>{active ? <SpinnerGap size={14} className="is-spinning" /> : passed ? <CheckCircle size={14} weight="fill" /> : <MagnifyingGlass size={14} />}</span>
                    <div><b>{activity.run.reviewerName} · {activity.run.checkMode === "logic" ? "逻辑检查" : "语法检查"}</b><small>{reviewRoundLabel(activity.round)} · 第 {activity.round.round} 轮 / 最多 {activity.run.retryLimit + 1} 轮 · {timing(activity.round.startedAt, activity.round.endedAt)}</small></div>
                  </button>
                </li>;
              }
              if (activity.type === "preview") {
                const active = activity.event.kind === "preview_opened" && latestPreviewEvent?.id === activity.event.id && !!state?.preview.running;
                return <li key={activity.key} className={active ? "is-active" : "is-done"}>
                  <span>{activity.event.kind === "preview_opened" ? <MonitorPlay size={14} /> : <StopCircle size={14} />}</span>
                  <div><b>{activity.event.kind === "preview_opened" ? "预览已打开" : "预览已关闭"}</b><small>{activity.event.detail} · {timeText(activity.event.occurredAt)}</small></div>
                </li>;
              }
            })}
          </ol>
          {!activities.length && <p>目前还没有实际工作流记录；任务执行、派审或预览后，这里会按发生顺序补出记录。</p>}
        </section>
      </div>
      {drawer}
    </>
  );
}
