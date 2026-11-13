import { useEffect, useState } from "react";
import { ArrowClockwise, Eye, EyeSlash, SignOut } from "@phosphor-icons/react";
import type { RemoteAccessView } from "@ash/shared";
import { Button } from "../components/ui.tsx";
import { CopyButton } from "../components/CopyButton.tsx";
import { authApi } from "../lib/authApi.ts";
import { ConfirmDialog } from "../task-detail/ConfirmDialog.tsx";

// 自用模式的「远程访问」:别的设备凭访问密钥进这台 ash(判据在 server 的
// auth/remote-access.ts)。同一张卡有两副样子,取决于**此刻这个页面是从哪打开的**:
//  · 在 ash 所在的那台机器上打开 → 看得到密钥,能换;
//  · 凭密钥从别的设备进来 → 看不到也换不了(服务端不给),只能把自己这一端登出。
export function RemoteAccessCard({ notify }: { notify: (message: string) => void }) {
  const [view, setView] = useState<RemoteAccessView | null>(null);
  const [shown, setShown] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    authApi.remoteAccess()
      .then(setView)
      .catch((error) => notify(error instanceof Error ? error.message : "访问密钥读取失败"));
  }, [notify]);

  if (!view) return null;
  const key = view.key ?? "";

  return (
    <section className="settings-section" data-settings-anchor="remote-access">
      <h2>远程访问</h2>
      <div className="settings-card">
        {view.local ? (
          <div className="settings-row">
            <div>
              <b>访问密钥</b>
              <small>在这台机器上打开 ash 不需要它；手机和别的电脑连进来时填一次。</small>
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
              <Button variant="secondary" disabled={busy} onClick={() => setConfirming(true)}>
                <ArrowClockwise size={13} aria-hidden="true" />重新生成
              </Button>
            </span>
          </div>
        ) : (
          <div className="settings-row">
            <div>
              <b>这台设备凭访问密钥登录</b>
              <small>密钥只能在 ash 所在的那台机器上查看和更换。</small>
            </div>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await authApi.logout();
                  window.location.reload();
                } catch (error) {
                  notify(error instanceof Error ? error.message : "登出失败");
                  setBusy(false);
                }
              }}
            >
              <SignOut size={13} aria-hidden="true" />登出
            </Button>
          </div>
        )}
      </div>

      {confirming && (
        <ConfirmDialog
          title="重新生成访问密钥"
          message="旧密钥立刻失效：已经连上的手机、别的电脑上的浏览器、填过它的脚本，都要换成新的才能再进来。"
          confirmLabel="生成新密钥"
          danger
          busy={busy}
          onConfirm={async () => {
            setBusy(true);
            try {
              setView(await authApi.rotateRemoteAccess());
              setShown(true);
              setConfirming(false);
            } catch (error) {
              notify(error instanceof Error ? error.message : "重新生成失败");
            } finally {
              setBusy(false);
            }
          }}
          onClose={() => setConfirming(false)}
        />
      )}
    </section>
  );
}
