import { useMemo, useRef, useState } from "react";
import type {
  FreeReviewRound,
  FreeReviewRun,
  FreeWorkflowExecution,
  FreeWorkflowPreviewEvent,
  FreeWorkflowState,
  Task,
} from "@harness/shared";
import {
  CaretRight,
  CheckCircle,
  MagnifyingGlass,
  MonitorPlay,
  SpinnerGap,
  StopCircle,
  WarningCircle,
} from "@phosphor-icons/react";
import { ImagePreviewGroup } from "../components/ImagePreview.tsx";
import { MarkdownBody } from "../components/MarkdownBody.tsx";
import { api } from "../lib/api.ts";
import { ReviewEvidenceDrawer } from "../review/ReviewEvidenceDrawer.tsx";
import { ReviewScreenshotStrip } from "../review/ReviewScreenshotStrip.tsx";
import { FreeReviewDialog } from "./FreeReviewDialog.tsx";
import { useFreeWorkflowState } from "./useFreeWorkflowState.ts";

type Activity =
  | { type: "execution"; at: string; key: string; execution: FreeWorkflowExecution }
  | { type: "review"; at: string; key: string; run: FreeReviewRun; round: FreeReviewRound }
  | { type: "preview"; at: string; key: string; event: FreeWorkflowPreviewEvent };

type ReviewActivity = Extract<Activity, { type: "review" }>;

function actualActivities(state: FreeWorkflowState | null): Activity[] {
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
  notify,
}: {
  task: Task;
  reviewOnly?: boolean;
  onOpenReview?: () => void;
  notify?: (message: string) => void;
}) {
  const free = useFreeWorkflowState(task.id);
  const [selectedReviewKey, setSelectedReviewKey] = useState<string | null>(null);
  const [reviewDialogOpen, setReviewDialogOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const workflowListRef = useRef<HTMLOListElement>(null);
  const reviewListRef = useRef<HTMLDivElement>(null);
  const state = free.state;
  const reviews = state?.reviews ?? [];
  const activities = useMemo(() => actualActivities(state), [state]);
  const latestPreviewEvent = state?.previewEvents.at(-1);
  const reviewActivities = activities.filter((activity): activity is ReviewActivity => activity.type === "review");
  const opened = selectedReviewKey
    ? reviewActivities.find((activity) => reviewKey(activity.run.id, activity.round.round) === selectedReviewKey) ?? null
    : null;
  const latestReview = reviewActivities.at(-1);
  const activeReview = reviews.find((run) => run.status === "reviewing" || run.status === "repairing");
  const reviewArmed = !!state?.reviewReservation?.armed && !activeReview;
  const taskBusy = task.status === "running" || task.status === "queued";
  const taskReady = task.status !== "backlog";
  const accepted = task.stage === "accepted" || task.stage === "merged";

  if (free.loading && !free.state) return <div className="free-workflow-inspector is-loading"><SpinnerGap size={14} className="is-spinning" />正在生成实际工作流…</div>;
  if (free.error && !free.state) return <div className="free-workflow-inspector is-loading is-error"><WarningCircle size={14} />{free.error}</div>;

  const selectReview = (run: FreeReviewRun, round: FreeReviewRound) => {
    const key = reviewKey(run.id, round.round);
    setSelectedReviewKey((current) => current === key ? null : key);
  };

  const drawer = opened && (
    <ImagePreviewGroup isolated>
      <ReviewEvidenceDrawer
        anchorRef={rootRef}
        keepOpenRef={reviewOnly ? reviewListRef : workflowListRef}
        title={`第 ${opened.round.round} 轮审查`}
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
          <section className="review-inspector__overview">
            <header>
              <span className={`review-inspector__status${latestReview?.round.conclusion ? ` is-${latestReview.round.conclusion}` : ""}`}>
                {latestReview ? reviewStatusIcon(latestReview.round) : <MagnifyingGlass size={13} />}
              </span>
              <div>
                <b>{reviewActivities.length ? `${reviewActivities.length} 轮审查` : "自由审查"}</b>
                <small>{latestReview ? `最近一轮${reviewRoundLabel(latestReview.round)}` : "尚未派审"}</small>
              </div>
            </header>
            <div className="review-inspector__actions">
              <button
                type="button"
                disabled={!taskReady || accepted || !!activeReview || !notify}
                onClick={() => setReviewDialogOpen(true)}
              >
                {activeReview ? <SpinnerGap size={13} className="is-spinning" /> : <MagnifyingGlass size={13} />}
                <span>{activeReview?.status === "reviewing" ? "审查进行中" : activeReview?.status === "repairing" ? "等待修复" : reviewArmed ? "调整预约审查" : reviewActivities.length ? "再审一轮" : "派审查"}</span>
              </button>
              {onOpenReview && <button type="button" onClick={onOpenReview}><span>打开改动工作区</span><CaretRight size={13} /></button>}
            </div>
          </section>

          <section className="review-inspector__targets" aria-label="自由审查轮次">
            <header>
              <b>审查记录</b>
              <small>{reviewActivities.length ? `已记录 ${reviewActivities.length} 轮审查，点开在左侧看报告与截图` : "结论、报告与截图集中保存在这里"}</small>
            </header>
            <div ref={reviewListRef}>
              {!reviewActivities.length && <p className="review-inspector__empty">点击上方“派审查”，选择审查者、检查类型和自动复审次数。</p>}
              {reviewActivities.map((activity) => {
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
        </div>
        {drawer}
        {reviewDialogOpen && notify && (
          <FreeReviewDialog
            taskId={task.id}
            state={state}
            reservationMode={taskBusy || reviewArmed}
            onChanged={free.setState}
            onClose={() => setReviewDialogOpen(false)}
            notify={notify}
          />
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
