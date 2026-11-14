import { useState } from "react";
import type { TaskListItem, TaskWorkspaceLeftover } from "@ash/shared";
import { api } from "../lib/api.ts";
import { ConfirmDialog } from "../task-detail/ConfirmDialog.tsx";
import { CheckAction, CheckRow } from "./CheckRow.tsx";
import { useRowRead } from "./useRowRead.ts";

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
  // 现场只有一条读法：首读、任务更新后的重读、本行重试、释放前后的核对都走它，读失败一律落在本行。
  const read = useRowRead<TaskWorkspaceLeftover>(task.id, () => api.taskWorkspace(task.id), true, [task.updatedAt]);
  const workspace = read.value;
  const [proposal, setProposal] = useState<{ workspace: TaskWorkspaceLeftover; fingerprint: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const open = async () => {
    setBusy(true); setError("");
    try {
      // 按下那一刻再核对一次现场：摆在这一行的可能是几分钟前的样子。读不到就落回本行的待核对。
      const latest = await read.reload();
      if (!latest) return;
      const view = await api.branchPlan(task.id);
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
    } catch (e) {
      // 动作本身失败才留在确认框里说；框还开着，看得见。
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
      return;
    }
    // 释放已经生效：先收掉确认框，再核对现场。核对失败落在本行（待核对 + 重试），不跟着框一起消失。
    setProposal(null);
    setBusy(false);
    notify("工作区目录已释放，分支保留");
    await Promise.all([read.reload(), onReleased()]);
  };
  if (!workspace) {
    return read.error
      ? <CheckRow check="release" tone="block" text="工作区读不出来" state={read.error}
        tools={<CheckAction onClick={() => void read.reload()}>重试</CheckAction>} />
      : null;
  }
  const released = !workspace.path && !!workspace.branch;
  const stale = read.error ? `待核对：${read.error}` : null;
  const retry = read.error ? <CheckAction onClick={() => void read.reload()}>重试</CheckAction> : null;
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
