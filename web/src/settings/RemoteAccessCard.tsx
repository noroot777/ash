import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowClockwise, Check, Eye, EyeSlash, Prohibit, QrCode as QrCodeIcon, SignOut, Trash } from "@phosphor-icons/react";
import type { PairCode, RemoteAccessView, RemoteDeviceView, RemoteDeviceVia } from "@ash/shared";
import { Button, StatusChip } from "../components/ui.tsx";
import { CopyButton } from "../components/CopyButton.tsx";
import { QrCode } from "../components/QrCode.tsx";
import { authApi } from "../lib/authApi.ts";
import { PAIR_REQUESTS_CHANGED_EVENT, isLoopbackPage, pairLink, seenLabel } from "../lib/pairing.ts";
import { ConfirmDialog } from "../task-detail/ConfirmDialog.tsx";

const POLL_MS = 3_000;

const VIA_LABEL: Record<RemoteDeviceVia, string> = {
  approval: "申请后允许",
  code: "扫码加入",
  key: "凭访问密钥加入",
};

// 自用模式的「远程访问」:哪些设备能从别处连进这台 ash(判据在 server 的
// auth/remote-access.ts)。从上到下:等着点头的申请 → 已经放进来的设备 → 再放一台 →
// 给脚本用的访问密钥。
//
// 最后一行只在 **ash 所在的那台机器上**打开时才有:连进来的设备能放别的设备、能请别的
// 设备出去(它本来就开得了终端),但读不到那把长期密钥。
export function RemoteAccessCard({ notify }: { notify: (message: string) => void }) {
  const [view, setView] = useState<RemoteAccessView | null>(null);
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<"rotate" | RemoteDeviceView | null>(null);
  const [adding, setAdding] = useState<PairCode | null>(null);
  const [hostIndex, setHostIndex] = useState(0);
  // 出码那一刻名册里已有的设备:之后多出来的那台就是刚扫进来的。
  const knownDevices = useRef<Set<string>>(new Set());

  const reload = useCallback(async () => {
    try {
      setView(await authApi.remoteAccess());
    } catch {
      // 轮询失败不反复打扰;首次读不到时整张卡不出,下一轮自己补上。
    }
  }, []);

  useEffect(() => {
    void reload();
    const timer = window.setInterval(() => void reload(), POLL_MS);
    window.addEventListener(PAIR_REQUESTS_CHANGED_EVENT, reload);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener(PAIR_REQUESTS_CHANGED_EVENT, reload);
    };
  }, [reload]);

  // 码五分钟过期:面板还开着就悄悄换一个,不让人对着一张废码扫半天。
  useEffect(() => {
    if (!adding) return;
    const timer = window.setTimeout(() => {
      void authApi.pairCode().then(setAdding).catch(() => setAdding(null));
    }, Math.max(1_000, Date.parse(adding.expiresAt) - Date.now() - 5_000));
    return () => window.clearTimeout(timer);
  }, [adding]);

  // 扫进来了:收起二维码,报一声是哪台。
  useEffect(() => {
    if (!adding || !view) return;
    const arrived = view.devices.find((device) => device.via === "code" && !knownDevices.current.has(device.id));
    if (!arrived) return;
    setAdding(null);
    notify(`「${arrived.name}」已加入`);
  }, [adding, view, notify]);

  if (!view) return null;
  const key = view.key ?? "";

  const act = async (work: () => Promise<unknown>, failure: string) => {
    setBusy(true);
    try {
      await work();
    } catch (error) {
      notify(error instanceof Error ? error.message : failure);
    } finally {
      setBusy(false);
    }
  };

  const decide = (requestId: string, name: string, decision: "approve" | "deny") => act(async () => {
    try {
      await authApi.decidePair(requestId, decision);
      notify(decision === "approve" ? `「${name}」可以用这台 ash 了` : "已拒绝");
    } finally {
      window.dispatchEvent(new Event(PAIR_REQUESTS_CHANGED_EVENT));
    }
  }, "处理失败");

  const toggleAdding = () => {
    if (adding) return setAdding(null);
    void act(async () => {
      knownDevices.current = new Set(view.devices.map((device) => device.id));
      setHostIndex(0);
      setAdding(await authApi.pairCode());
    }, "二维码生成失败");
  };

  const link = adding ? pairLink(adding.code, adding.hosts[hostIndex]) : null;

  return (
    <section className="settings-section" data-settings-anchor="remote-access">
      <h2>远程访问</h2>
      <div className="settings-card">
        {view.requests.map((request) => (
          <div className="settings-row" key={request.id}>
            <div>
              <b>「{request.name}」想连接这台 ash</b>
              <small>
                它屏幕上的配对码应为 <b className="pair-code">{request.code}</b> · 来自 {request.address}
              </small>
            </div>
            <span className="settings-row-actions">
              <Button variant="primary" disabled={busy} onClick={() => void decide(request.id, request.name, "approve")}>
                <Check size={13} aria-hidden="true" />允许
              </Button>
              <Button variant="ghost" disabled={busy} onClick={() => void decide(request.id, request.name, "deny")}>
                <Prohibit size={13} aria-hidden="true" />拒绝
              </Button>
            </span>
          </div>
        ))}

        {view.devices.map((device) => (
          <div className="settings-row" key={device.id}>
            <div>
              <b>{device.name}</b>
              <small>{VIA_LABEL[device.via]} · {device.address} · {seenLabel(device.lastSeenAt)}</small>
            </div>
            <span className="settings-row-actions">
              {device.current ? <StatusChip>这台设备</StatusChip> : null}
              <Button variant="ghost" disabled={busy} onClick={() => setConfirming(device)}>
                {device.current
                  ? <><SignOut size={13} aria-hidden="true" />登出</>
                  : <><Trash size={13} aria-hidden="true" />移除</>}
              </Button>
            </span>
          </div>
        ))}

        <div className="settings-row">
          <div>
            <b>添加设备</b>
            <small>在那台设备上打开这台 ash 的地址，回到这里点「允许」。手机可以直接扫码。</small>
          </div>
          <Button variant="secondary" disabled={busy} aria-expanded={adding !== null} onClick={toggleAdding}>
            <QrCodeIcon size={13} aria-hidden="true" />{adding ? "收起" : "扫码添加"}
          </Button>
        </div>
        {adding ? (
          <div className="settings-pair-code">
            {link ? (
              <>
                <QrCode value={link} label="添加设备的二维码" />
                <div>
                  <code className="settings-secret">{link.replace(/\?pair=.*$/, "")}</code>
                  {isLoopbackPage() && adding.hosts.length > 1 ? (
                    <span className="settings-pair-hosts" role="group" aria-label="手机连得上的那个地址">
                      {adding.hosts.map((host, index) => (
                        <Button
                          key={host}
                          variant={index === hostIndex ? "secondary" : "ghost"}
                          aria-pressed={index === hostIndex}
                          onClick={() => setHostIndex(index)}
                        >
                          {host}
                        </Button>
                      ))}
                    </span>
                  ) : null}
                  <small>用手机相机扫，五分钟内有效，只能用一次。</small>
                </div>
              </>
            ) : (
              <small>这台机器现在没有连上任何网络，别的设备连不过来。</small>
            )}
          </div>
        ) : null}

        {view.local ? (
          <div className="settings-row">
            <div>
              <b>访问密钥</b>
              <small>给脚本和命令行用：每个请求带 Authorization: Bearer。</small>
            </div>
            <span className="settings-row-actions">
              <code className="settings-secret">{shown ? key : `${key.slice(0, 4)}${"•".repeat(12)}`}</code>
              <Button
                variant="icon"
                aria-label={shown ? "隐藏访问密钥" : "显示访问密钥"}
                onClick={() => setShown((value) => !value)}
              >
                {shown ? <EyeSlash size={14} aria-hidden="true" /> : <Eye size={14} aria-hidden="true" />}
              </Button>
              <CopyButton value={key} label="复制" className="ui-button ui-button--secondary" />
              <Button variant="secondary" disabled={busy} onClick={() => setConfirming("rotate")}>
                <ArrowClockwise size={13} aria-hidden="true" />重新生成
              </Button>
            </span>
          </div>
        ) : null}
      </div>

      {confirming === "rotate" ? (
        <ConfirmDialog
          title="重新生成访问密钥"
          message="旧密钥立刻失效：填过它的脚本要换成新的，凭它登录的浏览器会被请出去。扫码或点「允许」加入的设备不受影响。"
          confirmLabel="生成新密钥"
          danger
          busy={busy}
          onConfirm={() => void act(async () => {
            setView(await authApi.rotateRemoteAccess());
            setShown(true);
            setConfirming(null);
          }, "重新生成失败")}
          onClose={() => setConfirming(null)}
        />
      ) : confirming ? (
        <ConfirmDialog
          title={confirming.current ? "登出这台设备" : "移除这台设备"}
          message={confirming.current
            ? "这台设备会立刻退出，下次要重新配对。"
            : `「${confirming.name}」会立刻断开，下次要重新配对。`}
          confirmLabel={confirming.current ? "登出" : "移除"}
          danger
          busy={busy}
          onConfirm={() => void act(async () => {
            if (confirming.current) {
              await authApi.logout();
              window.location.reload();
              return;
            }
            setView(await authApi.removeDevice(confirming.id));
            setConfirming(null);
          }, confirming.current ? "登出失败" : "移除失败")}
          onClose={() => setConfirming(null)}
        />
      ) : null}
    </section>
  );
}
