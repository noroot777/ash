// key 只展示一次,所以这一屏必须做对:整屏展示 + 一键复制 + **强制点「我已保存」**。
// 复用于三处(首启向导、领取链接、自助轮换),所以单独成件。
import { useState } from "react";

export function KeyReveal({
  value,
  title,
  note,
  confirmLabel = "我已保存",
  onConfirm,
}: {
  value: string;
  title: string;
  note?: string;
  confirmLabel?: string;
  onConfirm: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);

  return (
    <div className="auth-key-reveal">
      <h2>{title}</h2>
      <p className="auth-note">
        {note ?? "这串 key 只显示这一次。关掉这一屏之后，服务端只留哈希，谁也读不回来。"}
      </p>
      <pre className="auth-key-value">{value}</pre>
      <div className="auth-key-actions">
        <button
          type="button"
          className="ui-button ui-button--secondary"
          onClick={() => {
            void navigator.clipboard?.writeText(value).then(
              () => setCopied(true),
              () => setCopied(false),
            );
          }}
        >
          {copied ? "已复制" : "复制"}
        </button>
      </div>
      <label className="auth-check">
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={(e) => setAcknowledged(e.target.checked)}
        />
        <span>我已经把它存到密码管理器里了</span>
      </label>
      <button
        type="button"
        className="ui-button ui-button--primary"
        disabled={!acknowledged}
        onClick={onConfirm}
      >
        {confirmLabel}
      </button>
    </div>
  );
}
