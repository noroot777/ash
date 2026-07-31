import { useCallback, useEffect, useState } from "react";
import { TASK_STATUS_LABELS, type Task, type TaskReviewInfo } from "@harness/shared";
import {
  ArrowSquareOut,
  CaretRight,
  CheckCircle,
  MagnifyingGlass,
  SpinnerGap,
  WarningCircle,
} from "@phosphor-icons/react";
import { api } from "../lib/api.ts";
import { useServerEvents } from "../lib/events.ts";
import { ReviewEvidence } from "../team/ReviewEvidence.tsx";

const REVIEW_IN_FLIGHT = new Set(["backlog", "queued", "running", "paused"]);

function dispatchBlockedReason(task: Task, active: boolean): string | null {
  if (task.reviewOf) return "审查任务自身不能再派审。";
  if (task.archived) return "归档任务不能派审。";
  if (task.status === "running" || task.status === "queued") return "任务结束运行或排队后才能派审。";
  if (active) return "已有一轮审查正在进行。";
  return null;
}

export function TaskReviewInspector({
  task,
  onOpenTask,
  onOpenReview,
  notify,
}: {
  task: Task;
  onOpenTask: (taskId: string) => void;
  onOpenReview: () => void;
  notify: (message: string) => void;
}) {
  const [info, setInfo] = useState<TaskReviewInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [dispatching, setDispatching] = useState(false);

  const load = useCallback(async () => {
    try {
      setInfo(await api.taskReview(task.id));
    } catch {
      setInfo(null);
    } finally {
      setLoading(false);
    }
  }, [task.id]);

  useEffect(() => {
    setInfo(null);
    setLoading(true);
    void load();
  }, [load]);
  useServerEvents(useCallback((event) => {
    if ((event.type === "task.review" || event.type === "task.stage") && event.taskId === task.id) void load();
  }, [load, task.id]));

  const rounds = info?.rounds ?? [];
  const latest = rounds.at(-1);
  const activeRound = rounds.find((round) => REVIEW_IN_FLIGHT.has(round.reviewTaskStatus));
  const blockedReason = dispatchBlockedReason(task, !!activeRound);
  const statusLabel = loading ? "正在读取"
    : latest?.conclusion === "verified"
    ? "已通过"
    : latest?.conclusion === "verify_failed"
      ? "未通过"
      : latest ? TASK_STATUS_LABELS[latest.reviewTaskStatus] : info?.reviewRequested ? "等待审查" : "尚未审查";

  const dispatch = async () => {
    if (loading || blockedReason || dispatching) return;
    setDispatching(true);
    try {
      const { reviewTask } = await api.dispatchTaskReview(task.id, {});
      await load();
      notify(`已派出第 ${reviewTask.reviewRound ?? rounds.length + 1} 轮审查`);
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setDispatching(false);
    }
  };

  return (
    <div className="task-review-inspector" aria-label="任务审查">
      <section className="task-review-inspector__overview">
        <header>
          <span className={`task-review-inspector__status${latest?.conclusion ? ` is-${latest.conclusion}` : ""}`}>
            {latest?.conclusion === "verified" ? <CheckCircle size={13} weight="fill" /> : latest?.conclusion === "verify_failed" ? <WarningCircle size={13} weight="fill" /> : <MagnifyingGlass size={13} />}
          </span>
          <div><b>{rounds.length ? `${rounds.length} 轮审查` : "独立审查"}</b><small>{statusLabel}</small></div>
        </header>
        <div className="task-review-inspector__actions">
          <button type="button" disabled={loading || !!blockedReason || dispatching} onClick={() => void dispatch()}>
            {loading || dispatching || activeRound ? <SpinnerGap size={13} className="is-spinning" /> : <MagnifyingGlass size={13} />}
            {loading ? "读取中" : dispatching ? "派发中" : activeRound ? "审查进行中" : "派审查"}
          </button>
          <button type="button" onClick={onOpenReview}><span>进入审查工作区</span><CaretRight size={13} /></button>
          {latest && (
            <button type="button" onClick={() => onOpenTask(latest.reviewTaskId)}>
              <span>打开第 {latest.round} 轮审查任务</span><ArrowSquareOut size={13} />
            </button>
          )}
        </div>
        {blockedReason && <p>{blockedReason}</p>}
      </section>
      <div className="task-review-inspector__evidence">
        <ReviewEvidence taskId={task.id} />
      </div>
    </div>
  );
}
