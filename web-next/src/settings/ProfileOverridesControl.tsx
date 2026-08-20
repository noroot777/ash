import { useEffect, useMemo, useRef, useState } from "react";
import { Sliders, X } from "@phosphor-icons/react";
import type { AgentType } from "@harness/shared";
import {
  cliConfigOverrideConflict,
  cliConfigOverrideErrors,
  cliConfigOverrideHints,
  cliConfigOverridesFor,
  ineffectiveCliConfigOverrides,
} from "@harness/shared/cli-overrides";
import { Button } from "../components/ui.tsx";
import { useDismissable } from "../lib/useDismissable.ts";
import { useCliHostEnv } from "./useCliHostEnv.ts";

// 「harness 替你写进 CLI 的配置」的编辑入口。这一档配置跟旁边那些(模型、档位、
// 额外参数)有个本质区别:它**盖掉的是用户自己配置文件里的值**。所以这里的重点
// 不是表单好不好填,而是那行 `shadows` —— 不写明白「这一项盖掉了 xxx」,用户在
// settings.json 里改了不生效,只会以为 CLI 坏了。
//
// 第二个重点是底下那行 hint:这几个数和它们的实际效果之间隔着一层 CLI 内部算法
// (填 200k + 80% 到底在多少 token 压?),所以边填边把算出来的结果摆在旁边。
//
// 所以行内那颗按钮是**常显的一枚胶囊**(写着当前值,没配就写「未覆盖」),不是缩成图标
// 再靠 hover / 读屏器才读得到的东西 —— 盖了别人的配置却看不出来,等于没告诉他。
//
// 弹层外框复用 ProfileArgsControl 那套 .agent-profile-args-popover 样式;关闭语义走
// useDismissable(点外面 / Esc / 焦点归还),打开时焦点进第一个输入框。

const fmt = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
const fmtWith = (n: number, unit?: string) => (unit === "%" ? `${n}%` : fmt(n));

export function ProfileOverridesControl({
  profileName,
  type,
  value,
  extraArgs,
  disabled,
  onSave,
}: {
  profileName: string;
  type: AgentType;
  value: Record<string, number>;
  /** 同一个 profile 的额外参数 —— 里面自带 `--settings` 时这一档会被整份顶掉。 */
  extraArgs: readonly string[];
  disabled: boolean;
  onSave: (value: Record<string, number>) => Promise<boolean>;
}) {
  const specs = useMemo(() => cliConfigOverridesFor(type), [type]);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const hostEnv = useCliHostEnv();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const toDraft = useMemo(
    () => (source: Record<string, number>): Record<string, string> =>
      Object.fromEntries(specs.map((spec) => [spec.key, source[spec.key] === undefined ? "" : String(source[spec.key])])),
    [specs],
  );

  useEffect(() => {
    if (!open) setDraft(toDraft(value));
  }, [open, toDraft, value]);

  const close = () => {
    setDraft(toDraft(value));
    setOpen(false);
  };

  // 点外面 / Esc / 关闭后把焦点还给触发按钮,统一交给这一摞层管(web-next/CLAUDE.md)。
  useDismissable({ enabled: open, containerRef: popoverRef, restoreFocusRef: triggerRef, onClose: close });

  // 打开后焦点要进弹层:停在触发按钮上的话,键盘用户按 Tab 是往同排别的操作跑,
  // 而不是进这个 role=dialog 里 —— 弹层等于只对鼠标可用。
  useEffect(() => {
    if (open) popoverRef.current?.querySelector("input")?.focus();
  }, [open]);

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
  // 依赖项没配上时这一项**根本不会注入**(cliConfigOverrideEnv 会跳过它),所以不能让
  // 它存下去:存了会显示成「已覆盖 80%」,而实际行为跟没配一模一样 —— 静默失败。
  // 判定用 shared 的那份,跟后端 400 是同一句话,别在这儿再写一遍。
  errors.push(...cliConfigOverrideErrors(type, parsed));

  const key = (source: Record<string, number>) =>
    specs.map((spec) => `${spec.key}=${source[spec.key] ?? ""}`).join("&");
  const dirty = key(parsed) !== key(value);

  const active = specs.filter((spec) => value[spec.key] !== undefined);
  // 已存下的值里也可能有空转的(这道校验是后加的,老数据没过过闸)。胶囊上必须看得出
  // 来 —— 否则用户看到「80%」会以为它在生效,而 CLI 那边压根没收到这个变量。
  const dead = new Set(ineffectiveCliConfigOverrides(type, value));
  // 额外参数自带 --settings 时整档都到不了 CLI 手上(claude 只认最后一个)。跟上面
  // 那个「空转项」一样,得在胶囊上就看得出来 —— 只写在弹层里等于要求用户先怀疑它。
  const conflict = cliConfigOverrideConflict(type, extraArgs);
  const summary = active
    .map((spec) => `${fmtWith(value[spec.key]!, spec.unit)}${dead.has(spec.key) ? "（未生效）" : ""}`)
    .join(" · ")
    + (active.length && conflict ? "（被额外参数顶掉）" : "");
  const shadowed = active.map((spec) => spec.shadows).join("、");
  // hint 跟着草稿走,不是跟着已保存的值走 —— 这行字存在的意义就是「改之前先看看会变成什么」。
  const hints = cliConfigOverrideHints(type, parsed, hostEnv);

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
        ref={triggerRef}
        className={`agent-profile-overrides-summary${summary ? " has-value" : ""}`}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={
          summary
            ? `${profileName} 覆盖了 ${shadowed}：${summary}`
            : `编辑 ${profileName} 对 CLI 配置的覆盖`
        }
        onClick={() => {
          setDraft(toDraft(value));
          setOpen((current) => !current);
        }}
      >
        <Sliders size={12} aria-hidden="true" />
        <span>{summary || "未覆盖"}</span>
      </button>

      {open && (
        <div className="agent-profile-args-popover" ref={popoverRef} role="dialog" aria-label={`${profileName} 的 CLI 配置覆盖`}>
          <div className="agent-profile-args-popover-head">
            <div>
              <b>覆盖 CLI 自己的配置</b>
              <small>{profileName} · 写进 harness 起的这次 CLI 调用，压过它自己的配置文件</small>
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
                    用 {fmtWith(spec.recommended, spec.unit)}
                  </Button>
                </div>
                <p>{spec.help}</p>
              </div>
            ))}
          </div>

          {(conflict || hints.length > 0) && (
            <div className="agent-profile-override-hint">
              {conflict && <p><b>{conflict}</b></p>}
              {hints.map((hint) => <p key={hint}>{hint}</p>)}
            </div>
          )}

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
