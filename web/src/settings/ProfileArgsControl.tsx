import { useEffect, useState } from "react";
import { SlidersHorizontal, X } from "@phosphor-icons/react";
import { Button } from "../components/ui.tsx";
import { ExtraArgsEditor } from "./ExtraArgsEditor.tsx";

export function ProfileArgsControl({
  profileName,
  value,
  disabled,
  onSave,
}: {
  profileName: string;
  value: string[];
  disabled: boolean;
  onSave: (value: string[]) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  const normalized = draft.map((token) => token.trim()).filter(Boolean);
  const dirty = normalized.join("\u0000") !== value.join("\u0000");
  const summary = value.join(" ");

  useEffect(() => {
    if (!open) setDraft(value);
  }, [open, value]);

  const close = () => {
    setDraft(value);
    setOpen(false);
  };

  const save = async () => {
    if (!dirty) {
      setOpen(false);
      return;
    }
    if (await onSave(normalized)) setOpen(false);
  };

  return (
    <div className="agent-profile-args-control">
      <button
        type="button"
        className={`agent-profile-args-summary${summary ? " has-value" : ""}`}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={summary || "添加额外 CLI 参数"}
        onClick={() => {
          setDraft(value);
          setOpen((current) => !current);
        }}
      >
        <SlidersHorizontal size={12} aria-hidden="true" />
        <span>{summary || "添加参数"}</span>
      </button>

      {open && (
        <div
          className="agent-profile-args-popover"
          role="dialog"
          aria-label={`${profileName} 的额外 CLI 参数`}
          onKeyDown={(event) => {
            if (event.key === "Escape") close();
          }}
        >
          <div className="agent-profile-args-popover-head">
            <div>
              <b>额外 CLI 参数</b>
              <small>{profileName} · 每项按单个 token 传递</small>
            </div>
            <button type="button" onClick={close} aria-label="关闭参数编辑">
              <X size={13} aria-hidden="true" />
            </button>
          </div>
          <ExtraArgsEditor value={draft} disabled={disabled} onChange={setDraft} />
          <div className="agent-profile-args-popover-actions">
            <span>{dirty ? "有未保存更改" : `${normalized.length} 项参数`}</span>
            <Button variant="ghost" disabled={disabled} onClick={close}>取消</Button>
            <Button disabled={disabled || !dirty} onClick={() => void save()}>
              {disabled ? "保存中…" : "保存参数"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
