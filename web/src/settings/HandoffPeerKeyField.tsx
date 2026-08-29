import { useState } from "react";
import type { HandoffTarget } from "@ash/shared";
import { Key, SpinnerGap } from "@phosphor-icons/react";
import { Button, TextInput } from "../components/ui.tsx";
import { api } from "../lib/api.ts";

// 「我在对端的账号 key」的**唯一**编辑控件。三个表面共用它:自用模式的目标机清单、
// 多人模式的按人清单、接力对话框里预检失败后的就地补填。
//
// 为什么必须共用:2026-08-29 之前只有多人模式那份清单长着输入框,而预检失败的提示对
// **所有**模式都说「到设置 → 默认规则 → 接力目标机补上它」—— 自用实例的用户照着找
// 一圈,那里根本没有可填的地方(用户原话:「这也没有能补的地方啊」)。要不要 key 由
// **对端**是不是多人实例决定,跟本机什么模式无关,所以能填它的地方也不能只有一处。
//
// 写侧一律走按 url 的 `setHandoffTargetKey`:调用点手上常常只有地址 —— 自用模式那份
// 清单住在 app_settings 里,压根没有行 id。
export function HandoffPeerKeyField({
  url,
  hasKey,
  mode,
  disabled,
  saveLabel,
  notify,
  onSaved,
}: {
  url: string;
  hasKey: boolean;
  /** row = 设置页清单里的一行(默认收起);block = 弹窗里的补填块(默认展开)。 */
  mode: "row" | "block";
  disabled?: boolean;
  /** block 形态的主按钮文案:补完 key 通常要接着重试预检,由调用点说清楚。 */
  saveLabel?: string;
  notify: (message: string) => void;
  onSaved: (targets: HandoffTarget[]) => void;
}) {
  // 改 key 是显式动作:清单里默认收起,点「换一把」才展开输入框。省得每次进设置页都
  // 看见一排空的密码框,让人以为 key 丢了。
  const [editing, setEditing] = useState(mode === "block");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const locked = Boolean(disabled) || busy;

  const save = async (next: string) => {
    setBusy(true);
    try {
      onSaved(await api.setHandoffTargetKey(url, next));
      setValue("");
      if (mode === "row") setEditing(false);
      return true;
    } catch (error) {
      notify(error instanceof Error ? error.message : "对端账号 key 保存失败");
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (mode === "block") {
    return (
      <div className="handoff-key-fix">
        <label htmlFor="handoff-peer-key">你在对端的账号 key</label>
        <TextInput
          id="handoff-peer-key"
          type="password"
          placeholder="ash_…"
          value={value}
          autoComplete="off"
          disabled={locked}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && value.trim() && !locked) void save(value.trim());
          }}
        />
        <small>
          {hasKey
            ? "这台机器已经配过一把 key，但对端这次没认出来（可能被重置或停用了）。换一把新的。"
            : "对端管理员在它的「账号」页面给你开账号时会发这串 key。填进来就存在本机，接力请求带着它出门。"}
        </small>
        <Button variant="primary" disabled={locked || !value.trim()} onClick={() => void save(value.trim())}>
          {busy ? <SpinnerGap size={13} className="is-spinning" aria-hidden="true" /> : null}
          {saveLabel ?? "保存 key"}
        </Button>
      </div>
    );
  }

  return (
    <div className="handoff-target-key">
      <Key size={12} aria-hidden="true" />
      {editing ? (
        <>
          <TextInput
            type="password"
            placeholder="ash_… （你在对端的账号 key）"
            value={value}
            autoComplete="off"
            disabled={locked}
            onChange={(event) => setValue(event.target.value)}
          />
          <Button variant="ghost" disabled={locked || !value.trim()} onClick={() => void save(value.trim())}>
            保存
          </Button>
          <Button
            variant="ghost"
            disabled={locked}
            onClick={() => { setValue(""); setEditing(false); }}
          >
            取消
          </Button>
        </>
      ) : (
        <>
          <small>
            {hasKey
              ? "已配置对端账号 key（不回显）"
              : "还没配对端账号 key —— 目标机是多人实例时必须有它"}
          </small>
          <Button variant="ghost" disabled={locked} onClick={() => setEditing(true)}>
            {hasKey ? "换一把" : "填写"}
          </Button>
          {hasKey && (
            <Button variant="ghost" disabled={locked} onClick={() => void save("")}>
              清除
            </Button>
          )}
        </>
      )}
    </div>
  );
}
