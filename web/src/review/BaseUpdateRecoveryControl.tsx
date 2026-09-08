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
  const [acknowledged, setAcknowledged] = useState(false);
  const open = async () => {
    if (disabled || busy) return;
    setBusy(true); setError(""); setAcknowledged(false);
    try { setProposal(await api.baseUpdateRecovery(taskId)); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const abandon = async () => {
    if (!proposal || proposal.resolution === "blocked" || proposal.blocker || disabled || busy) return;
    if (proposal.resolution === "manual" && !acknowledged) return;
    setBusy(true); setError("");
    try {
      const result = await api.abandonTaskBaseUpdate(taskId, proposal.fingerprint, proposal.resolution, acknowledged);
      setProposal(null);
      await onAbandoned(result.message);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  return <div>
    <button type="button" disabled={disabled || busy} onClick={() => void open()}>处理未完成的基线更新</button>
    {error && !proposal && <p role="alert">{error}</p>}
    {proposal && <ConfirmDialog title={proposal.resolution === "blocked" ? "暂时无法读取恢复差异" : proposal.resolution === "manual" ? "核对基点并手动解除挂起？" : proposal.resolution === "complete" ? "完成已生效的基线更新？" : "放弃本次基线更新？"}
      confirmLabel={proposal.resolution === "blocked" ? "暂时无法处理" : proposal.resolution === "manual" ? "保留代码并解除挂起" : proposal.resolution === "complete" ? "确认完成基线更新" : "确认放弃基线更新"}
      message={proposal.resolution === "blocked"
        ? "恢复差异暂时无法读取，目前不能确认处理后的改动范围。当前代码和挂起记录均未修改，请关闭后刷新重试。"
        : proposal.resolution === "complete"
        ? "分支已包含本次更新的准备结果。将按更新后的起点完成结算，使 diff 只展示任务自身的改动；保留当前提交、之后新增的提交和工作区文件，并保存恢复备份。完成后请核对 diff 并重新验证。"
        : proposal.resolution === "manual"
          ? "分支历史已变化或更新记录无法读取，不能自动判定原更新是否完成。请核对拟采用的基点及实际差异；手动解除挂起会先备份当前提交，保留分支和工作区文件，不补写原更新的完成凭据。之后需要重新审查。"
        : "解除这次未结算的更新记录，保留当前分支、工作区文件及开工记录。可读取的更新前提交和准备结果会保存在恢复备份中。之后仍需重新核对验收依赖。"}
      busy={busy} danger confirmDisabled={disabled || !!proposal.blocker || (proposal.resolution === "manual" && !acknowledged)} onConfirm={() => void abandon()} onClose={() => { if (!busy) { setProposal(null); setError(""); } }}>
      <dl style={{ overflowWrap: "anywhere" }}>
        <dt>当前分支</dt><dd>{proposal.branch}</dd>
        <dt>当前提交</dt><dd>{proposal.currentCommit || "分支已不存在"}</dd>
        <dt>当前记录的开工提交</dt><dd>{proposal.startCommit || "未记录"}</dd>
        <dt>处理后开工提交</dt><dd>{proposal.resolvedStartCommit || (proposal.currentCommit ? "尚不能确定" : "无分支，等待重新开工")}</dd>
        <dt>更新前提交</dt><dd>{proposal.oldCommit || "记录无法读取"}</dd>
        <dt>准备结果</dt><dd>{proposal.preparedCommit || "记录无法读取"}</dd>
      </dl>
      {proposal.blocker && <p role="alert">{proposal.blocker}</p>}
      {proposal.existingBackups.length > 0 && <details style={{ overflowWrap: "anywhere" }}><summary>现存备份（{proposal.existingBackups.length}）</summary><ul>{proposal.existingBackups.map(b => <li key={b.ref}><code>{b.ref}</code> · {b.commit}</li>)}</ul></details>}
      {proposal.backups.length > 0 && <details style={{ overflowWrap: "anywhere" }}><summary>确认时将保存的备份（{proposal.backups.length}）</summary><ul>{proposal.backups.map(b => <li key={b.ref}><code>{b.ref}</code> · {b.commit}</li>)}</ul></details>}
      {proposal.unavailableCommits.length > 0 && <p role="alert">以下提交对象已无法读取，无法另存恢复备份：{proposal.unavailableCommits.join("、")}。当前代码仍会保留。</p>}
      {proposal.manual && proposal.resolution === "manual" && <section aria-label="恢复差异预览">
        <p role="status">{proposal.manual.basis}</p>
        <p>处理后的 diff 文件：{proposal.manual.files.join("、") || "无"}</p>
        <pre style={{ maxHeight: 160, overflow: "auto", fontSize: 11 }}>{proposal.manual.diff || "该起点到当前提交没有差异。"}</pre>
        {proposal.manual.truncated && <p role="status">此处 diff 已截断；文件清单完整，解除后请在审查页逐文件核对。</p>}
        <label><input type="checkbox" checked={acknowledged} onChange={e => setAcknowledged(e.target.checked)} />我已核对基点和差异范围，保留当前代码并重新审查</label>
      </section>}
      {error && <p role="alert">{error}</p>}
    </ConfirmDialog>}
  </div>;
}
