import { useState } from "react";
import type { BranchPlanEntry } from "@ash/shared";
import { api } from "../lib/api.ts";

export function MergeTargetEditor({ plan, disabled, onChanged }: { plan: BranchPlanEntry; disabled: boolean; onChanged: () => Promise<void> }) {
  const [branches, setBranches] = useState<string[] | null>(null);
  const [target, setTarget] = useState("");
  const [fingerprint, setFingerprint] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const open = async () => {
    setBusy(true); setMessage("");
    try {
      setBranches((await api.projectBranches(plan.projectId)).branches.filter(branch => branch !== plan.sourceBranch));
      setTarget(""); setFingerprint(plan.fingerprint);
    }
    catch (e) { setMessage(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const save = async () => {
    if (disabled || busy || !target) return;
    setBusy(true);
    try {
      await api.changeMergeTarget(plan.taskId, target, fingerprint);
      setBranches(null);
      setMessage(`合入目标已改为 ${target}，请重新核对依赖与改动。`);
      await onChanged();
    } catch (e) { setMessage(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  return <div>
    {!branches ? <button type="button" disabled={disabled || busy} onClick={() => void open()}>重设合入目标</button> : <>
      <p>为这条任务选择最终合入的本地分支。开工提交保持原样，验收依赖会重新检查。</p>
      <label>合入目标 <select value={target} disabled={disabled || busy} onChange={e => setTarget(e.target.value)}>
        <option value="">请选择分支</option>
        {branches.map(branch => <option key={branch} value={branch}>{branch}</option>)}
      </select></label>{" "}
      {/^(ash|harness)\//.test(target) && <p role="status">所选目标是任务分支。如仍被工作区占用，请先在目标任务的「派生与验收」中释放工作区目录（保留分支），再单独验收本任务；不能与目标任务一起统一验收。</p>}
      <button type="button" disabled={disabled || busy || !target} onClick={() => void save()}>保存合入目标</button>{" "}
      <button type="button" disabled={busy} onClick={() => setBranches(null)}>取消</button>
      {!branches.length && <p>当前没有可选的本地分支；建立分支后重新打开此处。</p>}
    </>}
    {message && <p role="status">{message}</p>}
  </div>;
}
