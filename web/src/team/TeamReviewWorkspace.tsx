import { useEffect, useMemo, useState } from "react";
import type { Session, Task, TaskListItem } from "@ash/shared";
import { taskDisplayStatus } from "@ash/shared";
import { CaretDown, SpinnerGap } from "@phosphor-icons/react";
import { TaskStatusDot } from "../components/TaskStatusDot.tsx";
import { api, type TaskCommit, type TaskDiffResult } from "../lib/api.ts";
import type { IndicatorForTask } from "../lib/useTaskReadState.ts";
import { useTaskBody } from "../lib/useTaskBody.ts";
import { parseAttachmentText } from "../task-detail/utils.ts";
import { ReviewDiffViewer } from "../review/ReviewDiffViewer.tsx";
import { useWorkspaceCommitVersion } from "../review/workspaceCommit.ts";
import { AcceptanceControls } from "../acceptance/AcceptanceControls.tsx";
import { AcceptRoute, type RouteData } from "../acceptance/AcceptRoute.tsx";
import { DispatchReviewEvidence } from "./ReviewEvidence.tsx";

type ReviewData = {
  commits: TaskCommit[];
  branch: string | null;
  diff: TaskDiffResult;
  sessions: Session[];
};

function useReviewChanges(task: TaskListItem, enabled = true) {
  const commitVersion = useWorkspaceCommitVersion(task.id);
  const [data, setData] = useState<ReviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    setLoading(true);
    Promise.all([api.taskCommits(task.id), api.taskDiff(task.id), api.sessions(task.id)]).then(
      ([commits, diff, sessions]) => {
        if (!alive) return;
        setData({ commits: commits.commits, branch: commits.branch, diff, sessions });
        setError(null);
      },
      (reason) => { if (alive) setError(reason instanceof Error ? reason.message : String(reason)); },
    ).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [task.id, task.updatedAt, commitVersion, enabled]);
  return { data, loading, error };
}

function routeOf(task: TaskListItem, data: ReviewData): RouteData {
  const session = data.sessions[data.sessions.length - 1];
  return {
    source: data.diff.sourceBranch || data.branch || session?.branch || "项目当前分支",
    target: data.diff.targetBranch || task.acceptedTargetBranch || task.mergeTargetBranch || task.worktreeBase || "验收时确定",
    commits: data.commits,
    diff: data.diff,
  };
}

function ChangesState({ loading, error }: { loading: boolean; error: string | null }) {
  if (error) return <p className="team-review-loading is-error">改动信息读取失败：{error}</p>;
  if (loading) return <p className="team-review-loading"><SpinnerGap size={13} className="is-spinning" />正在读取分支与提交…</p>;
  return null;
}

/**
 * 团队里每个独立 worktree 执行者一张记录：头一行就是它自己的验收台（标题在左、决定在右、前提在下），
 * 展开是它的审查证据、走向与 diff。共享执行者不在这里逐个铺开 —— 它们的改动就在团队那份 diff 里。
 */
function ReviewRecord({ task, parentTask, role, defaultOpen, onTaskUpdated, indicatorForTask, onReadTask, notify }: {
  task: TaskListItem;
  parentTask: TaskListItem;
  role: string;
  defaultOpen: boolean;
  onTaskUpdated: (task: Task) => void;
  indicatorForTask: IndicatorForTask;
  onReadTask: (task: TaskListItem) => void;
  notify: (message: string) => void;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const { data, loading, error } = useReviewChanges(task, open);
  // 正文不在列表响应里，按需补。没到手就不显示目标行：空目标和还没读到是两回事。
  const full = useTaskBody(task);
  const objective = full ? parseAttachmentText(full.body).body : "";
  const display = taskDisplayStatus(task.status, task.stage, !!task.question);
  const indicator = indicatorForTask(task);
  const visibleIndicator = open && (indicator === "success" || indicator === "error") ? null : indicator;
  useEffect(() => {
    if (open) onReadTask(task);
  }, [onReadTask, open, task]);
  return (
    <article className="team-review-record">
      <AcceptanceControls
        className="acc-record"
        task={task}
        onTaskUpdated={onTaskUpdated}
        notify={notify}
        lead={(
          <button type="button" className="team-review-record-title" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
            <CaretDown size={13} weight="bold" className="team-review-record-caret" aria-hidden="true" />
            {visibleIndicator && <TaskStatusDot indicator={visibleIndicator} surface="team" />}
            <span><b>{task.title}</b><em>{role}</em><small>{display.label}</small></span>
            {objective && <p>{objective}</p>}
          </button>
        )}
      />
      {open && (
        <div className="team-review-record-body">
          <DispatchReviewEvidence task={task} parentTask={parentTask} notify={notify} />
          {data
            ? <>
              <div className="acc-route-line"><AcceptRoute task={task} data={routeOf(task, data)} disabled={!!task.archived} onTaskUpdated={onTaskUpdated} notify={notify} /></div>
              <ReviewDiffViewer result={data.diff} />
            </>
            : <ChangesState loading={loading} error={error} />}
        </div>
      )}
    </article>
  );
}

export function TeamReviewWorkspace({
  lead,
  workers,
  onTaskUpdated,
  indicatorForTask,
  onReadTask,
  notify,
}: {
  lead: Task;
  workers: TaskListItem[];
  onTaskUpdated: (task: Task) => void;
  indicatorForTask: IndicatorForTask;
  onReadTask: (task: TaskListItem) => void;
  notify: (message: string) => void;
}) {
  const sharedWorkers = useMemo(() => workers.filter((worker) => !worker.useWorktree), [workers]);
  const independentWorkers = useMemo(() => workers.filter((worker) => worker.useWorktree), [workers]);
  const { data, loading, error } = useReviewChanges(lead);
  useEffect(() => { onReadTask(lead); }, [onReadTask, lead]);
  // 后端 acceptanceGuard 对共享执行者的 running/queued/backlog/paused 一律 409（团队验收会把它们的
  // stage 联动置 accepted，盖到没跑过、待续跑的活上就是伪造）。判据与 server/src/task-accept-guard.ts 同源。
  const unsettledShared = sharedWorkers.filter((worker) =>
    worker.status === "running" || worker.status === "queued" || worker.status === "backlog" || worker.status === "paused");
  const block = unsettledShared.length
    ? { text: `共享执行者未完成（${unsettledShared.length}）`, detail: unsettledShared.map((worker) => worker.title).join("、") }
    : null;
  return (
    <section className="team-review-workspace">
      <AcceptanceControls
        className="acc-desk"
        task={lead}
        onTaskUpdated={onTaskUpdated}
        notify={notify}
        block={block}
        lead={data ? <AcceptRoute task={lead} data={routeOf(lead, data)} disabled={!!lead.archived} onTaskUpdated={onTaskUpdated} notify={notify} />
          : <b className="acc-title">团队验收台</b>}
      />
      <div className="team-review-scroll">
        <div className="team-review-stack">
          {data ? <ReviewDiffViewer result={data.diff} /> : <ChangesState loading={loading} error={error} />}
          {/* 没有独立 worktree 执行者时整节不出现；有的时候它是逐个合入、打回的唯一入口。 */}
          {independentWorkers.length > 0 && (
            <section className="team-acceptance-queue" aria-label="独立执行者">
              {independentWorkers.map((worker, index) => (
                <ReviewRecord key={worker.id} task={worker} parentTask={lead} role={`执行者 ${index + 1}`}
                  defaultOpen={worker.stage === "awaiting_acceptance" || worker.stage === "verify_failed"}
                  onTaskUpdated={onTaskUpdated} indicatorForTask={indicatorForTask} onReadTask={onReadTask} notify={notify} />
              ))}
            </section>
          )}
        </div>
      </div>
    </section>
  );
}
