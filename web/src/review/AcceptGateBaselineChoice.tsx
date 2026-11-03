import type { AcceptGateBaseline } from "@ash/shared/accept-gate";
import { ACCEPT_GATE_BASELINE_LABELS, ACCEPT_GATE_BASELINES } from "@ash/shared/accept-gate";
import { useRovingChoice } from "../lib/useRovingChoice.ts";

// 门禁基准的三档单选。「项目设置 → 验收」和验收台门禁卡用的是同一颗（同一个项目字段，见
// shared/src/accept-gate.ts 的 AcceptGateBaseline）。「这一档意味着什么」那句话由调用方配
// （shared 的 acceptGateBaselineEffect）：两处摆放的位置不同，话是同一句。
export function AcceptGateBaselineChoice({ value, onChange, disabled = false }: {
  value: AcceptGateBaseline;
  onChange: (value: AcceptGateBaseline) => void;
  disabled?: boolean;
}) {
  const pick = (next: AcceptGateBaseline) => { if (!disabled && next !== value) onChange(next); };
  const { groupProps, itemProps } = useRovingChoice(ACCEPT_GATE_BASELINES, value, pick);
  return (
    <div className="accept-gate-baseline" {...groupProps} aria-label="门禁基准">
      {ACCEPT_GATE_BASELINES.map((mode) => (
        <button key={mode} type="button" disabled={disabled} {...itemProps(mode)} onClick={() => pick(mode)}>
          {ACCEPT_GATE_BASELINE_LABELS[mode]}
        </button>
      ))}
    </div>
  );
}
