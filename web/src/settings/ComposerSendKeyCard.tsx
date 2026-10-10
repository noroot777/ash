import { useState } from "react";
import type { ComposerSendKey } from "@ash/shared";
import { sendKeyLabels } from "../lib/sendKey.ts";

// 设置页里的「输入框」一块：全站输入框按哪一下算发送。
//
// 为什么是一个设置项而不是定死一种：这两种习惯都有大量用户，而且**都有道理**——
// 回车直发在短消息里快，⌘+回车在「写一段完整的要求」时不会把半句话发出去。
// 以前系统里两种都存在（聊天框回车直发、任务回复框 ⌘+回车），哪个框按哪一下只能靠记，
// 那比两种选一种更糟。
//
// 这一项是**个人面**的（PERSONAL_SETTING_KEYS）：同一台机器上两个人各按各的习惯。
// 判据与提示文案的单点在 `web/src/lib/sendKey.ts`。

const CHOICES: { value: ComposerSendKey; label: string }[] = [
  { value: "enter", label: "回车直接发送（Shift + 回车换行）" },
  { value: "mod-enter", label: "⌘ / Ctrl + 回车发送（回车换行）" },
];

export function ComposerSendKeyCard({ value, loading, onChange }: {
  value: ComposerSendKey;
  loading: boolean;
  onChange: (next: ComposerSendKey) => Promise<void>;
}) {
  // 存的那一下把下拉按住:两次快速改动会发出两条 PATCH，服务端最后留下哪一条取决于
  // 它们的到达顺序，而界面上只剩用户最后点的那个 —— 两边对不上就没法解释了。
  // （前端自己采纳哪一份应答另有一道闸，见 sendKey.ts 的 nextSettingsTicket。）
  const [saving, setSaving] = useState(false);
  const labels = sendKeyLabels(value);
  return (
    // data-settings-anchor：文案里的「设置 → 默认规则 → 输入框」照着它落点（见 sections.ts）。
    <section className="settings-section" data-settings-anchor="send-key">
      <h2>输入框</h2>
      <div className="settings-card">
        <div className="settings-row">
          <div>
            <b>按哪一下算发送</b>
            <small>
              对全站的消息输入框生效：任务回复、新建任务、答复提问、团队插话、群聊、侧聊、
              ash 助手、讨论关口、派审附言。改完立刻生效，不用刷新页面。
              <br />
              当前：{labels.send} 发送，{labels.newline} 换行
              {value === "enter" && "（⌘ / Ctrl + 回车也照旧发送）"}
            </small>
          </div>
          <select
            value={value}
            disabled={loading || saving}
            aria-label="输入框发送键"
            onChange={(event) => {
              const next = event.target.value as ComposerSendKey;
              setSaving(true);
              void onChange(next).finally(() => setSaving(false));
            }}
          >
            {CHOICES.map((choice) => (
              <option key={choice.value} value={choice.value}>{choice.label}</option>
            ))}
          </select>
        </div>
      </div>
    </section>
  );
}
