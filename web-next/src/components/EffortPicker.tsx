import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { AgentType } from "@harness/shared";
import {
  isReasoningEffortSupported,
  REASONING_EFFORT_DETAIL,
  reasoningEffortsFor,
} from "@harness/shared/cli-presets";
import { CaretDown, Warning } from "@phosphor-icons/react";
import { useDismissable } from "../lib/useDismissable.ts";
import { placementStyle, usePanelPlacement } from "../lib/usePanelPlacement.ts";

/**
 * 「智能水平」这一段（旧称思考强度，内部字段仍叫 reasoningEffort）。它**不是选模型
 * 下拉里的第二步**：模型和档位是两件独立的事——换模型不该顺手把档位改掉，改档位也
 * 不该逼你重走一遍选模型。所以所有选模型的地方统一是一颗三段胶囊：**智能体 · 模型 ·
 * 智能水平**，本组件是最后那一段（见 components/RunTargetPicker.tsx）。
 *
 * 代价是段与段之间可能对不上（`gpt-5.5` 配 `ultra`），这时**明说而不是静默改掉**：
 * 这一段转成警告态、浮层顶上写清楚为什么，用户自己决定是换模型还是换档位。静默清空
 * 会让人以为自己没点中，静默保留又会让任务在真跑起来时被上游拒。
 *
 * 候选来自 shared 的 `reasoningEffortsFor(type, model)`（完整允许集合，可以有洞、
 * 可以为空）。模型压根没有档位时这一段只剩一句说明，不给点。`type` 为空 = 连哪个 CLI
 * 都还没定（工作流的站点可以跟随任务的执行器），这时给通用四档、也不判谁不支持——
 * 不知道 ≠ 不支持。
 */
export function EffortPicker({
  type,
  model,
  value,
  disabled = false,
  variant = "field",
  label = "智能水平",
  followLabel = "跟随执行器",
  onChange,
}: {
  /** null = 还不知道会落到哪个 CLI，按通用档位给候选。 */
  type: AgentType | null;
  /** 当前选中的模型；空 = 跟随执行器，此时按 CLI 并集给候选。 */
  model: string | null | undefined;
  value: string;
  disabled?: boolean;
  /**
   * segment = 三段胶囊里的第三段（RunTargetPicker，外壳由胶囊画）；
   * chip = 单独摆的一颗小胶囊；field = 表单里跟输入框同高的独立控件。
   */
  variant?: "chip" | "field" | "segment";
  label?: string;
  /** 「不覆盖」那一行的措辞：执行器设置页里跟随的是 CLI 而不是执行器。 */
  followLabel?: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const efforts = useMemo(() => {
    const base = reasoningEffortsFor(type, model);
    // CLI 未定时已经选过的值不能凭空从候选里消失：那多半是别处设的，这里没有依据
    // 判它不合法，至少得让用户看得见、点得回来。
    return !type && value && !base.includes(value) ? [...base, value] : base;
  }, [model, type, value]);
  const supported = !type || isReasoningEffortSupported(type, model, value);
  const place = usePanelPlacement(triggerRef, panelRef, { minWidth: 200, minHeight: 120, fallbackHeight: 220 });

  useDismissable({
    enabled: open,
    containerRef: panelRef,
    onClose: () => setOpen(false),
    restoreFocusRef: triggerRef,
  });

  useLayoutEffect(() => {
    if (open) panelRef.current?.focus();
  }, [open]);

  // 这个模型没有档位可选：胶囊只作说明用（选过的值仍要显示，否则用户看不见要清什么）。
  const empty = efforts.length === 0;
  const pickable = !disabled && (!empty || !!value);
  const hint = !supported
    ? `${model || "当前模型"} 不支持 ${value}`
    : empty
      ? "该模型没有可调档位"
      : null;

  const rows = [{ value: "", label: followLabel, detail: "不指定，由上游决定" }, ...efforts.map((effort) => ({
    value: effort,
    label: effort,
    detail: REASONING_EFFORT_DETAIL[effort] ?? "",
  }))];

  const panel = open && (
    <div
      className="effort-picker-panel"
      ref={panelRef}
      tabIndex={-1}
      style={placementStyle(place)}
      role="listbox"
      aria-label={label}
    >
      {hint && (
        <p className={`effort-picker-hint${supported ? "" : " is-error"}`}>
          <Warning size={11} weight="fill" aria-hidden="true" />
          {supported ? hint : `${hint}，请改选档位或换一个模型`}
        </p>
      )}
      {rows.map((row) => (
        <button
          type="button"
          role="option"
          aria-selected={row.value === value}
          key={row.value || "follow"}
          onClick={() => { onChange(row.value); setOpen(false); triggerRef.current?.focus(); }}
        >
          <b>{row.label}</b>
          {row.detail && <span>{row.detail}</span>}
        </button>
      ))}
      {/* 已选值不在允许集合里时它不在候选中，得单独给一行，否则想清掉都点不着。 */}
      {!supported && !!value && (
        <button
          type="button"
          role="option"
          aria-selected
          className="is-unsupported"
          onClick={() => { onChange(""); setOpen(false); triggerRef.current?.focus(); }}
        >
          <b>{value}</b>
          <span>当前设置 · 点此清除</span>
        </button>
      )}
    </div>
  );

  return (
    <div className={`effort-picker is-${variant}`}>
      <button
        ref={triggerRef}
        type="button"
        className={`effort-picker-trigger${supported ? "" : " is-error"}`}
        disabled={!pickable}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${label}：${value || followLabel}${supported ? "" : "（当前模型不支持）"}；点击更改`}
        onClick={() => setOpen((current) => !current)}
      >
        {!supported && <Warning size={11} weight="fill" aria-hidden="true" />}
        <em>{value || (empty ? "无档位" : "跟随")}</em>
        {pickable && <CaretDown size={9} weight="bold" aria-hidden="true" />}
      </button>
      {/* chip 与 segment 都挤在一排里，多一行字会把工具条/胶囊撑变形：那里靠红色警告态
          加浮层里的说明。 */}
      {!supported && variant === "field" && <small className="effort-picker-warning">{hint}</small>}
      {panel && createPortal(panel, document.body)}
    </div>
  );
}
