import { useEffect, useState } from "react";
import type { TaskListItem, TaskWorkspaceLeftover } from "@ash/shared";
import { api } from "../lib/api.ts";
import { ConfirmDialog } from "../task-detail/ConfirmDialog.tsx";
import { CheckAction, CheckRow } from "./CheckRow.tsx";

/**
 * 有子任务合入**这个任务的分支**时那一行：这个任务的工作区目录还占着那条分支，子任务就合不进来。
 * 出路是释放目录、保留分支（父任务之后仍可继续执行）；目录已经不在时如实说占用解没解除。
 * 重读失败时手上那份照旧摆着，但状态换成「待核对」并给本行重试 —— 那份结论可能已经过期。
 */
export function ReleaseCheck({ task, disabled, blocker, onReleased, notify }: {
  task: TaskListItem;
  disabled: boolean;
  blocker: string | null;
  onReleased: () => Promise<void>;
  notify: (message: string) => void;
}) {
  const [workspace, setWorkspace] = useState<TaskWorkspaceLeftover | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [proposal, setProposal] = useState<{ workspace: TaskWorkspaceLeftover; fingerprint: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    void api.taskWorkspace(task.id).then((value) => { if (alive) { setWorkspace(value); setReadError(null); } })
      .catch((e) => { if (alive) setReadError(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, [task.id, task.updatedAt, attempt]);
  const open = async () => {
    setBusy(true); setError("");
    try {
      const [latest, view] = await Promise.all([api.taskWorkspace(task.id), api.branchPlan(task.id)]);
      setWorkspace(latest);
      if (!latest.branch) { notify("任务分支不存在，请先恢复分支再释放目录。"); return; }
      if (latest.path) setProposal({ workspace: latest, fingerprint: view.task.fingerprint });
      else await onReleased();
    } catch (e) { notify(e instanceof Error ? e.message : String(e)); }
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
  if (!workspace) {
    return readError
      ? <CheckRow check="release" tone="block" text="工作区读不出来" state={readError}
        tools={<CheckAction onClick={() => setAttempt((n) => n + 1)}>重试</CheckAction>} />
      : null;
  }
  const released = !workspace.path && !!workspace.branch;
  const stale = readError ? `待核对：${readError}` : null;
  const retry = readError ? <CheckAction onClick={() => setAttempt((n) => n + 1)}>重试</CheckAction> : null;
  return (
    <>
      {released
        ? blocker
          ? <CheckRow check="release" tone="block" text="工作区目录已不在，占用还没解除" state={stale} tools={retry}
            detail={<p className="acc-detail-text">{blocker}</p>} />
          : <CheckRow check="release" tone="passed" text="工作区目录已释放" tools={retry}
            state={stale ?? <>分支 <code>{workspace.branch}</code> 保留</>} />
        : <CheckRow check="release" tone="idle" text="子任务合入这个任务的分支" state={stale ?? "工作区目录还占着它"}
          tools={<>{retry}<CheckAction disabled={disabled} busy={busy} onClick={() => void open()}>释放目录</CheckAction></>} />}
      {proposal && <ConfirmDialog title="释放工作区目录？"
        message="移除下面的目录，保留任务记录、分支和已提交的代码。有未提交文件时会拒绝。释放后可验收子任务，这个任务之后仍可继续执行。"
        confirmLabel="释放目录，保留分支" busy={busy} confirmDisabled={disabled}
        onConfirm={() => void run()} onClose={() => { if (!busy) { setProposal(null); setError(""); } }}>
        <p>目录：<code>{proposal.workspace.path}</code></p><p>保留分支：<code>{proposal.workspace.branch}</code></p>
        {error && <p role="alert" style={{ whiteSpace: "pre-line" }}>{error}</p>}
      </ConfirmDialog>}
    </>
  );
}
