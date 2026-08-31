// 设置页「实例模式」卡片(§二 的另一半入口)。首启时选了自用的人,后来想几个人一起用,
// 从这里转 —— 走的是同一个 `POST /auth/setup`,同一份表单。
//
// 多人模式下**模式本身**是只读的(转不回自用),但「CLI 额度」那一档不是:它是首启时
// 选的一个初值,团队后来买了合用订阅、或者反过来各自开了账号,都要能改(§八之二)。
// 所以这张卡在多人模式下仍然有一个可写控件,只对实例管理员开放(服务端 PATCH /settings
// 的实例面闸是权威,这里只负责别把改不动的东西显示成能改)。
import { useState } from "react";
import type { AppSettings } from "@ash/shared";
import { KeyReveal } from "../auth/KeyReveal.tsx";
import { MultiModeForm } from "../auth/MultiModeForm.tsx";
import { HostCliChoice } from "../auth/HostCliChoice.tsx";
import { useAuth } from "../auth/authContext.ts";
import { Button } from "../components/ui.tsx";
import { api } from "../lib/api.ts";

export function InstanceModeCard({
  settings,
  loading,
  onSettings,
  notify,
}: {
  settings: AppSettings;
  loading: boolean;
  onSettings: (settings: AppSettings) => void;
  notify: (message: string) => void;
}) {
  const { state, refresh } = useAuth();
  const [open, setOpen] = useState(false);
  const [issuedKey, setIssuedKey] = useState("");
  const [saving, setSaving] = useState(false);

  if (state.mode === "multi") {
    return (
      <section className="settings-section">
        <h2>实例模式</h2>
        <div className="settings-card">
          <div className="settings-row">
            <div>
              <b>多人模式</b>
              <small>
                根目录 <code>{state.rootDir ?? "—"}</code>。用户在「设置 → 用户」里管。
                多人模式<b>转不回自用</b>——多人的数据没有合并回单人的语义。
              </small>
            </div>
          </div>
        </div>
        <div className="settings-card settings-card--pad">
          <div>
            <b>CLI 额度</b>
            <small>这台机器上 claude / codex 的登录态，大家算不算数。改了立刻对下一次派发生效。</small>
          </div>
          <HostCliChoice
            value={settings.sharedHostCli}
            disabled={loading || saving}
            switching
            onChange={async (sharedHostCli) => {
              if (sharedHostCli === settings.sharedHostCli) return;
              setSaving(true);
              try {
                onSettings(await api.patchSettings({ sharedHostCli }));
                notify(sharedHostCli ? "已改成共用这台机器的 CLI 额度" : "已改成每人自带 key，宿主机 CLI 被隔离");
              } catch (error) {
                notify(error instanceof Error ? error.message : "CLI 额度保存失败");
              } finally {
                setSaving(false);
              }
            }}
          />
        </div>
      </section>
    );
  }

  if (issuedKey) {
    return (
      <section className="settings-section">
        <h2>实例模式</h2>
        <div className="settings-card settings-card--pad">
          <KeyReveal
            value={issuedKey}
            title="这是你的管理员 key"
            confirmLabel="完成"
            onConfirm={() => {
              setIssuedKey("");
              setOpen(false);
              void refresh();
            }}
          />
        </div>
      </section>
    );
  }

  return (
    <section className="settings-section">
      <h2>实例模式</h2>
      <div className="settings-card">
        <div className="settings-row">
          <div>
            <b>自用模式</b>
            <small>
              零鉴权，打开就用；CLI 用这台机器上的登录态，订阅照用。
              要几个人一起用就切到多人模式 —— <b>单向，切了转不回来</b>。
            </small>
          </div>
          {open ? null : (
            <Button variant="danger" onClick={() => setOpen(true)}>
              切到多人模式…
            </Button>
          )}
        </div>
        {open ? (
          <div className="settings-card--pad">
            <MultiModeForm cancelLabel="取消" onCancel={() => setOpen(false)} onIssued={setIssuedKey} />
          </div>
        ) : null}
      </div>
    </section>
  );
}
