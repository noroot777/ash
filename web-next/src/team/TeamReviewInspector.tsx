import { useMemo, useRef, useState } from "react";
import { STAGE_LABELS, TASK_STATUS_LABELS, type Task } from "@harness/shared";
import {
  CaretRight,
  CheckCircle,
  MagnifyingGlass,
  WarningCircle,
} from "@phosphor-icons/react";
import { ReviewEvidence, useTaskReviewInfo } from "./ReviewEvidence.tsx";
import { ReviewEvidenceDrawer } from "./ReviewEvidenceDrawer.tsx";

function reviewLabel(task: Task) {
  if (task.stage) return STAGE_LABELS[task.stage];
  if (task.reviewRequested) return "等待自动审查";
  return TASK_STATUS_LABELS[task.status];
}

// 这一条决定「点开有没有东西看」：要么另派了审查执行者（`reviewOf` 指向被审者），要么
// 自己走过就地验证轮（stage 落在验证三态）或已请求自动审查。
//
// 判据里**没有** `accepted`：团队整体验收会把每个执行者连同调度台一起标成「验收完成」，
// 那是验收痕迹不是验证痕迹。照它列出来，列表里就会混进一堆点开只有「尚无审查记录」的
// 执行者和调度台——用户看到的正是那一屏。被审对象自己的 accepted 不受影响：它由代表它
// 的那条审查任务带进列表，不走这条判据。
function hasReviewRecord(task: Task): boolean {
  if (task.reviewOf || task.reviewRequested) return true;
  return task.stage === "verifying" || task.stage === "verified" || task.stage === "verify_failed";
}

// 抽屉里这一份要单独成组件：只有开着的时候才去拉记录，关着不发请求。
function TargetEvidence({
  subject,
  onOpenTask,
}: {
  subject: Task;
  onOpenTask: (taskId: string) => void;
}) {
  const review = useTaskReviewInfo(subject.id);
  const latest = review.info?.rounds.at(-1);
  return (
    <>
      <ReviewEvidence
        taskId={subject.id}
        state={review}
        title="审查记录"
        emptyMessage={subject.reviewRequested ? "已请求自动审查，等待首轮结果。" : "这个对象尚无审查记录。"}
        onOpenTask={onOpenTask}
      />
      {latest?.conclusion === "verify_failed" && (
        <p className="review-inspector__notice is-warning">最近一轮未通过；修复与复审应回到对应任务继续处理。</p>
      )}
    </>
  );
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
  // 同一个执行者被审两轮就有两个审查任务，它们代表的是同一个被审对象、点开也是同一份
  // 记录（轮次在证据里本来就都列着），所以按被审对象收敛成一条，留最后派的那一轮。
  const targets = useMemo(() => {
    const seen = new Map<string, number>();
    const list: Task[] = [];
    for (const task of all) {
      if (reviewedIds.has(task.id) || !hasReviewRecord(task)) continue;
      const at = task.reviewOf ? seen.get(task.reviewOf) : undefined;
      if (at === undefined) {
        if (task.reviewOf) seen.set(task.reviewOf, list.length);
        list.push(task);
      } else {
        list[at] = task;
      }
    }
    return list;
  }, [all, reviewedIds]);
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

  // 统计口径跟列表完全一致：列出几条就是几个审查对象，不会出现「列表两条、统计说三个」。
  const completed = targets.filter((task) => {
    const stage = subjectOf(task).stage;
    return stage === "verified" || stage === "accepted";
  }).length;
  const failed = targets.filter((task) => subjectOf(task).stage === "verify_failed").length;

  // 抽屉默认不弹：一进来就盖住列表反而更难挑。点哪条开哪条，再点一次收起。
  const [openId, setOpenId] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const opened = openId ? targets.find((task) => task.id === openId) ?? null : null;
  const openedSubject = opened ? subjectOf(opened) : null;

  return (
    <div className="review-inspector team-review-inspector" aria-label="团队审查" ref={rootRef}>
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
            <small>{completed} 项已验证 · {targets.length} 个审查对象</small>
          </div>
        </header>
        <div className="review-inspector__actions">
          <button type="button" onClick={onOpenReview}><span>打开团队改动工作区</span><CaretRight size={13} /></button>
        </div>
      </section>

      <section className="team-review-inspector__targets" aria-label="团队审查对象">
        <header>
          <b>审查对象</b>
          <small>
            {!targets.length
              ? "跑过验证轮或派了审查执行者的对象会出现在这里"
              : reviewedIds.size
                ? "审查执行者代表它审的那个执行者，点开在左侧看轮次与证据"
                : "点开在左侧看各自的轮次与证据"}
          </small>
        </header>
        <div ref={listRef}>
          {!targets.length && (
            <p className="team-review-inspector__empty">
              这个团队还没有审查记录。执行者只是被验收标记过，并不代表验证跑过——所以这里先空着，而不是把整队执行者列成一排空记录。
            </p>
          )}
          {targets.map((target) => {
            const targetSubject = subjectOf(target);
            return (
              <button
                type="button"
                key={target.id}
                className={target.id === openId ? "is-selected" : targetSubject.stage === "verify_failed" ? "is-failed" : ""}
                aria-expanded={target.id === openId}
                onClick={() => setOpenId((current) => current === target.id ? null : target.id)}
              >
                <span><b>{target.title}</b><small>{roleOf(target)}</small></span>
                <em>{reviewLabel(targetSubject)}</em>
              </button>
            );
          })}
        </div>
      </section>

      {opened && openedSubject && (
        <ReviewEvidenceDrawer
          anchorRef={rootRef}
          keepOpenRef={listRef}
          title={openedSubject.title}
          subtitle={roleOf(opened)}
          onClose={() => setOpenId(null)}
        >
          <TargetEvidence subject={openedSubject} onOpenTask={onOpenTask} />
        </ReviewEvidenceDrawer>
      )}
    </div>
  );
}
