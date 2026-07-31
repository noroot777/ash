import { useEffect, useMemo, useState } from "react";
import { STAGE_LABELS, TASK_STATUS_LABELS, type Task } from "@harness/shared";
import {
  CaretRight,
  CheckCircle,
  MagnifyingGlass,
  WarningCircle,
} from "@phosphor-icons/react";
import { ReviewEvidence, useTaskReviewInfo } from "./ReviewEvidence.tsx";

function reviewPriority(task: Task) {
  if (task.stage === "verify_failed") return 0;
  if (task.stage === "verifying") return 1;
  if (task.reviewRequested || task.stage === "verified") return 2;
  return 3;
}

function reviewLabel(task: Task) {
  if (task.stage) return STAGE_LABELS[task.stage];
  if (task.reviewRequested) return "等待自动审查";
  return TASK_STATUS_LABELS[task.status];
}

function targetRole(task: Task, leadId: string, index: number) {
  if (task.id === leadId) return "调度台";
  return `执行者 ${index}`;
}

export function TeamReviewInspector({
  lead,
  workers,
  onOpenReview,
  onOpenTask,
}: {
  lead: Task;
  workers: Task[];
  onOpenReview: () => void;
  onOpenTask: (taskId: string) => void;
}) {
  const targets = useMemo(() => [lead, ...workers], [lead, workers]);
  const reviewTargets = useMemo(() => workers.length ? workers : [lead], [lead, workers]);
  const preferredId = useMemo(
    () => [...reviewTargets].sort((left, right) => reviewPriority(left) - reviewPriority(right))[0]?.id ?? lead.id,
    [lead.id, reviewTargets],
  );
  const [selectedId, setSelectedId] = useState(preferredId);

  useEffect(() => {
    setSelectedId((current) => targets.some((task) => task.id === current) ? current : preferredId);
  }, [preferredId, targets]);

  const selected = targets.find((task) => task.id === selectedId) ?? lead;
  const selectedIndex = workers.findIndex((worker) => worker.id === selected.id) + 1;
  const review = useTaskReviewInfo(selected.id);
  const latest = review.info?.rounds.at(-1);
  const completed = reviewTargets.filter((task) => task.stage === "verified" || task.stage === "accepted").length;
  const failed = reviewTargets.filter((task) => task.stage === "verify_failed").length;

  return (
    <div className="review-inspector team-review-inspector" aria-label="团队审查">
      <section className="review-inspector__overview">
        <header>
          <span className={`review-inspector__status${failed ? " is-verify_failed" : completed ? " is-verified" : ""}`}>
            {failed
              ? <WarningCircle size={13} weight="fill" />
              : completed
                ? <CheckCircle size={13} weight="fill" />
                : <MagnifyingGlass size={13} />}
          </span>
          <div>
            <b>{failed ? `${failed} 项未通过` : "团队审查"}</b>
            <small>{completed} 项已验证 · {workers.length} 个执行者</small>
          </div>
        </header>
        <div className="review-inspector__actions">
          <button type="button" onClick={onOpenReview}><span>打开团队改动工作区</span><CaretRight size={13} /></button>
        </div>
      </section>

      <section className="team-review-inspector__targets" aria-label="团队审查对象">
        <header><b>审查对象</b><small>选择调度台或执行者查看各自轮次与证据</small></header>
        <div>
          {targets.map((target, index) => {
            const role = targetRole(target, lead.id, index);
            return (
              <button
                type="button"
                key={target.id}
                className={target.id === selected.id ? "is-selected" : target.stage === "verify_failed" ? "is-failed" : ""}
                onClick={() => setSelectedId(target.id)}
              >
                <span><b>{target.title}</b><small>{role}</small></span>
                <em>{reviewLabel(target)}</em>
              </button>
            );
          })}
        </div>
      </section>

      <div className="review-inspector__evidence">
        <ReviewEvidence
          taskId={selected.id}
          state={review}
          title={`${targetRole(selected, lead.id, selectedIndex)}审查记录`}
          emptyMessage={selected.reviewRequested ? "已请求自动审查，等待首轮结果。" : "这个对象尚无审查记录。"}
          onOpenTask={onOpenTask}
        />
        {latest?.conclusion === "verify_failed" && (
          <p className="review-inspector__notice is-warning">最近一轮未通过；修复与复审应回到对应任务继续处理。</p>
        )}
      </div>
    </div>
  );
}
