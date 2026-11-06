import { useId, useState } from "react";
import type { FeishuStatus, ImDomain } from "@ash/shared";
import { Button, PillTabs } from "../components/ui.tsx";
import { api } from "../lib/api.ts";
import { ConfirmDialog } from "../task-detail/ConfirmDialog.tsx";
import { useServerDraft } from "./useServerDraft.ts";

// 凭证卡：App ID / App Secret / 域名。
//
// App Secret **只写不读**：状态里只有「配没配」（config 非空就是配过），所以密码框永远是空的，
// 这是设计而不是加载失败。平时收起成「已配置（不回显）」，点「换一把」才展开（同
// HandoffPeerKeyField）——否则每次进来都看见一个空密码框，会以为密钥丢了；只想改域名的人也
// 不该被逼着回后台再抄一遍 Secret，所以留空 = 沿用已存的那一把。
//
// 写操作走真人凭据（feishuApi.ts 文件头）：换凭证就是换「谁能指挥这台机器」。

const DOMAINS = [
  { value: "feishu", label: "飞书" },
  { value: "lark", label: "Lark（国际版）" },
] as const;

export function FeishuCredentialsCard({ status, onStatus, notify }: {
  status: FeishuStatus;
  onStatus: (next: FeishuStatus) => void;
  notify: (message: string) => void;
}) {
  const { config, canManage } = status;
  const [appId, setAppId, appIdDirty] = useServerDraft(config?.appId ?? "");
  const [domain, setDomain, domainDirty] = useServerDraft<ImDomain>(config?.domain ?? "feishu");
  const [secret, setSecret] = useState("");
  const [editingSecret, setEditingSecret] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const appIdId = useId();
  const secretId = useId();

  if (!canManage) {
    return (
      <section className="settings-section">
        <h2>凭证</h2>
        <div className="settings-card">
          <div className="settings-row">
            <div>
              <b>{config ? `App ID：${config.appId}（${config.domain === "lark" ? "Lark" : "飞书"}）` : "还没配置飞书应用"}</b>
              <small>飞书应用的凭证是整台实例共用的，只有实例管理员能改。App Secret 任何人都看不到。</small>
            </div>
          </div>
        </div>
      </section>
    );
  }

  const showSecretInput = !config || editingSecret;
  const canSave = !busy && appId.trim() !== "" && (config ? appIdDirty || domainDirty || secret !== "" : secret !== "");

  const save = async () => {
    setBusy(true);
    try {
      const next = await api.saveFeishuCredentials({
        appId: appId.trim(),
        domain,
        ...(secret ? { appSecret: secret } : {}),
      });
      setSecret("");
      setEditingSecret(false);
      onStatus(next);
      notify("飞书凭证已保存，正在连接");
    } catch (error) {
      notify(error instanceof Error ? error.message : "飞书凭证保存失败");
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    setBusy(true);
    try {
      onStatus(await api.clearFeishuCredentials());
      setConfirmClear(false);
      setSecret("");
      setEditingSecret(false);
      notify("飞书凭证已清除，机器人已下线");
    } catch (error) {
      notify(error instanceof Error ? error.message : "飞书凭证清除失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="settings-section">
      <h2>凭证</h2>
      <div className="settings-card">
        <div className="settings-field feishu-inline-field">
          <label htmlFor={appIdId}>App ID</label>
          <input
            id={appIdId}
            className="mono"
            value={appId}
            disabled={busy}
            autoComplete="off"
            spellCheck={false}
            placeholder="cli_…"
            onChange={(event) => setAppId(event.target.value)}
          />
        </div>
        {showSecretInput ? (
          <div className="settings-field feishu-inline-field">
            <label htmlFor={secretId}>App Secret</label>
            <input
              id={secretId}
              type="password"
              value={secret}
              disabled={busy}
              autoComplete="new-password"
              placeholder={config ? "留空则沿用已存的 Secret" : "在开发者后台「凭证与基础信息」里复制"}
              onChange={(event) => setSecret(event.target.value)}
            />
            {config && (
              <Button variant="ghost" disabled={busy} onClick={() => { setSecret(""); setEditingSecret(false); }}>取消</Button>
            )}
          </div>
        ) : (
          <div className="settings-field feishu-inline-field feishu-secret-row">
            <span className="feishu-field-name">App Secret</span>
            <small>已配置（不回显）</small>
            <Button variant="ghost" disabled={busy} onClick={() => setEditingSecret(true)}>换一把</Button>
            <Button variant="ghost" disabled={busy} onClick={() => setConfirmClear(true)}>清除</Button>
          </div>
        )}
        <div className="settings-field feishu-inline-field">
          <span className="feishu-field-name">域名</span>
          <PillTabs label="飞书域名" items={DOMAINS} value={domain} onChange={setDomain} />
        </div>
        <div className="settings-card-foot">
          <span>
            {config
              ? `上次保存：${new Date(config.updatedAt).toLocaleString("zh-CN")}。Secret 存进去就取不回来，只能换一把；保存后会立刻断开重连。`
              : "Secret 存进去就取不回来，只能换一把。保存后 ash 立刻去连飞书，等上面的状态变成「已连接」再去后台订阅事件。"}
          </span>
          <Button variant="primary" disabled={!canSave} onClick={() => void save()}>
            {busy ? "保存中…" : "保存凭证"}
          </Button>
        </div>
      </div>
      {confirmClear && (
        <ConfirmDialog
          title="清除飞书凭证"
          message="清除后机器人立刻下线，已发出的卡片按钮全部失效。App Secret 取不回来，以后要用得重新填。"
          confirmLabel="清除凭证"
          danger
          busy={busy}
          onClose={() => setConfirmClear(false)}
          onConfirm={() => void clear()}
        />
      )}
    </section>
  );
}
