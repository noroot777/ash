import { useState } from "react";
import type { BaseUpdateRecovery } from "@ash/shared/branch-plan";
import { api } from "../lib/api.ts";
import { ConfirmDialog } from "../task-detail/ConfirmDialog.tsx";

export function BaseUpdateRecoveryControl({ taskId, disabled, onAbandoned }: {
  taskId: string;
  disabled: boolean;
  onAbandoned: (message: string) => Promise<void>;
}) {
  const [proposal, setProposal] = useState<BaseUpdateRecovery | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const open = async () => {
    if (disabled || busy) return;
    setBusy(true); setError("");
    try { setProposal(await api.baseUpdateRecovery(taskId)); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const abandon = async () => {
    if (!proposal || disabled || busy) return;
    setBusy(true); setError("");
    try {
      const result = await api.abandonTaskBaseUpdate(taskId, proposal.fingerprint);
      setProposal(null);
      await onAbandoned(result.message);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  return <div>
    <button type="button" disabled={disabled || busy} onClick={() => void open()}>放弃本次基线更新</button>
    {error && !proposal && <p role="alert">{error}</p>}
    {proposal && <ConfirmDialog title="放弃本次基线更新？" confirmLabel="确认放弃基线更新"
      message="解除这次未结算的更新记录，保留当前分支、工作区文件及开工记录。可读取的更新前提交和准备结果会保存在恢复备份中。之后仍需重新核对验收依赖。"
      busy={busy} danger confirmDisabled={disabled} onConfirm={() => void abandon()} onClose={() => { if (!busy) { setProposal(null); setError(""); } }}>
      <dl>
        <dt>当前分支</dt><dd>{proposal.branch}</dd>
        <dt>当前提交</dt><dd>{proposal.currentCommit || "分支已不存在"}</dd>
        <dt>保留的开工提交</dt><dd>{proposal.startCommit || "未记录"}</dd>
        <dt>更新前提交</dt><dd>{proposal.oldCommit || "记录无法读取"}</dd>
        <dt>准备结果</dt><dd>{proposal.preparedCommit || "记录无法读取"}</dd>
      </dl>
      {proposal.backups.length > 0 && <details><summary>恢复备份（{proposal.backups.length}）</summary><ul>{proposal.backups.map(b => <li key={b.ref}><code>{b.ref}</code> · {b.commit}</li>)}</ul></details>}
      {proposal.unavailableCommits.length > 0 && <p role="alert">以下提交对象已无法读取，无法另存恢复备份：{proposal.unavailableCommits.join("、")}。当前代码仍会保留。</p>}
      {error && <p role="alert">{error}</p>}
    </ConfirmDialog>}
  </div>;
}
