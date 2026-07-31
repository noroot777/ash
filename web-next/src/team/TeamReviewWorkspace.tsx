import { useEffect, useMemo, useState } from "react";
import type { Session, Task } from "@harness/shared";
import { taskDisplayStatus } from "@harness/shared";
import { ArrowsClockwise, CaretDown, CheckCircle, GitBranch, GitCommit, GitDiff, SpinnerGap, WarningCircle, X } from "@phosphor-icons/react";
import { LegacyLink } from "../components/LegacyLink.tsx";
import { TaskStatusDot } from "../components/TaskStatusDot.tsx";
import { api, type AcceptTaskFailure, type TaskCommit, type TaskDiffResult } from "../lib/api.ts";
import type { IndicatorForTask } from "../lib/useTaskReadState.ts";
import { ConfirmDialog } from "../task-detail/ConfirmDialog.tsx";
import { formatInstant, parseAttachmentText } from "../task-detail/utils.ts";

type ReviewData = {
  commits: TaskCommit[];
  branch: string | null;
  diff: TaskDiffResult;
  sessions: Session[];
};

function acceptanceMessage(task: Task): string {
  if (task.mode === "team") {
    return task.useWorktree
      ? `共享分支将合并回 ${task.worktreeBase || "项目当前分支"}，随后清理团队 worktree 与分支，并联动验收共享执行者。`
      : "这会确认共享项目工作区中的团队结果，并联动把全部共享执行者标为验收完成。";
  }
  return task.useWorktree
    ? `任务分支将合并回 ${task.worktreeBase || "项目当前分支"}，随后清理任务 worktree 与分支。`
    : "这会确认当前项目工作区中的结果并标记为验收完成。";
}

function AcceptanceFailureNotice({ failure }: { failure: AcceptTaskFailure }) {
  const handedOff = failure.reason === "merge_conflict" && failure.conflictHandoff?.notified === true;
  const manualConflict = failure.reason === "merge_conflict" && !handedOff;
  return (
    <div className={`team-accept-failure${handedOff ? " is-handed-off" : ""}`} role={handedOff ? "status" : "alert"}>
      <div className="team-accept-failure-heading">
        <span>{handedOff ? <ArrowsClockwise size={14} weight="bold" /> : <WarningCircle size={14} weight="fill" />}</span>
        <div>
          <b>{handedOff ? "合并冲突已交给任务处理" : manualConflict ? "合并冲突，未能自动交接" : "验收未完成"}</b>
          {handedOff ? (
            <>
              {failure.conflictHandoff?.message && <p className="team-accept-handoff-message">{failure.conflictHandoff.message}</p>}
              <p className="team-accept-failure-guidance">本次验收已安全停止，目标分支未被修改；等待任务处理完成后，再点一次「验收通过」。</p>
            </>
          ) : (
            <>
              {manualConflict && <p className="team-accept-failure-guidance">未能唤醒任务，请手动解决冲突并提交，然后重新验收。</p>}
              {failure.conflictHandoff?.message && <p>{failure.conflictHandoff.message}</p>}
              <p>{failure.error}</p>
            </>
          )}
        </div>
      </div>
      {failure.conflictFiles?.length ? (
        <div className="team-accept-conflict-files">
          <span>冲突文件（{failure.conflictFiles.length}）</span>
          <ul>{failure.conflictFiles.map((file) => <li key={file}><code>{file}</code></li>)}</ul>
        </div>
      ) : null}
    </div>
  );
}

export function AcceptanceControls({
  task,
  onTaskUpdated,
  notify,
}: {
  task: Task;
  onTaskUpdated: (task: Task) => void;
  notify: (message: string) => void;
}) {
  const [action, setAction] = useState<"accept" | "return" | null>(null);
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<AcceptTaskFailure | null>(null);
  const inFlight = task.status === "running" || task.status === "queued";

  const accept = async () => {
    setBusy(true);
    setFailure(null);
    try {
      const result = await api.acceptTask(task.id);
      if (!result.accepted) {
        setFailure(result);
        const handedOff = result.reason === "merge_conflict" && result.conflictHandoff?.notified === true;
        notify(handedOff
          ? "合并冲突已交给任务处理"
          : result.reason === "merge_conflict" ? "合并冲突，未能自动交接" : `验收未完成：${result.error}`);
        return;
      }
      onTaskUpdated(await api.task(task.id));
      setAction(null);
      notify(result.warnings?.length ? `验收通过，但有 ${result.warnings.length} 条清理警告` : "验收通过");
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  const returnTask = async () => {
    const text = feedback.trim();
    if (!text) return;
    setBusy(true);
    try {
      await api.replyTask(task.id, `【验收打回】请继续修改并完成后重新提交验收。\n\n${text}`);
      onTaskUpdated(await api.task(task.id));
      setAction(null);
      setFeedback("");
      notify("已打回，意见已送入原任务会话");
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="team-accept-actions">
        {task.stage === "accepted" ? (
          <span><CheckCircle size={13} weight="fill" />验收完成</span>
        ) : (
          <>
            <button type="button" className="is-primary" disabled={inFlight || busy} onClick={() => setAction("accept")}><CheckCircle size={13} weight="fill" />{inFlight ? "执行中" : "验收通过"}</button>
            <button type="button" disabled={inFlight || busy} onClick={() => setAction("return")}><WarningCircle size={13} />打回修改</button>
          </>
        )}
      </div>
      {failure && <AcceptanceFailureNotice failure={failure} />}
      {action === "accept" && (
        <ConfirmDialog title="确认验收通过？" message={`${acceptanceMessage(task)} 已执行的合并和删除不可逆。`} confirmLabel="验收通过" danger={!!task.useWorktree} busy={busy} onConfirm={() => void accept()} onClose={() => setAction(null)} />
      )}
      {action === "return" && (
        <ConfirmDialog title="打回继续修改？" message="这会把验收意见作为真人回复送入原任务会话，执行者会在原上下文继续处理。" confirmLabel="打回修改" busy={busy} onConfirm={() => void returnTask()} onClose={() => setAction(null)}>
          <textarea className="team-return-feedback" value={feedback} autoFocus rows={5} placeholder="写清需要修改的内容与重新验收标准…" onChange={(event) => setFeedback(event.target.value)} />
        </ConfirmDialog>
      )}
    </>
  );
}

function WorkspaceFacts({ task, data }: { task: Task; data: ReviewData | null }) {
  const session = data?.sessions[data.sessions.length - 1];
  return (
    <dl className="team-review-facts">
      <div><dt>源分支</dt><dd><GitBranch size={12} />{data?.diff.sourceBranch || data?.branch || session?.branch || "项目当前分支"}</dd></div>
      <div><dt>合入目标</dt><dd>{data?.diff.targetBranch || task.worktreeBase || "项目当前分支"}</dd></div>
      <div><dt>worktree</dt><dd title={session?.worktreePath || undefined}>{session?.worktreePath || (task.useWorktree ? "尚未记录" : "共享项目目录")}</dd></div>
    </dl>
  );
}

function ChangeSummary({ data, loading, error }: { data: ReviewData | null; loading: boolean; error: string | null }) {
  if (loading) return <p className="team-review-loading"><SpinnerGap size={13} className="is-spinning" />正在读取分支与提交…</p>;
  if (error) return <p className="team-review-loading is-error">改动信息读取失败：{error}</p>;
  if (!data) return null;
  const additions = data.diff.files.reduce((sum, file) => sum + (file.additions ?? 0), 0);
  const deletions = data.diff.files.reduce((sum, file) => sum + (file.deletions ?? 0), 0);
  return (
    <div className="team-review-change-grid">
      <section>
        <h4><GitCommit size={13} />提交 · {data.commits.length}</h4>
        {!data.commits.length && <p>没有可展示的提交。</p>}
        {data.commits.slice(0, 6).map((commit) => (
          <div className="team-review-commit" key={commit.sha}><code>{commit.sha.slice(0, 8)}</code><span>{commit.subject}</span><time>{formatInstant(commit.at)}</time></div>
        ))}
      </section>
      <section>
        <h4><GitDiff size={13} />文件改动 · {data.diff.files.length}<em>+{additions} −{deletions}</em></h4>
        {!data.diff.available && <p>diff 暂不可用：{data.diff.reason || "无法解析分支差异"}</p>}
        {data.diff.files.slice(0, 8).map((file) => (
          <div className="team-review-file" key={file.path}><code>{file.path}</code><span>+{file.additions ?? "?"} −{file.deletions ?? "?"}</span></div>
        ))}
        {data.diff.files.length > 8 && <p>另有 {data.diff.files.length - 8} 个文件，请用旧版查看完整 diff。</p>}
      </section>
    </div>
  );
}

function ReviewRecord({
  task,
  role,
  actions = false,
  defaultOpen = false,
  onTaskUpdated,
  indicatorForTask,
  onReadTask,
  notify,
}: {
  task: Task;
  role: string;
  actions?: boolean;
  defaultOpen?: boolean;
  onTaskUpdated: (task: Task) => void;
  indicatorForTask: IndicatorForTask;
  onReadTask: (task: Task) => void;
  notify: (message: string) => void;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [data, setData] = useState<ReviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const objective = parseAttachmentText(task.body).body;
  const display = taskDisplayStatus(task.status, task.stage, !!task.question);
  const indicator = indicatorForTask(task);
  const visibleIndicator = open && (indicator === "success" || indicator === "error") ? null : indicator;
  useEffect(() => {
    if (open) onReadTask(task);
  }, [onReadTask, open, task]);
  useEffect(() => {
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
  }, [task.id, task.updatedAt]);
  return (
    <article className="team-review-record">
      <header>
        <button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open}><CaretDown size={13} weight="bold" /></button>
        {visibleIndicator && <TaskStatusDot indicator={visibleIndicator} surface="team" />}
        <button type="button" className="team-review-record-title" onClick={() => setOpen((value) => !value)}>
          <span><b>{task.title}</b><em>{role}</em><small>{display.label}</small></span>
          {objective && <p>{objective}</p>}
        </button>
        {actions && <AcceptanceControls task={task} onTaskUpdated={onTaskUpdated} notify={notify} />}
      </header>
      {open && (
        <div className="team-review-record-body">
          <WorkspaceFacts task={task} data={data} />
          <ChangeSummary data={data} loading={loading} error={error} />
        </div>
      )}
    </article>
  );
}

export function TeamReviewWorkspace({
  lead,
  workers,
  onClose,
  onTaskUpdated,
  indicatorForTask,
  onReadTask,
  notify,
}: {
  lead: Task;
  workers: Task[];
  onClose: () => void;
  onTaskUpdated: (task: Task) => void;
  indicatorForTask: IndicatorForTask;
  onReadTask: (task: Task) => void;
  notify: (message: string) => void;
}) {
  const independentWorkers = useMemo(() => workers.filter((worker) => worker.useWorktree), [workers]);
  return (
    <section className="team-review-workspace">
      <header className="team-review-subbar">
        <div><b>团队验收台</b><small>配合右侧审查记录，核对共享分支与独立 worktree 后分别验收或打回。</small></div>
        <LegacyLink projectId={lead.projectId} taskId={lead.id} view="review" />
        <button type="button" onClick={onClose}><X size={13} />返回团队流</button>
      </header>
      <div className="team-review-scroll">
        <div className="team-review-stack">
          <ReviewRecord task={lead} role={lead.useWorktree ? "调度台 / 共享 worktree" : "调度台 / 项目工作区"} actions defaultOpen onTaskUpdated={onTaskUpdated} indicatorForTask={indicatorForTask} onReadTask={onReadTask} notify={notify} />
          <section className="team-acceptance-queue">
            <header><div><b>独立执行者待验收队列</b><small>每个显式 worktree 都有独立分支与合入动作，按执行者分别处理。</small></div><span>{independentWorkers.length} 项</span></header>
            {independentWorkers.length ? (
              <div>{independentWorkers.map((worker, index) => <ReviewRecord key={worker.id} task={worker} role={`执行者 ${index + 1}`} actions defaultOpen={worker.stage === "awaiting_acceptance" || worker.stage === "verify_failed"} onTaskUpdated={onTaskUpdated} indicatorForTask={indicatorForTask} onReadTask={onReadTask} notify={notify} />)}</div>
            ) : <p>没有独立 worktree 执行者；共享执行者随团队整体验收。</p>}
          </section>
        </div>
      </div>
    </section>
  );
}
