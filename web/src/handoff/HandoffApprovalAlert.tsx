import { useCallback, useEffect, useState } from "react";
import type { HandoffPeer } from "@ash/shared";
import { Check, Prohibit, ShieldWarning, SpinnerGap } from "@phosphor-icons/react";
import { Button } from "../components/ui.tsx";
import { api } from "../lib/api.ts";

const PEERS_CHANGED_EVENT = "ash:handoff-peers-changed";
const POLL_MS = 4_000;

// 横幅只弹**新鲜**的申请。
//
// 它是个打断式顶条，压在所有人的工作区上方，所以门槛得比设置页那份名单高一档：
// 一条没人处理的 pending 会一直留在库里，而横幅原来只看 `status === "pending"`、
// 不看时间也不显示时间 —— 于是几周前的一条陈年记录天天顶在页面上，看起来永远像
// 「刚刚有人在申请」（2026-08-31 用户就是这么被误导的）。
//
// 过了这个窗口不是消失，是**降级**：申请仍在「设置 → 默认规则 → 接力来源」里等着
// 处理，只是不再打断人。真在等对面放行的人会自己去点，不需要横幅一直提醒。
const FRESH_MS = 24 * 60 * 60_000;

const isFresh = (peer: HandoffPeer): boolean => {
  const seen = Date.parse(peer.lastSeenAt);
  return Number.isFinite(seen) && Date.now() - seen < FRESH_MS;
};

const seenLabel = (iso: string): string => {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "";
  const mins = Math.floor((Date.now() - at) / 60_000);
  if (mins < 1) return "刚刚";
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.floor(mins / 60);
  return hours < 24 ? `${hours} 小时前` : new Date(at).toLocaleString();
};

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
      // 服务端已按人收窄（handoff-peers.ts peerAudience），这里拿到的就只有该我处理的。
      setPending((await api.handoffPeers()).filter((peer) => peer.status === "pending" && isFresh(peer)));
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
        <p>
          「{peer.name || "未命名机器"}」想把任务接力到本机
          {peer.requestedByName ? `，以「${peer.requestedByName}」的身份` : ""}。接受前不会向它公开项目列表。
        </p>
        <small>
          指纹 {peer.short}{peer.lastAddr ? ` · 来自 ${peer.lastAddr}` : ""}
          {` · ${seenLabel(peer.lastSeenAt)}`}
          {pending.length > 1 ? ` · 另有 ${pending.length - 1} 个申请` : ""}
        </small>
        {/* 管理员看到的是别人的申请：说清楚为什么它会出现在这儿，免得替人做了决定。 */}
        {peer.seenAsAdmin && (
          <small className="handoff-approval-alert-note">
            这条不是冲着你来的，你是以实例管理员身份看到的。通常该由
            {peer.requestedByName ? `「${peer.requestedByName}」` : "申请人本人"}处理。
          </small>
        )}
      </div>
      <div className="handoff-approval-alert-actions">
        {/* 批不了就别露按钮:管理员看得见这条,但接受得由本人点(后端 requirePeerActable
            会 403)。留一颗按下去就报错的按钮只会让人以为功能坏了。 */}
        {peer.canApprove !== false && (
          <Button variant="primary" disabled={busy} onClick={() => void decide("approve")}>
            {busy ? <SpinnerGap size={13} className="is-spinning" aria-hidden="true" /> : <Check size={13} aria-hidden="true" />}
            接受申请
          </Button>
        )}
        <Button variant="ghost" disabled={busy} onClick={() => void decide("block")}>
          <Prohibit size={13} aria-hidden="true" />拒绝
        </Button>
        <Button variant="ghost" disabled={busy} onClick={onOpenSettings}>查看设置</Button>
      </div>
    </section>
  );
}
