// 设置页「实例模式」卡片(§二 的另一半入口)。首启时选了自用的人,后来想几个人一起用,
// 从这里转 —— 走的是同一个 `POST /auth/setup`,同一份表单。
//
// 多人模式下这张卡是**只读**的:转不回自用,所以不提供任何按钮,只如实说明现状。
import { useState } from "react";
import { KeyReveal } from "../auth/KeyReveal.tsx";
import { MultiModeForm } from "../auth/MultiModeForm.tsx";
import { useAuth } from "../auth/authContext.ts";
import { Button } from "../components/ui.tsx";

export function InstanceModeCard() {
  const { state, refresh } = useAuth();
  const [open, setOpen] = useState(false);
  const [issuedKey, setIssuedKey] = useState("");

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
