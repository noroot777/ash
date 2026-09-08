import { useCallback, useEffect, useState } from "react";
import type { BranchPlanView, Task, TaskListItem } from "@ash/shared";
import { familySelectionBlock } from "@ash/shared/branch-plan";
import { api } from "../lib/api.ts";
import { ConfirmDialog } from "../task-detail/ConfirmDialog.tsx";

export function useBranchPlan(task: TaskListItem) {
  const [view, setView] = useState<BranchPlanView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try { setView(await api.branchPlan(task.id)); setError(null); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, [task.id]);
  useEffect(() => {
    setView(null);
    if (!task.useWorktree) return;
    let alive = true;
    const load = () => api.branchPlan(task.id).then(
      value => { if (alive) { setView(value); setError(null); } },
      reason => { if (alive) setError(String(reason)); },
    );
    void load();
    const timer = setInterval(() => { void load(); }, 15_000);
    return () => { alive = false; clearInterval(timer); };
  }, [task.id, task.updatedAt, task.useWorktree]);
  return { view, error, refresh };
}

const taskHref = (projectId: string, taskId: string) => `/?${new URLSearchParams({ project: projectId, task: taskId })}`;

export function BranchAcceptancePanel({ task, notify, onTaskUpdated }: { task: TaskListItem; notify: (text: string) => void; onTaskUpdated?: (task: Task) => void }) {
  const { view, error, refresh } = useBranchPlan(task);
  const [action, setAction] = useState<"update" | "family" | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [checked, setChecked] = useState<string[]>([]);
  const [proposal, setProposal] = useState<BranchPlanView | null>(null);
  useEffect(() => { setChecked([]); setAction(null); setMessage(""); }, [task.id]);
  if (!task.useWorktree) return null;
  if (error) return <p className="single-review-error" role="alert">验收依赖读取失败：{error}<button onClick={() => void refresh()}>重试</button></p>;
  if (!view) return <p>正在检查验收依赖…</p>;
  const dep = view.task.dependency;
  const descendants = view.descendants.filter(row => row.stage !== "accepted");
  if (!view.task.startCommit && !dep && !descendants.length) return null;
  const selection = [view.task, ...descendants.filter(row => checked.includes(row.taskId))];
  const selectedProposal = proposal ? [proposal.task, ...proposal.descendants.filter(row => checked.includes(row.taskId))] : [];
  const selectionBlock = familySelectionBlock([view.task, ...view.descendants], new Set(selection.map(row => row.taskId)));
  const run = async () => {
    if (!proposal) return;
    setBusy(true);
    try {
      if (action === "update") {
        await api.updateTaskBase(task.id, proposal.task.sourceCommit!);
        setMessage("基线已更新，请核对改动并按影响范围重新验证。");
      } else {
        const blocked = familySelectionBlock([proposal.task, ...proposal.descendants], new Set(selectedProposal.map(row => row.taskId)));
        if (blocked) { setMessage(blocked.error); return; }
        const result = await api.acceptFamily(task.id, selectedProposal.map(row => ({ taskId: row.taskId, fingerprint: row.fingerprint })));
        setMessage(result.ok ? `统一验收已完成，共 ${result.completed.length} 个任务。`
          : `已完成 ${result.completed.length} 个任务；其余暂停：${result.error}`);
      }
      if (onTaskUpdated) await api.task(task.id).then(onTaskUpdated).catch(() => {});
      notify("验收操作结果已更新");
    } catch (e) { setMessage(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); setAction(null); await refresh(); }
  };
  const open = (next: "update" | "family") => {
    if (next === "family" && selectionBlock) { setMessage(selectionBlock.error); return; }
    setProposal(view); setAction(next);
  };
  return (
    <section className="branch-acceptance-panel" aria-label="派生与验收依赖">
      <header><b>派生与验收</b><button type="button" disabled={busy} onClick={() => void refresh()}>刷新依赖</button></header>
      <dl>
        <div><dt>开工起点</dt><dd>{view.task.startCommit?.slice(0, 12) || "旧任务未记录"}</dd></div>
        <div><dt>最终合入</dt><dd>{view.task.targetBranch || "未确定"}</dd></div>
      </dl>
      {dep && <p role="status">{dep.message} {dep.taskId && <a href={taskHref(task.projectId, dep.taskId)}>查看父任务</a>}</p>}
      {dep?.state === "needs_update" && <button type="button" disabled={busy || (!!view.task.blocker && !view.task.baseUpdatePending) || task.stage === "accepted" || task.stage === "merged"} onClick={() => open("update")}>更新子分支基线</button>}
      {descendants.length > 0 && <>
        <p>可在这里按父子依赖顺序统一验收。勾选已核对的子任务；发生冲突时保留已完成的合并，并暂停后续步骤。</p>
        <ul>{descendants.map(row => <li key={row.taskId}>
          <label><input type="checkbox" disabled={busy || !!row.blocker} checked={checked.includes(row.taskId)} onChange={e => setChecked(ids => e.target.checked ? [...ids, row.taskId] : ids.filter(id => id !== row.taskId))} />{row.title}</label>
          <span>{row.blocker || `${row.strategy} → ${row.targetBranch}`}</span>
          <a href={taskHref(row.projectId, row.taskId)}>查看改动</a>
          {row.dependency && <div className="branch-dependency-detail">
            <span>父任务：{row.dependency.taskId ? <a href={taskHref(row.projectId, row.dependency.taskId)}>{row.dependency.title}</a> : row.dependency.title}</span>
            <span>{row.dependency.message}</span>
          </div>}
        </li>)}</ul>
        {checked.length > 0 && selectionBlock && <p role="alert">{selectionBlock.error}</p>}
        <button type="button" disabled={busy || !checked.length || !!view.task.blocker || !!selectionBlock} onClick={() => open("family")}>验收父任务及所选子任务（{selection.length}）</button>
      </>}
      {message && <p role="status">{message}</p>}
      {action && proposal && <ConfirmDialog
        title={action === "update" ? "更新子分支基线？" : "统一验收所选任务？"}
        message={action === "update"
          ? "在临时工作区尝试 rebase，成功后更新子分支并保留旧提交。旧审查可能过期，需要核对改动与验证范围；发生冲突则不修改原工作区。"
          : "下面列出的版本将按父子顺序执行各自的合并、清理及验收后步骤。已完成的合并不会因后续任务失败而撤销。提交或范围发生变化时会停止。"}
        confirmLabel={action === "update" ? "更新基线" : "确认统一验收"} danger busy={busy} onConfirm={() => void run()} onClose={() => { if (!busy) setAction(null); }}>
        {action === "family" && <ul>{selectedProposal.map(row => <li key={row.taskId}>{row.title} · {row.sourceCommit?.slice(0, 8) || "已验收"} · {row.strategy} → {row.targetBranch}</li>)}</ul>}
      </ConfirmDialog>}
    </section>
  );
}
