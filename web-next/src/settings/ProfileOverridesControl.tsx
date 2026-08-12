import { useEffect, useMemo, useState } from "react";
import { Sliders, X } from "@phosphor-icons/react";
import type { AgentType } from "@harness/shared";
import { cliConfigOverridesFor } from "@harness/shared/cli-overrides";
import { Button } from "../components/ui.tsx";

// 「harness 替你写进 CLI 的配置」的编辑入口。这一档配置跟旁边那些(模型、档位、
// 额外参数)有个本质区别:它**盖掉的是用户自己配置文件里的值**。所以这里的重点
// 不是表单好不好填,而是那行 `shadows` —— 不写明白「这一项盖掉了 xxx」,用户在
// settings.json 里改了不生效,只会以为 CLI 坏了。
//
// 弹层结构与 ProfileArgsControl 一致(共用 .agent-profile-args-popover 那套样式)。

const fmt = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

export function ProfileOverridesControl({
  profileName,
  type,
  value,
  disabled,
  onSave,
}: {
  profileName: string;
  type: AgentType;
  value: Record<string, number>;
  disabled: boolean;
  onSave: (value: Record<string, number>) => Promise<boolean>;
}) {
  const specs = useMemo(() => cliConfigOverridesFor(type), [type]);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});

  const toDraft = useMemo(
    () => (source: Record<string, number>): Record<string, string> =>
      Object.fromEntries(specs.map((spec) => [spec.key, source[spec.key] === undefined ? "" : String(source[spec.key])])),
    [specs],
  );

  useEffect(() => {
    if (!open) setDraft(toDraft(value));
  }, [open, toDraft, value]);

  if (!specs.length) return null;

  // 空串 = 清掉这一项(回到「跟随 CLI」),不是 0。数字非法时保留原值,交给下面的
  // 逐项提示,而不是静默丢弃用户刚敲的东西。
  const parsed: Record<string, number> = {};
  const errors: string[] = [];
  for (const spec of specs) {
    const raw = (draft[spec.key] ?? "").trim();
    if (!raw) continue;
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      errors.push(`${spec.label}要填数字`);
      continue;
    }
    if (n < spec.min || n > spec.max) {
      errors.push(`${spec.label}要在 ${fmt(spec.min)}–${fmt(spec.max)} 之间`);
      continue;
    }
    parsed[spec.key] = Math.round(n);
  }

  const key = (source: Record<string, number>) =>
    specs.map((spec) => `${spec.key}=${source[spec.key] ?? ""}`).join("&");
  const dirty = key(parsed) !== key(value);

  const active = specs.filter((spec) => value[spec.key] !== undefined);
  const summary = active.map((spec) => `${spec.label} ${fmt(value[spec.key]!)}`).join(" · ");

  const close = () => {
    setDraft(toDraft(value));
    setOpen(false);
  };

  const save = async () => {
    if (!dirty) {
      setOpen(false);
      return;
    }
    if (await onSave(parsed)) setOpen(false);
  };

  return (
    <div className="agent-profile-args-control">
      <button
        type="button"
        className={`agent-profile-args-summary${summary ? " has-value" : ""}`}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={summary ? `${profileName} 覆盖了 CLI 自己的配置：${summary}` : `编辑 ${profileName} 对 CLI 配置的覆盖`}
        onClick={() => {
          setDraft(toDraft(value));
          setOpen((current) => !current);
        }}
      >
        <Sliders size={12} aria-hidden="true" />
        <span>{summary || "CLI 配置"}</span>
      </button>

      {open && (
        <div
          className="agent-profile-args-popover"
          role="dialog"
          aria-label={`${profileName} 的 CLI 配置覆盖`}
          onKeyDown={(event) => {
            if (event.key === "Escape") close();
          }}
        >
          <div className="agent-profile-args-popover-head">
            <div>
              <b>覆盖 CLI 自己的配置</b>
              <small>{profileName} · 以环境变量注入，只对 harness 起的进程生效</small>
            </div>
            <button type="button" onClick={close} aria-label="关闭配置编辑">
              <X size={13} aria-hidden="true" />
            </button>
          </div>

          <div className="agent-profile-overrides-list">
            {specs.map((spec) => (
              <div className="agent-profile-override" key={spec.key}>
                <label htmlFor={`ov-${profileName}-${spec.key}`}>
                  <b>{spec.label}</b>
                  <span className="agent-profile-override-shadows">覆盖 {spec.shadows}</span>
                </label>
                <div className="agent-profile-override-input">
                  <input
                    id={`ov-${profileName}-${spec.key}`}
                    inputMode="numeric"
                    disabled={disabled}
                    placeholder={spec.placeholder}
                    value={draft[spec.key] ?? ""}
                    onChange={(event) => setDraft((current) => ({ ...current, [spec.key]: event.target.value }))}
                  />
                  {spec.unit && <small>{spec.unit}</small>}
                  <Button
                    variant="ghost"
                    disabled={disabled}
                    onClick={() => setDraft((current) => ({ ...current, [spec.key]: String(spec.recommended) }))}
                  >
                    用 {fmt(spec.recommended)}
                  </Button>
                </div>
                <p>{spec.help}</p>
              </div>
            ))}
          </div>

          <div className="agent-profile-args-popover-actions">
            <span>
              {errors.length ? errors[0] : dirty ? "有未保存更改" : active.length ? `已覆盖 ${active.length} 项` : "未覆盖任何配置"}
            </span>
            <Button variant="ghost" disabled={disabled} onClick={close}>取消</Button>
            <Button disabled={disabled || !dirty || errors.length > 0} onClick={() => void save()}>
              {disabled ? "保存中…" : "保存配置"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
