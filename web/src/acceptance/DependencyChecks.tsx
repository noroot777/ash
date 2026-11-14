import { useState } from "react";
import type { BranchPlanView, Task, TaskListItem } from "@ash/shared";
import { familyAcceptanceNotices, familySelectionBlock } from "@ash/shared/branch-plan";
import { api } from "../lib/api.ts";
import { ConfirmDialog } from "../task-detail/ConfirmDialog.tsx";
import type { useBranchPlan } from "../review/useBranchPlan.ts";
import { BaseUpdateRecoveryControl } from "./BaseUpdateRecoveryControl.tsx";
import { CheckAction, CheckRow } from "./CheckRow.tsx";
import { ReleaseCheck } from "./ReleaseCheck.tsx";

type Plan = ReturnType<typeof useBranchPlan>;

const taskHref = (projectId: string, taskId: string) => `/?${new URLSearchParams({ project: projectId, task: taskId })}`;

/** 这一按被依赖挡住的那句（红行）；null = 依赖不拦。和服务端 acceptanceGuard 的依赖判据同源。 */
export function dependencyBlocked(view: BranchPlanView | null, error: string | null): boolean {
  if (error) return true;
  const entry = view?.task;
  if (!entry) return false;
  if (entry.blocker) return true;
  return !!entry.dependency && entry.dependency.state !== "ready" && entry.strategy !== "tag";
}

/** 勾上的派生任务里第一处不能一起验收的地方。 */
export function selectionBlockOf(view: BranchPlanView | null, checked: readonly string[]) {
  if (!view || !checked.length) return null;
  const selection = new Set([view.task.taskId, ...checked]);
  return familySelectionBlock([view.task, ...view.descendants], selection);
}

/**
 * 前提列里「依赖与派生」那几行：读不出来、挡路的原因、父任务成果合没合进来、没结算完的基线更新、
 * 子任务合入这里时的工作区占用，以及可以一起验收的派生任务（勾上它们，主按钮就变成「验收 N 个任务」）。
 */
export function DependencyChecks({ task, plan, checked, onChecked, disabled, notify, onTaskUpdated }: {
  task: TaskListItem;
  plan: Plan;
  checked: string[];
  onChecked: (ids: string[]) => void;
  disabled: boolean;
  notify: (message: string) => void;
  onTaskUpdated?: (task: Task) => void;
}) {
  const [updating, setUpdating] = useState<BranchPlanView | null>(null);
  const [busy, setBusy] = useState(false);
  const { view, error, refresh } = plan;
  const settled = task.stage === "accepted" || task.stage === "merged";
  const reloadTask = async () => { if (onTaskUpdated) await api.task(task.id).then(onTaskUpdated).catch(() => {}); };
  if (!view) {
    return error
      ? <CheckRow check="dependency" tone="block" text="依赖读不出来" state={error}
        tools={<CheckAction onClick={() => void refresh()}>重试</CheckAction>} />
      : null;
  }
  const entry = view.task;
  const dep = entry.dependency;
  const descendants = view.descendants.filter((row) => row.stage !== "accepted");
  const selection = [entry, ...descendants.filter((row) => checked.includes(row.taskId))];
  const selectionBlock = selectionBlockOf(view, checked);
  const locked = disabled || busy || !!task.archived || ["running", "queued"].includes(task.status);
  const updateBase = async () => {
    if (!updating?.task.sourceCommit) return;
    setBusy(true);
    try {
      await api.updateTaskBase(task.id, updating.task.sourceCommit);
      notify("基线已更新，请核对改动并按影响范围重新验证");
      await reloadTask();
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
      setUpdating(null);
      await refresh();
    }
  };
  const releases = descendants.some((row) => row.targetTaskId === task.id || (row.dependency?.legacyTarget && row.dependency.taskId === task.id));
  return (
    <>
      {error && <CheckRow check="dependency" tone="block" text="依赖读不出来" state={error}
        tools={<CheckAction onClick={() => void refresh()}>重试</CheckAction>} />}
      {entry.blocker && <CheckRow check="blocker" tone="block" text={entry.blockerLabel ?? entry.blocker.split("\n")[0]}
        detail={entry.blockerLabel || entry.blocker.includes("\n") ? <p className="acc-detail-text">{entry.blocker}</p> : undefined} />}
      {dep && (
        <CheckRow
          check="parent"
          tone={dep.state === "ready" ? "passed" : entry.strategy === "tag" ? "warn" : "block"}
          text={dep.message}
          tools={<>
            {dep.taskId && <a className="acc-link" href={taskHref(task.projectId, dep.taskId)}>查看父任务</a>}
            {dep.state === "needs_update" && !settled && (
              <CheckAction disabled={locked || (!!entry.blocker && !entry.baseUpdatePending)} onClick={() => setUpdating(view)}>更新基线</CheckAction>
            )}
          </>}
        />
      )}
      {entry.baseUpdatePending && (
        <CheckRow check="base-update" tone="block" text="上次基线更新没结算完"
          tools={<BaseUpdateRecoveryControl key={task.id} taskId={task.id} notify={notify}
            disabled={locked || task.handoff?.direction === "out"}
            onAbandoned={async (message) => { notify(message); await refresh(); await reloadTask(); }} />} />
      )}
      {releases && <ReleaseCheck key={task.id} task={task} notify={notify}
        blocker={descendants.find((row) => row.targetTaskId === task.id && row.targetWorkspaceBlocker)?.targetWorkspaceRecovery ?? null}
        disabled={locked || task.handoff?.direction === "out" || entry.baseUpdatePending}
        onReleased={async () => { await refresh(); await reloadTask(); }} />}
      {!settled && descendants.length > 0 && <>
        <div className="acc-check-lead" role="presentation">派生任务</div>
        {descendants.map((row) => (
          <div key={row.taskId} className={`acc-check is-child${row.blocker ? " is-block" : ""}`} data-check="child" role="listitem">
            <div className="acc-check-line">
              <label className="acc-check-main">
                <input type="checkbox" disabled={locked || !!row.blocker} checked={checked.includes(row.taskId)}
                  onChange={(event) => onChecked(event.target.checked ? [...checked, row.taskId] : checked.filter((id) => id !== row.taskId))} />
                <span className="acc-check-text">{row.title}</span>
                <span className="acc-check-state">{row.blocker ? row.blockerLabel ?? "不能一起验收" : <>→ <code>{row.targetBranch}</code></>}</span>
              </label>
              <span className="acc-check-tools"><a className="acc-link acc-reveal" href={taskHref(row.projectId, row.taskId)}>看改动</a></span>
            </div>
            {(row.blocker || row.dependency) && (
              <p className="acc-check-note">{row.blocker || `父任务「${row.dependency!.title}」：${row.dependency!.message}`}</p>
            )}
          </div>
        ))}
        {selectionBlock && <CheckRow check="selection" tone="block" text={selectionBlock.error} />}
        {familyAcceptanceNotices(selection).map((notice) => <CheckRow key={notice} check="family-notice" tone="warn" text={notice} />)}
      </>}
      {updating && <ConfirmDialog
        title="更新子分支基线？"
        message="在临时工作区尝试 rebase，成功后更新子分支并保留旧提交；冲突则不动原工作区。旧审查可能过期，更新后请核对改动并重新验证。"
        confirmLabel="更新基线" danger busy={busy}
        confirmDisabled={plan.loading || plan.refreshing || !!plan.error}
        onConfirm={() => void updateBase()} onClose={() => { if (!busy) setUpdating(null); }}>
        <p>{updating.task.dependency?.message}</p>
      </ConfirmDialog>}
    </>
  );
}
