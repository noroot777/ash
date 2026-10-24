import { useState } from "react";
import { api } from "../lib/api.ts";

export function AcceptGateForceRelease({ taskId, runId, reload, notify }: {
  taskId: string; runId: string; reload: () => Promise<unknown>; notify: (message: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const release = async () => {
    setBusy(true);
    try {
      await api.forceReleaseAcceptGate(taskId, runId);
      notify("已确认风险并强制释放；没有取得退出证据，也没有通过测试。请检查保留的运行目录和残留进程。");
      await reload();
    } catch (error) { notify(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  if (!confirming) return <button type="button" onClick={() => setConfirming(true)}>停止证据丢失？确认风险并强制释放…</button>;
  return <div role="alert">
    <p>没有证据证明残留进程已退出。强制释放不等于停止或测试通过；残留进程仍可能写文件，后续合并、删除和接力可能与它竞争。若有独立快照，不会自动清理，请检查残留。</p>
    <button type="button" disabled={busy} onClick={() => void release()}>我确认风险，强制释放本次占用</button>
    <button type="button" disabled={busy} onClick={() => setConfirming(false)}>保留保护</button>
  </div>;
}
