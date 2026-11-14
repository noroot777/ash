import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowUUpLeft, Check, CheckCircle } from "@phosphor-icons/react";
import type { BranchPlanView, Task, TaskListItem } from "@ash/shared";
import { hasPendingAcceptCommit } from "@ash/shared";
import { isFinalHumanGate } from "@ash/shared/workflow-policy";
import { acceptanceSteps } from "@ash/shared/accept-message";
import type { AcceptanceAutoCommitOutcome } from "@ash/shared/accept-workspace";
import { api, type AcceptTaskFailure } from "../lib/api.ts";
import { useAcceptGate } from "../review/useAcceptGate.ts";
import { useBranchPlan } from "../review/useBranchPlan.ts";
import { AcceptConfirm } from "./AcceptConfirm.tsx";
import { AcceptReject, type ReturnOutcome } from "./AcceptReject.tsx";
import { acceptMessage, gateNotice } from "./acceptMessages.ts";
import { BaselineCheck } from "./BaselineCheck.tsx";
import { CheckAction, CheckRow } from "./CheckRow.tsx";
import { confirmView, type ConfirmGate } from "./confirmPlan.ts";
import { DependencyChecks, dependencyBlocked, selectionBlockOf } from "./DependencyChecks.tsx";
import { FailureCheck } from "./FailureCheck.tsx";
import { GateCheck, useCanManage } from "./GateCheck.tsx";
import { ago } from "./gateLine.ts";
import { PendingMergeCheck } from "./PendingMergeCheck.tsx";
import { useAcceptanceVerification } from "./useAcceptanceVerification.ts";
import { refreshTaskFacts, useTaskFacts } from "./taskFacts.ts";
import { useAcceptCommitDefault } from "./useAcceptCommitDefault.ts";
import { useReviewFacts, type FactRow } from "./useReviewFacts.ts";
import { AutoCommitCheck, WorkspaceCheck } from "./WorkspaceCheck.tsx";

/** 宿主自己知道、这里不知道的那一道关（团队：共享执行者还没跑完）。 */
export type HostBlock = { text: string; detail?: string };

const BASELINE_ISSUE = {
  merge_conflict: "会撞冲突",
  accept_gate_target_behind: "还没含最新的目标分支",
  accept_gate_preview_unavailable: "合并预览做不出来",
} as const;

/**
 * 验收台：**一行决定、一列前提**，其余全是宿主自己的 diff。四处宿主同一副形状 —— 单任务验收台、
 * 团队验收台顶栏、每个独立执行者的记录头、讨论结论那一条（以及工作流侧栏那道「等我点头」）。
 *
 * 第一行：左边是宿主给的 `lead`（走向与改动量，或一个标题），右边是打回、验收和宿主的 `trailing`。
 * 主按钮上永远只写动作名；挡住它的原因各自一行，摆在下面那一列里，红的拦、琥珀的只提醒。
 * 读不出来的任何一份事实（自由工作流状态、门禁、依赖、提交默认）一律不放行。
 */
export function AcceptanceControls({ task, onTaskUpdated, notify, block = null, lead, trailing, onPostMergeReview, onOpenReview, onReturned, className = "" }: {
  task: TaskListItem;
  onTaskUpdated: (task: Task) => void;
  notify: (message: string) => void;
  block?: HostBlock | null;
  lead?: ReactNode;
  trailing?: ReactNode;
  onPostMergeReview?: () => void;
  /** 审查警示那一行的出路（打开审查记录）。 */
  onOpenReview?: () => void;
  /** 打回发出去之后把人送回对话。 */
  onReturned?: () => void;
  className?: string;
}) {
  const midGate = !isFinalHumanGate(task.workflow, task.workflowAt);
  const settled = task.stage === "accepted" || task.stage === "merged";
  const archived = !!task.archived;
  const inFlight = task.status === "running" || task.status === "queued";
  const gate = useAcceptGate(task.id);
  const plan = useBranchPlan(task, !midGate && !settled);
  const facts = useReviewFacts(task);
  const canManage = useCanManage(task.projectId);
  const [layer, setLayer] = useState<"confirm" | "reject" | null>(null);
  const [busy, setBusy] = useState(false);
  const [checked, setChecked] = useState<string[]>([]);
  const [runChoice, setRunChoice] = useState<boolean | null>(null);
  const [commitChoice, setCommitChoice] = useState<boolean | null>(null);
  const [proposal, setProposal] = useState<BranchPlanView | null>(null);
  const [familyAck, setFamilyAck] = useState(false);
  const [editGate, setEditGate] = useState(false);
  const [failure, setFailure] = useState<AcceptTaskFailure | null>(null);
  const [autoCommit, setAutoCommit] = useState<{ taskId: string; outcome: AcceptanceAutoCommitOutcome } | null>(null);
  const acceptRef = useRef<HTMLButtonElement>(null);
  const rejectRef = useRef<HTMLButtonElement>(null);
  const confirming = layer === "confirm";
  const verification = useAcceptanceVerification(task, confirming);
  // 动作成功之后这个任务的事实要整份追平（taskFacts.ts）：追平之前不许确认，读失败那一行给重试。
  const taskFacts = useTaskFacts(task.id, task.updatedAt);
  const retryTaskFacts = () => void refreshTaskFacts(task, onTaskUpdated);
  useEffect(() => { setChecked([]); setFailure(null); setLayer(null); }, [task.id]);
  // 版本一推，前置命令那份状态（基准对照的目标分支跟着合入目标走）也重读一次。
  useEffect(() => { if (taskFacts.version) void gate.reload(); }, [taskFacts.version]);

  // —— 这一按此刻被什么挡着 ——
  const worktreeChecks = !midGate && !settled && !!task.useWorktree;
  const checkingDependencies = worktreeChecks && !plan.error && (plan.loading || plan.refreshing || !plan.view);
  const gateUnread = !midGate && !settled && (!gate.state || !!gate.error);
  const gateLoading = gateUnread && !gate.state && !gate.error;
  const selectionBlock = worktreeChecks ? selectionBlockOf(plan.view, checked) : null;
  const family = worktreeChecks && checked.length > 0 && plan.view
    ? [plan.view.task, ...plan.view.descendants.filter((row) => checked.includes(row.taskId))] : [];
  const factBlocks: FactRow[] = [
    ...(archived ? [{ key: "archived", tone: "idle" as const, text: "已归档，只读" }] : []),
    ...(inFlight && !settled ? [{ key: "in-flight", tone: "live" as const, text: "任务在跑" }] : []),
    ...(block && !settled ? [{ key: "host", tone: "block" as const, text: block.text }] : []),
    ...(taskFacts.error ? [{ key: "task-facts", tone: "block" as const, text: `改动之后的任务状态没读到：${taskFacts.error}`, retry: retryTaskFacts }] : []),
    ...facts.blocks,
  ];
  const blocked = factBlocks.length > 0
    || (worktreeChecks && dependencyBlocked(plan.view, plan.error))
    || !!selectionBlock
    || (!settled && gate.occupied);
  const loading = busy || checkingDependencies || gateLoading || facts.loading || taskFacts.pending;
  const acceptDisabled = blocked || loading || gateUnread;
  useEffect(() => { if (blocked && confirming) setLayer(null); }, [blocked, confirming]);

  // —— 确认层 ——
  const merging = family.filter((row) => row.stage !== "accepted" && row.strategy !== "tag");
  const steps = acceptanceSteps(task, true);
  const commitChoosable = family.length ? merging.length > 0 : steps.kind === "merge" && steps.merge !== "tag";
  const commitDefault = useAcceptCommitDefault(task.projectId, commitChoosable && confirming);
  const latest = gate.latest;
  const issue = gate.state?.baselineIssue;
  const confirmGate: ConfirmGate | null = !midGate && !family.length && gate.state?.command && steps.kind !== "release"
    ? {
        command: gate.state.command,
        reusable: latest?.status === "passed" && !latest.stale,
        passedAgo: latest?.status === "passed" ? ago(latest.finishedAt ?? latest.startedAt) : null,
        lastFailed: latest?.status === "failed",
        issue: issue ? BASELINE_ISSUE[issue.reason] : null,
      }
    : null;
  const unverified = family.filter((row) => row.unexecutedVerification);
  const verifyState = family.length
    ? unverified.length ? (familyAck ? "acknowledged" : "unacknowledged") : "none"
    : midGate ? "none"
      : verification.loading ? "loading" : verification.error ? "error"
        : verification.verification ? (verification.acknowledged ? "acknowledged" : "unacknowledged") : "none";
  const view = confirmView({
    steps, gate: confirmGate, runChoice, commitChoosable, commitChoice, commitDefault: commitDefault.value,
    count: family.length ? merging.length : 1, verification: verifyState,
  });
  const shownSteps = acceptanceSteps(task, view.commit);
  // 关掉就回到默认：这几勾的语义都是「这一次」。
  useEffect(() => {
    if (!confirming) { setRunChoice(null); setCommitChoice(null); setFamilyAck(false); verification.setAcknowledged(false); }
  }, [confirming]);

  // 动作已经生效之后的「再拉一遍任务」是另一件事：失败只在成功提示后面缀一句，绝不报成动作失败；
  // 前提列里那一行（task-facts）会一直说着，直到追平。
  const refreshAfterMutation = async (): Promise<string> =>
    (await refreshTaskFacts(task, onTaskUpdated)) === null ? "" : "（动作已生效，但页面没能刷新，下面那一行可以重试）";

  const openConfirm = () => {
    if (acceptDisabled) return;
    setProposal(plan.view);
    setLayer("confirm");
  };

  const accept = async () => {
    if (acceptDisabled || view.confirmDisabled) return;
    // 发的是**这一层里看到的那个值**（提交、运行与否），不让后端再读一次项目设置。
    const { commitParam, gateIntent } = view;
    setLayer(null);
    setBusy(true);
    setFailure(null);
    try {
      if (family.length && proposal) {
        const ids = new Set([proposal.task.taskId, ...checked]);
        const rows = [proposal.task, ...proposal.descendants].filter((row) => ids.has(row.taskId));
        const result = await api.acceptFamily(task.id,
          rows.map((row) => ({ taskId: row.taskId, fingerprint: row.fingerprint, confirmUnverified: !!row.unexecutedVerification && familyAck })),
          commitParam);
        setChecked([]);
        const stale = await refreshAfterMutation();
        notify((result.ok ? `统一验收已完成，共 ${result.completed.length} 个任务`
          : `已完成 ${result.completed.length} 个任务；其余暂停：${result.error}`) + stale);
        await plan.refresh();
        return;
      }
      const result = await api.acceptTask(task.id, verifyState === "acknowledged", commitParam, gateIntent);
      setAutoCommit(result.autoCommit ? { taskId: task.id, outcome: result.autoCommit } : null);
      if (!result.accepted) {
        const gateReason = result.reason.startsWith("accept_gate");
        setFailure(result);
        // 回执说「在跑」就先把这份事实留住再解锁：只等 reload 不够，它读失败时同样兑现。
        if (result.reason === "accept_gate_running") gate.holdRunning(result.gate?.status === "running" ? result.gate : null);
        if (gateReason || result.reason === "merge_conflict") await gate.reload();
        if (result.confirmationRequired === "confirmUnverified") {
          await refreshAfterMutation();
          setProposal(plan.view);
          setLayer("confirm");
          return;
        }
        notify(gateReason ? gateNotice(result) : result.reason === "merge_conflict"
          ? result.conflictHandoff?.notified ? "合并冲突已交给任务处理" : "合并冲突，没能交给任务"
          : result.completedMerge || result.completedTag ? result.error : `验收没完成：${result.error}`);
        if (result.completedMerge || result.completedTag) await refreshAfterMutation();
        return;
      }
      const stale = await refreshAfterMutation();
      notify(acceptMessage(result) + stale);
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const returned = async (outcome: ReturnOutcome) => {
    const stale = await refreshAfterMutation();
    if (outcome.scheduled) notify(`已打回；任务还在跑，意见已排队，跑完自动送进会话${stale}`);
    else if (stale) notify(`已打回${stale}`);
    onReturned?.();
  };

  const pendingCommit = hasPendingAcceptCommit(task);
  const mainLabel = midGate ? "放行，继续下一站" : family.length ? `验收 ${family.length} 个任务` : "验收通过";
  const rowDisabled = archived || inFlight || busy;
  return (
    <div className={`acc ${className}`}>
      <header className="acc-bar">
        <div className="acc-lead">{lead}</div>
        <div className="acc-actions">
          {settled ? <>
            <span className="acc-done"><CheckCircle size={13} weight="fill" aria-hidden="true" />{task.stage === "merged" ? "已合并" : "已验收"}</span>
            {onPostMergeReview && !pendingCommit && <button type="button" className="acc-link" onClick={onPostMergeReview}>{facts.postMergeLabel}</button>}
          </> : <>
            <button ref={rejectRef} type="button" className="acc-btn" aria-expanded={layer === "reject"} disabled={archived || inFlight || busy}
              onClick={() => setLayer(layer === "reject" ? null : "reject")}>
              <ArrowUUpLeft size={13} aria-hidden="true" />{task.mode === "duet" ? "打回再讨论" : "打回"}
            </button>
            <button ref={acceptRef} type="button" className="acc-btn is-primary" aria-expanded={confirming} disabled={acceptDisabled}
              aria-busy={loading || undefined} onClick={() => (confirming ? setLayer(null) : openConfirm())}>
              {loading ? <i className="acc-spin" aria-hidden="true" /> : <Check size={13} weight="bold" aria-hidden="true" />}{mainLabel}
            </button>
          </>}
          {trailing}
        </div>
      </header>
      <div className="acc-checks" role="list" aria-label="验收前提">
        {factBlocks.map((row) => (
          <CheckRow key={row.key} check={row.key} tone={row.tone} text={row.text}
            detail={row.key === "host" && block?.detail ? <p className="acc-detail-text">{block.detail}</p> : undefined}
            tools={row.retry ? <CheckAction onClick={row.retry}>重试</CheckAction> : undefined} />
        ))}
        {failure?.taskId === task.id && (!settled || !!failure.completedMerge || !!failure.completedTag)
          && failure.reason !== issue?.reason && <FailureCheck failure={failure} gateReadable={!!gate.state && !gate.error} />}
        <PendingMergeCheck task={task} notify={notify} onTaskUpdated={onTaskUpdated} />
        {autoCommit?.taskId === task.id && <AutoCommitCheck outcome={autoCommit.outcome} />}
        {!midGate && !settled && <WorkspaceCheck key={task.id} task={task} notify={notify} disabled={rowDisabled} />}
        {!midGate && <GateCheck task={task} gate={gate} canManage={canManage} settled={settled} atFinalGate={!midGate}
          disabled={rowDisabled} editRequested={editGate} onEditClosed={() => setEditGate(false)} notify={notify} />}
        {!midGate && !settled && issue && <BaselineCheck task={task} issue={issue} disabled={rowDisabled} reload={gate.reload} notify={notify} />}
        {worktreeChecks && <DependencyChecks task={task} plan={plan} checked={checked} onChecked={setChecked}
          disabled={rowDisabled} notify={notify} onTaskUpdated={onTaskUpdated} />}
        {facts.warning && !settled && <CheckRow check="review-warning" tone="warn" text={facts.warning}
          tools={onOpenReview ? <CheckAction onClick={onOpenReview}>看审查</CheckAction> : undefined} />}
        {!settled && verification.verification && !family.length && (
          <CheckRow check="verification" tone="warn" text="独立验证尚未执行" state={midGate ? "放行后走到验证站" : null}
            detail={<p className="acc-detail-text">{verification.verification.message}</p>} />
        )}
      </div>
      {confirming && (
        <AcceptConfirm
          anchorRef={acceptRef}
          steps={shownSteps}
          view={view}
          gate={confirmGate}
          commitChoosable={commitChoosable}
          commitDefault={commitDefault}
          verification={{ state: verifyState, error: verification.error }}
          source={plan.view?.task.sourceBranch ?? "任务分支"}
          family={family.map((row) => row.title)}
          waiting={acceptDisabled}
          canSetGate={!midGate && canManage === true && !!gate.state && !gate.state.command}
          onRun={setRunChoice}
          onCommit={setCommitChoice}
          onAcknowledge={(value) => (family.length ? setFamilyAck(value) : verification.setAcknowledged(value))}
          onRetryDefault={commitDefault.reload}
          onRetryVerification={verification.reload}
          onSetGate={() => { setLayer(null); setEditGate(true); }}
          onConfirm={() => void accept()}
          onClose={() => setLayer(null)}
        />
      )}
      {layer === "reject" && (
        <AcceptReject task={task} anchorRef={rejectRef} onClose={() => setLayer(null)} onSent={returned} notify={notify} />
      )}
    </div>
  );
}
