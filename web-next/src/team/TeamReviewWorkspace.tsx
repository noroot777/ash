import { useEffect, useMemo, useState } from "react";
import type { Session, Task } from "@harness/shared";
import { taskDisplayStatus } from "@harness/shared";
import { acceptPlan, hasAcceptStation, isFinalHumanGate, nextAnchor } from "@harness/shared/workflow-policy";
import { STEP_LABELS } from "@harness/shared/workflow";
import { ArrowsClockwise, CaretDown, CheckCircle, SpinnerGap, WarningCircle, X } from "@phosphor-icons/react";
import { TaskStatusDot } from "../components/TaskStatusDot.tsx";
import { api, type AcceptTaskFailure, type TaskCommit, type TaskDiffResult } from "../lib/api.ts";
import type { IndicatorForTask } from "../lib/useTaskReadState.ts";
import { ConfirmDialog } from "../task-detail/ConfirmDialog.tsx";
import { parseAttachmentText } from "../task-detail/utils.ts";
import { ChangeMetaBar, worktreeLabel } from "../review/ChangeMetaBar.tsx";
import { ReviewDiffViewer } from "../review/ReviewDiffViewer.tsx";
import { DispatchReviewEvidence } from "./ReviewEvidence.tsx";

type ReviewData = {
  commits: TaskCommit[];
  branch: string | null;
  diff: TaskDiffResult;
  sessions: Session[];
};

// 验收确认框上那句话：**全部读线上写的那一站**，不再写死「合并并删 worktree 和分支」。
// 这是不可逆动作的最后一道说明，它跟实际会发生的事哪怕差一点，用户按下去就会被闪。
// 口径与服务端一致：squash 和「只打标签」之后 git 不认为分支已合并，所以那两档即便
// 选了「删 worktree 和任务分支」，分支也会保留（绝不 -D），这里就照实说。
//
// 线上没画「合并并清理」时**手动验收照样合**（手按覆盖线上写没写，理由见 shared 的
// acceptPlan）——这时更要把话说全：既说清会发生什么，也说清这不是线上写的。这道确认
// 框就是那条规则的安全兜底，措辞含糊等于把兜底拆了。
function acceptanceMessage(task: Task): string {
  const team = task.mode === "team";
  // 后面还有站要走的那道「等我点头」：这一按只是放行，不合并、不清理，线接着往下走。措辞
  // 必须跟着变——拿「会合并会删分支」的话去描述一次放行，用户要么不敢按，要么按完发现什么
  // 都没合。**下一站是什么要指名道姓**：这道关口最常见的写法就是画在「自动验证」前面，
  // 用户按之前该看见「按完是去验证」，而不是笼统的「往下走」。
  if (!isFinalHumanGate(task.workflow, task.workflowAt)) {
    const next = nextAnchor(task.workflow, task.workflowAt);
    const where = next ? `后面还写着「${STEP_LABELS[next.kind]}」` : "这条线上后面还写着别的站";
    return `${where}，所以这一按只是放行这一关：不合并、不清理，这条线会接着往下走到那一站。`;
  }
  if (!task.useWorktree) {
    return team
      ? "这会确认共享项目工作区中的团队结果，并联动把全部共享执行者标为验收完成。"
      : "这会确认当前项目工作区中的结果并标记为验收完成。";
  }
  const plan = acceptPlan(task.workflow, "human", task.workflowAt);
  const branch = team ? "共享分支" : "任务分支";
  const worktree = team ? "团队 worktree" : "任务 worktree";
  const target = task.worktreeBase || "项目当前分支";
  const tail = team ? "并联动验收共享执行者。" : "";
  // 手动验收永远有合并方案（acceptPlan 的 human 口径），这里只是类型兜底。
  if (!plan.merge) return `这会把该任务标记为验收完成。${tail}`;
  const offScript = task.workflowMode === "free"
    ? "自由工作流没有预设合并站，手动验收按默认规矩来："
    : !hasAcceptStation(task.workflow)
      ? "这条线上没画「合并并清理」，但手动验收按默认规矩来："
      : "";
  const merge = plan.merge === "tag"
    ? `不合并，只在${branch}头上打一个 harness-accepted 标签（${target} 一动不动）`
    : plan.merge === "squash"
      ? `${branch}将 squash 成一个提交合并回 ${target}`
      : `${branch}将合并回 ${target}`;
  const keepsBranch = plan.merge !== "safe";
  const clean = plan.clean === "none"
    ? `，${worktree}与分支都保留`
    : plan.clean === "worktree" || keepsBranch
      ? `，随后清理 ${worktree}，分支保留${keepsBranch && plan.clean === "all" ? "（这一档 git 不认为它已合并，不强删）" : ""}`
      : `，随后清理 ${worktree} 与分支`;
  return `${offScript}${merge}${clean}。${tail}`;
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
      {/* 冲突文件和挡路文件是同一类信息——「验收停在这儿，该去动的是这几个文件」。前者来自
          合并撞冲突，后者来自目标分支/任务 worktree 里还有没提交的东西，所以一副样子渲染。 */}
      {([
        ["冲突文件", failure.conflictFiles],
        ["挡路的文件", failure.dirtyFiles],
      ] as const).map(([label, files]) => files?.length ? (
        <div key={label} className="team-accept-conflict-files">
          <span>{label}（{files.length}）</span>
          <ul>{files.map((file) => <li key={file}><code>{file}</code></li>)}</ul>
        </div>
      ) : null)}
    </div>
  );
}

export function AcceptanceControls({
  task,
  onTaskUpdated,
  notify,
  acceptanceBlock = null,
}: {
  task: Task;
  onTaskUpdated: (task: Task) => void;
  notify: (message: string) => void;
  acceptanceBlock?: string | null;
}) {
  const [action, setAction] = useState<"accept" | "return" | null>(null);
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<AcceptTaskFailure | null>(null);
  const inFlight = task.status === "running" || task.status === "queued";
  // Archived = frozen/read-only：后端验收/打回都会 409，按钮必须一致地禁掉，不给假按钮。
  const archived = !!task.archived;
  // 停在中途那道关口时，这一按是「放行」不是「验收」：按钮、确认框、提示三处一起改口，
  // 只改一处就会出现「按钮写着验收通过、确认框说只是放行」的自相矛盾。
  const midGate = !isFinalHumanGate(task.workflow, task.workflowAt);

  useEffect(() => {
    if (acceptanceBlock && action === "accept") setAction(null);
  }, [acceptanceBlock, action]);

  const accept = async () => {
    // The confirmation is single-use. Keep progress on the action button so a
    // typed acceptance failure can render unobscured in the review record.
    setAction(null);
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
      // 合并成了、但「点头之后」那一段（发布脚本之类）挂了，是两件事，得分开说：
      // 只报一句「验收通过」，用户下次知道发布挂了就是在线上出事的时候。
      notify(result.kind === "gate_released"
        ? "已放行，这条线继续往下走"
        : result.tail && !result.tail.ok
          ? `已合并，但「${result.tail.step ?? "点头之后那一段"}」没跑过，详情见任务时间线`
          : result.warnings?.length ? `验收通过，但有 ${result.warnings.length} 条清理警告` : "验收通过");
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
      const result = await api.replyTask(task.id, `【验收打回】请继续修改并完成后重新提交验收。\n\n${text}`);
      onTaskUpdated(await api.task(task.id));
      setAction(null);
      setFeedback("");
      // 任务这会儿还在跑的话,后端会把意见排队,等它这一轮结束再送进去——如实说清楚。
      notify("scheduled" in result
        ? "已打回；任务还在跑，意见已排队，跑完自动送入会话"
        : "已打回，意见已送入原任务会话");
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
            <button type="button" className="is-primary" disabled={archived || inFlight || busy || !!acceptanceBlock} onClick={() => setAction("accept")}>
              {busy ? <SpinnerGap size={13} className="is-spinning" /> : <CheckCircle size={13} weight="fill" />}
              {busy ? (midGate ? "放行中" : "验收中") : archived ? "已归档（只读）" : inFlight ? "执行中" : acceptanceBlock ?? (midGate ? "放行，继续下一站" : "验收通过")}
            </button>
            <button type="button" disabled={archived || inFlight || busy} onClick={() => setAction("return")}><WarningCircle size={13} />打回修改</button>
          </>
        )}
      </div>
      {failure && <AcceptanceFailureNotice failure={failure} />}
      {action === "accept" && (
        <ConfirmDialog
          title={midGate ? "放行这一关？" : "确认验收通过？"}
          message={midGate ? acceptanceMessage(task) : `${acceptanceMessage(task)} 已执行的合并和删除不可逆。`}
          confirmLabel={midGate ? "放行" : "验收通过"}
          danger={!midGate && !!task.useWorktree}
          busy={busy}
          onConfirm={() => void accept()}
          onClose={() => setAction(null)}
        />
      )}
      {action === "return" && (
        <ConfirmDialog title="打回继续修改？" message="这会把验收意见作为真人回复送入原任务会话，执行者会在原上下文继续处理。" confirmLabel="打回修改" busy={busy} onConfirm={() => void returnTask()} onClose={() => setAction(null)}>
          <textarea className="team-return-feedback" value={feedback} autoFocus rows={5} placeholder="写清需要修改的内容与重新验收标准…" onChange={(event) => setFeedback(event.target.value)} />
        </ConfirmDialog>
      )}
    </>
  );
}

function useReviewChanges(task: Task) {
  const [data, setData] = useState<ReviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
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
  return { data, loading, error };
}

function ChangeSummary({ task, data, loading, error }: { task: Task; data: ReviewData | null; loading: boolean; error: string | null }) {
  if (loading) return <p className="team-review-loading"><SpinnerGap size={13} className="is-spinning" />正在读取分支与提交…</p>;
  if (error) return <p className="team-review-loading is-error">改动信息读取失败：{error}</p>;
  if (!data) return null;
  const session = data.sessions[data.sessions.length - 1];
  return (
    <div className="team-review-change">
      <ChangeMetaBar
        source={data.diff.sourceBranch || data.branch || session?.branch || "项目当前分支"}
        target={data.diff.targetBranch || task.worktreeBase || "项目当前分支"}
        where={session?.worktreePath
          ? worktreeLabel(session.worktreePath)
          : task.useWorktree ? "worktree 尚未记录" : "共享项目目录"}
        commits={data.commits}
      />
      <ReviewDiffViewer result={data.diff} />
    </div>
  );
}

// 调度台这一份不再套「可折叠的记录卡」：标题、角色、状态、目标正文在团队视图和右侧审查
// 侧边栏里各有一份，验证证据也在侧边栏点得开——铺在这里只是把真正要看的 diff 往下推。
// 验收动作上提到了顶栏（那是这一屏唯一的动作，不该跟着卡片折叠一起消失），所以这里只剩
// 它独有的东西：共享分支的改动本身。
function LeadChanges({ task, onReadTask }: { task: Task; onReadTask: (task: Task) => void }) {
  const { data, loading, error } = useReviewChanges(task);
  useEffect(() => { onReadTask(task); }, [onReadTask, task]);
  return <ChangeSummary task={task} data={data} loading={loading} error={error} />;
}

function ReviewRecord({
  task,
  parentTask = null,
  role,
  actions = false,
  defaultOpen = false,
  onTaskUpdated,
  indicatorForTask,
  onReadTask,
  notify,
}: {
  task: Task;
  parentTask?: Task | null;
  role: string;
  actions?: boolean;
  defaultOpen?: boolean;
  onTaskUpdated: (task: Task) => void;
  indicatorForTask: IndicatorForTask;
  onReadTask: (task: Task) => void;
  notify: (message: string) => void;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const { data, loading, error } = useReviewChanges(task);
  const objective = parseAttachmentText(task.body).body;
  const display = taskDisplayStatus(task.status, task.stage, !!task.question);
  const indicator = indicatorForTask(task);
  const visibleIndicator = open && (indicator === "success" || indicator === "error") ? null : indicator;
  useEffect(() => {
    if (open) onReadTask(task);
  }, [onReadTask, open, task]);
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
          <DispatchReviewEvidence task={task} parentTask={parentTask} notify={notify} />
          <ChangeSummary task={task} data={data} loading={loading} error={error} />
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
  const sharedWorkers = useMemo(() => workers.filter((worker) => !worker.useWorktree), [workers]);
  const independentWorkers = useMemo(() => workers.filter((worker) => worker.useWorktree), [workers]);
  // 共享执行者不在这里逐个铺开——它们的改动就在上面这份共享分支 diff 里，逐个的轮次与
  // 证据在右侧审查侧边栏。这里只留一句摘要，因为「按下验收会联动标记它们」是不可逆动作
  // 的前提事实，用户在按之前该看得见（确认框里也说了同一件事）。
  const sharedFailed = sharedWorkers.filter((worker) => worker.stage === "verify_failed").length;
  const sharedNote = sharedWorkers.length
    ? `共享分支上还有 ${sharedWorkers.length} 个执行者${sharedFailed ? `（${sharedFailed} 个验证未通过）` : ""}，随团队整体验收联动标记；逐个证据见右侧审查。`
    : "核对共享分支与独立 worktree 后分别验收或打回。";
  return (
    <section className="team-review-workspace">
      <header className="team-review-subbar">
        <div><b>团队验收台</b><small>{sharedNote}</small></div>
        <AcceptanceControls task={lead} onTaskUpdated={onTaskUpdated} notify={notify} />
        <button type="button" onClick={onClose}><X size={13} />返回团队流</button>
      </header>
      <div className="team-review-scroll">
        <div className="team-review-stack">
          <LeadChanges task={lead} onReadTask={onReadTask} />
          {/* 没有独立 worktree 执行者时整节不出现：它的空态说的就是顶上那句「随团队整体验收
              联动标记」，留一个 0 项的空壳只是把验收按钮往下推。有独立执行者时它才是唯一的
              逐个合入/打回入口，那时必须在。 */}
          {independentWorkers.length > 0 && (
            <section className="team-acceptance-queue">
              <header><div><b>独立执行者待验收队列</b><small>每个显式 worktree 都有独立分支与合入动作，按执行者分别处理。</small></div><span>{independentWorkers.length} 项</span></header>
              <div>{independentWorkers.map((worker, index) => <ReviewRecord key={worker.id} task={worker} parentTask={lead} role={`执行者 ${index + 1}`} actions defaultOpen={worker.stage === "awaiting_acceptance" || worker.stage === "verify_failed"} onTaskUpdated={onTaskUpdated} indicatorForTask={indicatorForTask} onReadTask={onReadTask} notify={notify} />)}</div>
            </section>
          )}
        </div>
      </div>
    </section>
  );
}
