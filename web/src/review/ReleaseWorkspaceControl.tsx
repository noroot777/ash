import { useEffect, useState } from "react";
import type { TaskListItem, TaskWorkspaceLeftover } from "@ash/shared";
import { api } from "../lib/api.ts";
import { ConfirmDialog } from "../task-detail/ConfirmDialog.tsx";

export function ReleaseWorkspaceControl({ task, disabled, blocker, onReleased }: {
  task: TaskListItem;
  disabled: boolean;
  blocker: string | null;
  onReleased: () => Promise<void>;
}) {
  const [workspace, setWorkspace] = useState<TaskWorkspaceLeftover | null>(null);
  const [proposal, setProposal] = useState<{ workspace: TaskWorkspaceLeftover; fingerprint: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    void api.taskWorkspace(task.id).then(value => { if (alive) setWorkspace(value); })
      .catch(e => { if (alive) setError(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, [task.id, task.updatedAt]);
  const open = async () => {
    setBusy(true); setError("");
    try {
      const [latest, view] = await Promise.all([api.taskWorkspace(task.id), api.branchPlan(task.id)]);
      setWorkspace(latest);
      if (!latest.branch) { setError("任务分支不存在，请先恢复分支再释放目录。"); return; }
      if (latest.path) setProposal({ workspace: latest, fingerprint: view.task.fingerprint });
      else await onReleased();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const run = async () => {
    if (!proposal || busy || disabled) return;
    setBusy(true); setError("");
    try {
      await api.releaseTaskWorkspace(task.id, proposal.fingerprint);
      setProposal(null);
      setWorkspace(await api.taskWorkspace(task.id));
      await onReleased();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  return <div>
    {workspace && !workspace.path && workspace.branch
      ? blocker
        ? <p role="alert">父任务工作区目录已不存在，但占用登记尚未解除。{blocker}</p>
        : <p role="status">父任务工作区目录已不存在，分支 {workspace.branch} 仍保留。工作区占用已解除，请根据最新依赖继续验收。</p>
      : <button type="button" disabled={disabled || busy} onClick={() => void open()}>释放工作区目录（保留分支）</button>}
    {disabled && <p>父任务正在执行、只读或基线更新未结算时，暂不能释放工作区。</p>}
    {error && !proposal && <p role="alert">{error}</p>}
    {proposal && <ConfirmDialog title="释放父任务工作区目录？"
      message="将移除下面的工作区目录，保留父任务记录、分支及已提交的代码。存在未提交文件时会拒绝清理。释放后可验收子任务，父任务之后仍可继续执行。"
      confirmLabel="释放目录，保留分支" busy={busy} confirmDisabled={disabled}
      onConfirm={() => void run()} onClose={() => { if (!busy) { setProposal(null); setError(""); } }}>
      <p>父任务：{task.title}</p><p>目录：<code>{proposal.workspace.path}</code></p><p>保留分支：<code>{proposal.workspace.branch}</code></p>
      {error && <p role="alert">{error}</p>}
    </ConfirmDialog>}
  </div>;
}
