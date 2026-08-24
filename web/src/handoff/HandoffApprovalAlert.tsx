import { useCallback, useEffect, useState } from "react";
import type { HandoffPeer } from "@ash/shared";
import { Check, Prohibit, ShieldWarning, SpinnerGap } from "@phosphor-icons/react";
import { Button } from "../components/ui.tsx";
import { api } from "../lib/api.ts";

const PEERS_CHANGED_EVENT = "ash:handoff-peers-changed";
const POLL_MS = 4_000;

export function HandoffApprovalAlert({
  notify,
  onOpenSettings,
}: {
  notify: (message: string) => void;
  onOpenSettings: () => void;
}) {
  const [pending, setPending] = useState<HandoffPeer[]>([]);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      setPending((await api.handoffPeers()).filter((peer) => peer.status === "pending"));
    } catch {
      // 后台轮询失败不反复弹 toast；下一轮或连接恢复后会自动补上。
    }
  }, []);

  useEffect(() => {
    void reload();
    const timer = window.setInterval(() => void reload(), POLL_MS);
    const onVisible = () => { if (document.visibilityState === "visible") void reload(); };
    window.addEventListener(PEERS_CHANGED_EVENT, reload);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener(PEERS_CHANGED_EVENT, reload);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [reload]);

  const peer = pending[0];
  if (!peer) return null;

  const decide = async (action: "approve" | "block") => {
    setBusy(true);
    try {
      await api.setHandoffPeerStatus(peer.fingerprint, action);
      notify(action === "approve" ? `已接受「${peer.name || "未命名机器"}」的接力申请` : "已拒绝接力申请");
      window.dispatchEvent(new Event(PEERS_CHANGED_EVENT));
      await reload();
    } catch (error) {
      notify(error instanceof Error ? error.message : "接力申请处理失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="handoff-approval-alert" role="alertdialog" aria-labelledby="handoff-approval-alert-title">
      <span className="handoff-approval-alert-icon"><ShieldWarning size={22} weight="fill" aria-hidden="true" /></span>
      <div className="handoff-approval-alert-copy">
        <strong id="handoff-approval-alert-title">收到接力申请</strong>
        <p>「{peer.name || "未命名机器"}」想把任务接力到本机。接受前不会向它公开项目列表。</p>
        <small>
          指纹 {peer.short}{peer.lastAddr ? ` · 来自 ${peer.lastAddr}` : ""}
          {pending.length > 1 ? ` · 另有 ${pending.length - 1} 个申请` : ""}
        </small>
      </div>
      <div className="handoff-approval-alert-actions">
        <Button variant="primary" disabled={busy} onClick={() => void decide("approve")}>
          {busy ? <SpinnerGap size={13} className="is-spinning" aria-hidden="true" /> : <Check size={13} aria-hidden="true" />}
          接受申请
        </Button>
        <Button variant="ghost" disabled={busy} onClick={() => void decide("block")}>
          <Prohibit size={13} aria-hidden="true" />拒绝
        </Button>
        <Button variant="ghost" disabled={busy} onClick={onOpenSettings}>查看设置</Button>
      </div>
    </section>
  );
}
