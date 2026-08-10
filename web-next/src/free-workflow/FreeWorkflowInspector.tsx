import { useEffect, useMemo, useRef, useState } from "react";
import type {
  FreeReviewRound,
  FreeReviewRun,
  FreeWorkflowExecution,
  FreeWorkflowPreviewEvent,
  FreeWorkflowState,
  Task,
} from "@harness/shared";
import { CheckCircle, GitMerge, MagnifyingGlass, MonitorPlay, SpinnerGap, StopCircle, WarningCircle } from "@phosphor-icons/react";
import { ImagePreviewGroup, PreviewableImage } from "../components/ImagePreview.tsx";
import { MarkdownBody } from "../components/MarkdownBody.tsx";
import { api } from "../lib/api.ts";
import { FREE_REVIEW_RUN_LABELS } from "./freeReviewCopy.ts";
import { useFreeWorkflowState } from "./useFreeWorkflowState.ts";

type Activity =
  | { type: "execution"; at: string; key: string; execution: FreeWorkflowExecution }
  | { type: "review"; at: string; key: string; run: FreeReviewRun; round: FreeReviewRound }
  | { type: "preview"; at: string; key: string; event: FreeWorkflowPreviewEvent }
  | { type: "merge"; at: string; key: string; merge: FreeWorkflowState["merge"] };

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
  if (state.merge.status !== "idle" && state.merge.updatedAt) {
    activities.push({ type: "merge", at: state.merge.updatedAt, key: "merge", merge: state.merge });
  }
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

export function FreeWorkflowInspector({ task, reviewOnly = false }: { task: Task; reviewOnly?: boolean }) {
  const free = useFreeWorkflowState(task.id);
  const [dockOpen, setDockOpen] = useState(false);
  const [selectedReviewKey, setSelectedReviewKey] = useState<string | null>(null);
  const [openRunId, setOpenRunId] = useState<string | null>(null);
  const roundRefs = useRef(new Map<string, HTMLElement>());
  const state = free.state;
  const reviews = state?.reviews ?? [];
  const activities = useMemo(() => actualActivities(state), [state]);
  const latestPreviewEvent = state?.previewEvents.at(-1);
  const reviewActivities = activities.filter((activity): activity is Extract<Activity, { type: "review" }> => activity.type === "review");

  useEffect(() => {
    if (!dockOpen || !selectedReviewKey) return;
    const frame = requestAnimationFrame(() => roundRefs.current.get(selectedReviewKey)?.scrollIntoView({ block: "nearest" }));
    return () => cancelAnimationFrame(frame);
  }, [dockOpen, selectedReviewKey]);

  if (free.loading && !free.state) return <div className="free-workflow-inspector is-loading"><SpinnerGap size={14} className="is-spinning" />正在生成实际工作流…</div>;
  if (free.error && !free.state) return <div className="free-workflow-inspector is-loading is-error"><WarningCircle size={14} />{free.error}</div>;

  const selectReview = (run: FreeReviewRun, round: FreeReviewRound) => {
    const key = reviewKey(run.id, round.round);
    if (dockOpen && selectedReviewKey === key) {
      setDockOpen(false);
      setOpenRunId(null);
      return;
    }
    setSelectedReviewKey(key);
    setOpenRunId(run.id);
    setDockOpen(true);
  };

  const toggleDock = () => {
    if (dockOpen) {
      setDockOpen(false);
      setOpenRunId(null);
      return;
    }
    const latest = reviewActivities.at(-1);
    if (latest) {
      setSelectedReviewKey(reviewKey(latest.run.id, latest.round.round));
      setOpenRunId(latest.run.id);
    }
    setDockOpen(true);
  };

  return (
    <div className={`free-workflow-inspector${reviewOnly ? " is-review-only" : " has-review-dock"}`}>
      {!reviewOnly && (
        <section className="free-workflow-generated">
          <header><span>根据实际情况生成</span><small>这里不预判下一步，只记录真正发生过的操作。</small></header>
          <ol>
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
                return <li key={activity.key} className={active ? "is-active" : passed ? "is-done" : "is-warning"}>
                  <button type="button" aria-expanded={dockOpen && selectedReviewKey === reviewKey(activity.run.id, activity.round.round)} onClick={() => selectReview(activity.run, activity.round)}>
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
              return <li key={activity.key} className={activity.merge.status === "merged" ? "is-done" : activity.merge.status === "failed" ? "is-warning" : "is-active"}>
                <span><GitMerge size={14} /></span><div><b>合并&清理</b><small>{activity.merge.message ?? "处理中"} · {timeText(activity.at)}</small></div>
              </li>;
            })}
          </ol>
          {!activities.length && <p>目前还没有实际工作流记录；任务执行、派审、预览或合并后，这里会按发生顺序补出记录。</p>}
        </section>
      )}

      <section className={`free-review-history${reviewOnly ? "" : ` is-docked${dockOpen ? " is-open" : ""}`}`}>
        {reviewOnly ? (
          <header><b>审查记录</b><small>{reviews.length ? `${reviews.length} 轮审查链` : "尚未派审"}</small></header>
        ) : (
          <header>
            <button className="free-review-history__dock-toggle" type="button" aria-expanded={dockOpen} onClick={toggleDock}>
              <b>审查记录</b><small>{reviews.length ? `${reviews.length} 轮审查链` : "尚未派审"}</small>
            </button>
          </header>
        )}
        <div className="free-review-history__records" inert={!reviewOnly && !dockOpen}>
          {!reviews.length && <p>点击会话上方的“派审查”，选择审查者、检查类型和自动复审次数。</p>}
          {reviews.map((run) => (
            <details
              key={run.id}
              open={reviewOnly ? undefined : dockOpen && openRunId === run.id}
              onToggle={reviewOnly ? undefined : (event) => {
                if (event.currentTarget.open) setOpenRunId(run.id);
                else if (openRunId === run.id) setOpenRunId(null);
              }}
            >
              <summary><span><b>{run.reviewerName}</b><small>{run.checkMode === "logic" ? "逻辑检查" : "语法检查"} · {FREE_REVIEW_RUN_LABELS[run.status]}</small></span><em>{run.rounds.length} 轮</em></summary>
              <div>
                {run.rounds.map((round) => {
                  const key = reviewKey(run.id, round.round);
                  return (
                    <article key={round.round} ref={(node) => { if (node) roundRefs.current.set(key, node); else roundRefs.current.delete(key); }}>
                      <header><b>第 {round.round} 轮</b><span>{reviewRoundLabel(round)} · {timing(round.startedAt, round.endedAt)}</span></header>
                      <ImagePreviewGroup isolated>
                        {round.reportMarkdown ? <MarkdownBody text={round.reportMarkdown} /> : <p>报告尚未生成。</p>}
                        {!!round.screenshots.length && (
                          <div className="free-review-screenshots">
                            {round.screenshots.map((name) => (
                              <div key={name}>
                                <PreviewableImage
                                  src={api.freeReviewFileUrl(task.id, run.id, round.round, name)}
                                  alt={name}
                                  label={`第 ${round.round} 轮 · ${name}`}
                                  loading="lazy"
                                />
                                <span>{name}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </ImagePreviewGroup>
                    </article>
                  );
                })}
              </div>
            </details>
          ))}
        </div>
      </section>
    </div>
  );
}
