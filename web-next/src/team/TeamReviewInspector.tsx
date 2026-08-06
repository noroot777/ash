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
  const all = useMemo(() => [lead, ...workers], [lead, workers]);
  // 审查记录**只挂在被审任务身上**（`GET /tasks/:id/review` 读的是「谁验过我」）。
  // 团队历史上会为每个执行者另派一个「审查:xxx」任务（`reviewOf` 指向被审者），于是
  // 同一件事在这份列表里出两条，而点「审查:」那条永远是空的——记录不在它身上。
  // 所以：被审过的任务不再单列，由审查执行者那条代表它，证据照着 `reviewOf` 去读。
  // 就地验证的团队没有审查任务（reviewedIds 为空），这条规则自然不生效，列表照旧。
  const reviewedIds = useMemo(
    () => new Set(all.map((task) => task.reviewOf).filter((id): id is string => !!id)),
    [all],
  );
  const byId = useMemo(() => new Map(all.map((task) => [task.id, task])), [all]);
  const subjectOf = useMemo(
    () => (task: Task) => (task.reviewOf ? byId.get(task.reviewOf) : null) ?? task,
    [byId],
  );
  const targets = useMemo(() => all.filter((task) => !reviewedIds.has(task.id)), [all, reviewedIds]);
  // 执行者编号按原始派活顺序固定，过滤之后也不重排——用户在执行者栏看到的是同一个号。
  const workerIndex = useMemo(() => new Map(workers.map((worker, index) => [worker.id, index + 1])), [workers]);
  const roleOf = useMemo(
    () => (task: Task) => {
      if (task.id === lead.id) return "调度台";
      if (task.reviewOf) {
        const index = workerIndex.get(task.reviewOf);
        return index ? `审查 · 执行者 ${index}` : "审查执行者";
      }
      return `执行者 ${workerIndex.get(task.id) ?? ""}`.trim();
    },
    [lead.id, workerIndex],
  );

  const reviewTargets = useMemo(() => targets.filter((task) => task.id !== lead.id), [lead.id, targets]);
  const ranked = reviewTargets.length ? reviewTargets : targets;
  const preferredId = useMemo(
    () => [...ranked].sort((left, right) => reviewPriority(subjectOf(left)) - reviewPriority(subjectOf(right)))[0]?.id ?? lead.id,
    [lead.id, ranked, subjectOf],
  );
  const [selectedId, setSelectedId] = useState(preferredId);

  useEffect(() => {
    setSelectedId((current) => targets.some((task) => task.id === current) ? current : preferredId);
  }, [preferredId, targets]);

  const selected = targets.find((task) => task.id === selectedId) ?? lead;
  const subject = subjectOf(selected);
  const review = useTaskReviewInfo(subject.id);
  const latest = review.info?.rounds.at(-1);
  const completed = ranked.filter((task) => {
    const stage = subjectOf(task).stage;
    return stage === "verified" || stage === "accepted";
  }).length;
  const failed = ranked.filter((task) => subjectOf(task).stage === "verify_failed").length;

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
            <small>{completed} 项已验证 · {ranked.length} 个审查对象</small>
          </div>
        </header>
        <div className="review-inspector__actions">
          <button type="button" onClick={onOpenReview}><span>打开团队改动工作区</span><CaretRight size={13} /></button>
        </div>
      </section>

      <section className="team-review-inspector__targets" aria-label="团队审查对象">
        <header><b>审查对象</b><small>{reviewedIds.size ? "审查执行者代表它审的那个执行者，点开看轮次与证据" : "选择调度台或执行者查看各自轮次与证据"}</small></header>
        <div>
          {targets.map((target) => {
            const targetSubject = subjectOf(target);
            return (
              <button
                type="button"
                key={target.id}
                className={target.id === selected.id ? "is-selected" : targetSubject.stage === "verify_failed" ? "is-failed" : ""}
                onClick={() => setSelectedId(target.id)}
              >
                <span><b>{target.title}</b><small>{roleOf(target)}</small></span>
                <em>{reviewLabel(targetSubject)}</em>
              </button>
            );
          })}
        </div>
      </section>

      <div className="review-inspector__evidence">
        <ReviewEvidence
          taskId={subject.id}
          state={review}
          title={`${roleOf(selected)}审查记录`}
          emptyMessage={subject.reviewRequested ? "已请求自动审查，等待首轮结果。" : "这个对象尚无审查记录。"}
          onOpenTask={onOpenTask}
        />
        {latest?.conclusion === "verify_failed" && (
          <p className="review-inspector__notice is-warning">最近一轮未通过；修复与复审应回到对应任务继续处理。</p>
        )}
      </div>
    </div>
  );
}
