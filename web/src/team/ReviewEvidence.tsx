import { useCallback, useEffect, useState, type ReactNode } from "react";
import { TASK_STATUS_LABELS, type TaskListItem, type TaskReviewInfo, type TaskReviewRound } from "@ash/shared";
import {
  ArrowSquareOut,
  CaretDown,
  CheckCircle,
  ImageSquare,
  SpinnerGap,
  WarningCircle,
} from "@phosphor-icons/react";
import { ImagePreviewGroup, PreviewableImage } from "../components/ImagePreview.tsx";
import { MarkdownBody } from "../components/MarkdownBody.tsx";
import { api } from "../lib/api.ts";
import { useServerEvents } from "../lib/events.ts";
import { ReviewDispatchControl } from "../review/ReviewDispatchControl.tsx";
import { useTaskReviewInfo as useDispatchReviewInfo } from "../review/useTaskReviewInfo.ts";

const REVIEW_IN_FLIGHT = new Set(["backlog", "queued", "running", "paused"]);

export interface TaskReviewState {
  info: TaskReviewInfo | null;
  loading: boolean;
  error: string | null;
  reload: (quiet?: boolean) => Promise<void>;
}

export function useTaskReviewInfo(taskId: string): TaskReviewState {
  const [info, setInfo] = useState<TaskReviewInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      setInfo(await api.taskReview(taskId));
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    setInfo(null);
    setError(null);
    void reload();
  }, [reload]);
  useServerEvents(useCallback((event) => {
    if ((event.type === "task.review" || event.type === "task.stage") && event.taskId === taskId) {
      void reload(true);
    }
  }, [reload, taskId]));

  return { info, loading, error, reload };
}

export function roundState(round: TaskReviewRound) {
  if (round.conclusion === "verified") {
    return { className: "is-verified", label: "已通过", icon: <CheckCircle size={11} weight="fill" /> };
  }
  if (round.conclusion === "verify_failed") {
    return { className: "is-verify-failed", label: "未通过", icon: <WarningCircle size={11} weight="fill" /> };
  }
  if (REVIEW_IN_FLIGHT.has(round.reviewTaskStatus)) {
    return { className: "is-verifying", label: "进行中", icon: <SpinnerGap size={11} className="is-spinning" /> };
  }
  return { className: "is-inconclusive", label: "无结论", icon: <WarningCircle size={11} /> };
}

export function roundWhere(round: TaskReviewRound) {
  return round.where === "task" ? `独立审查 · ${TASK_STATUS_LABELS[round.reviewTaskStatus]}` : "就地验证";
}

// 一轮验证的正文：报告、证据截图、回到审查任务的出口。单拎出来是因为它有两个去处——
// 宽处（改动工作区）整篇铺开看，窄处（inspector 侧栏）塞不下，改由抽屉装着它。
export function ReviewRoundBody({
  taskId,
  round,
  onOpenTask,
  includeScreenshots = true,
}: {
  taskId: string;
  round: TaskReviewRound;
  onOpenTask?: (taskId: string) => void;
  includeScreenshots?: boolean;
}) {
  const reviewTaskId = round.reviewTaskId;
  return (
    <>
      {round.reportMarkdown ? <MarkdownBody text={round.reportMarkdown} /> : <p>验证报告尚未写入。</p>}
      {includeScreenshots && round.screenshots.length > 0 && (
        <section className="review-shots">
          <h5><ImageSquare size={12} />证据截图 · {round.screenshots.length}</h5>
          <div>
            {round.screenshots.map((name) => (
              <div className="review-shot" key={name}>
                <PreviewableImage
                  src={api.taskReviewFileUrl(taskId, round.round, name)}
                  alt={name}
                  label={`第 ${round.round} 轮 · ${name}`}
                  loading="lazy"
                />
                <span>{name}</span>
              </div>
            ))}
          </div>
        </section>
      )}
      {/* 就地验证没有另一个任务可打开（reviewTaskId 为 null），只有历史的独立审查轮才有。 */}
      {onOpenTask && reviewTaskId && (
        <button className="review-round__open-task" type="button" onClick={() => onOpenTask(reviewTaskId)}>
          打开审查任务<ArrowSquareOut size={12} />
        </button>
      )}
    </>
  );
}

function ReviewRound({
  taskId,
  round,
  onOpenTask,
}: {
  taskId: string;
  round: TaskReviewRound;
  onOpenTask?: (taskId: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const state = roundState(round);
  return (
    <article className={`review-round ${state.className}`}>
      <button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <span>{round.round}</span>
        <b>第 {round.round} 轮</b>
        <em>{state.icon}{state.label}</em>
        <small>{roundWhere(round)}</small>
        <CaretDown size={12} weight="bold" />
      </button>
      {open && (
        <div className="review-round-body">
          <ReviewRoundBody taskId={taskId} round={round} onOpenTask={onOpenTask} />
        </div>
      )}
    </article>
  );
}

export function ReviewEvidence({
  taskId,
  state,
  title = "验证记录",
  emptyMessage = "尚无验证记录。",
  onOpenTask,
  actions,
}: {
  taskId: string;
  state: TaskReviewState;
  title?: string;
  emptyMessage?: string;
  onOpenTask?: (taskId: string) => void;
  actions?: ReactNode;
}) {
  const rounds = state.info?.rounds ?? [];
  return (
    <ImagePreviewGroup isolated>
      <section className="review-evidence">
        <header>
          <div>
            <b>{title}</b>
            <small>{rounds.length ? `已记录 ${rounds.length} 轮真实运行验证` : "结论、报告与截图集中保存在这里"}</small>
          </div>
        </header>
        {state.loading && <p><SpinnerGap size={13} className="is-spinning" />正在读取验证记录…</p>}
        {!state.loading && state.error && (
          <p className="is-error">验证记录加载失败：{state.error} <button type="button" onClick={() => void state.reload()}>重试</button></p>
        )}
        {!state.loading && !state.error && !rounds.length && <p>{emptyMessage}</p>}
        {actions}
        {rounds.map((round) => (
          <ReviewRound
            key={`${round.round}-${round.where}`}
            taskId={taskId}
            round={round}
            onOpenTask={onOpenTask}
          />
        ))}
      </section>
    </ImagePreviewGroup>
  );
}

export function DispatchReviewEvidence({
  task,
  parentTask = null,
  notify,
}: {
  task: TaskListItem;
  parentTask?: TaskListItem | null;
  notify: (message: string) => void;
}) {
  const { info, loading, error, load } = useDispatchReviewInfo(task.id);
  const rounds = info?.rounds ?? [];
  const latestRound = rounds.at(-1);
  const dispatchProminent = !!error || rounds.length === 0 || latestRound?.conclusion === "verify_failed";
  const dispatchSupported = task.mode === "single" && !task.reviewOf && !task.archived;
  const emptyMessage = dispatchSupported
    ? task.status === "running" || task.status === "queued"
      ? "尚无验证记录；目标结束后可就地开始真实运行验证。"
      : "尚无验证记录，可立即开始一轮真实运行验证。"
    : "尚无验证记录。";

  return (
    <ReviewEvidence
      taskId={task.id}
      state={{ info, loading, error, reload: load }}
      title="验证证据"
      emptyMessage={emptyMessage}
      actions={!loading ? (
        <ReviewDispatchControl
          task={task}
          parentTask={parentTask}
          rounds={rounds}
          prominent={dispatchProminent}
          notify={notify}
          onRefresh={() => load(true)}
        />
      ) : undefined}
    />
  );
}
