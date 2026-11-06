import { useState } from "react";
import type { FeishuStatus } from "@ash/shared";
import { ArrowClockwise } from "@phosphor-icons/react";
import { Button, StatusChip } from "../components/ui.tsx";
import { api } from "../lib/api.ts";
import { FeishuSetupGuide } from "./FeishuSetupGuide.tsx";
import { FeishuUsage } from "./FeishuUsage.tsx";
import { NOT_CONNECTING, agoText, connectionView, formatTime } from "./feishuText.ts";

// 连接卡：机器人此刻在不在线、为什么不在线、额度还剩多少。
//
// ash 一挂机器人就静默下线（飞书那边不会告诉你），所以「连没连上」必须是一眼能看到、刷新后
// 仍在的状态，而不是只在出错那一刻弹一句提示。状态拉取本身失败时也如实标出来——否则服务端
// 停了，这张卡还会一直亮着上一次拿到的「已连接」。

export function FeishuConnectionCard({ status, pollError, syncedAt, onStatus, notify }: {
  status: FeishuStatus;
  pollError: string | null;
  syncedAt: number | null;
  onStatus: (next: FeishuStatus) => void;
  notify: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const { connection } = status;
  const view = connectionView(connection.state, connection.error, connection.reconnectAttempts);
  const now = syncedAt ?? Date.now();
  const canReconnect = status.canManage && !NOT_CONNECTING.includes(connection.state);

  const reconnect = async () => {
    setBusy(true);
    try {
      onStatus(await api.reconnectFeishu());
      notify("已重新发起连接");
    } catch (error) {
      notify(error instanceof Error ? error.message : "重新连接失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="settings-section" data-settings-anchor="feishu-connection">
      <h2>连接</h2>
      <div className="settings-card">
        <div className="settings-row feishu-state-row">
          <div>
            <b className="feishu-state" data-state={connection.state}>
              <StatusChip tone={view.tone}>{view.label}</StatusChip>
            </b>
            <small>{status.configError ? `${view.detail}（${status.configError}）` : view.detail}</small>
            {pollError && (
              <small className="feishu-stale">
                最近一次读取状态失败：{pollError}
                {syncedAt ? `。上面显示的是 ${new Date(syncedAt).toLocaleTimeString("zh-CN")} 的状态` : ""}
              </small>
            )}
          </div>
          {canReconnect && (
            <Button variant="secondary" disabled={busy} onClick={() => void reconnect()}>
              <ArrowClockwise size={13} aria-hidden="true" />
              {busy ? "连接中…" : "重新连接"}
            </Button>
          )}
        </div>
        <dl className="feishu-facts">
          {connection.since && (
            <div><dt>处于这个状态自</dt><dd>{formatTime(connection.since)}</dd></div>
          )}
          {connection.connectedAt && connection.state === "connected" && (
            <div><dt>本次连上于</dt><dd>{formatTime(connection.connectedAt)}</dd></div>
          )}
          {status.config && (
            <div>
              <dt>最近一次收到事件</dt>
              <dd>{connection.lastEventAt ? `${agoText(connection.lastEventAt, now)}（${formatTime(connection.lastEventAt)}）` : "还没收到过"}</dd>
            </div>
          )}
          {connection.botName && <div><dt>机器人</dt><dd>{connection.botName}</dd></div>}
          <div>
            <dt>本机实例指纹</dt>
            <dd>
              <code>{status.instanceTag}</code>
              <span className="feishu-fact-note">每次连上，机器人会在单聊里发一句「实例 {status.instanceTag} 已上线」；看到别的指纹，说明另一台机器连着同一个应用。</span>
            </dd>
          </div>
        </dl>
        {status.usage && <FeishuUsage usage={status.usage} outbox={status.outbox} />}
        <FeishuSetupGuide connected={connection.state === "connected"} />
      </div>
    </section>
  );
}
