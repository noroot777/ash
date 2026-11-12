import { useRef } from "react";
import { Minus, Plus } from "@phosphor-icons/react";
import "../styles/rounds-stepper.css";

/**
 * 轮数步进器：[−] n [+]。派审对话框里的「失败后自动复审几轮」、审查进行中的「最多几轮」、
 * 回复框旁那颗派审键都用这一颗，形状和读法只有一份。
 *
 * 两颗键的名字是「{label}少一轮 / {label}多一轮」，读屏一听就知道在调哪一个数。到了边界那颗
 * 键会灰掉，焦点要是正停在它上面就挪到另一颗，免得键盘一下子掉回 body。
 */
export function RoundsStepper({
  value,
  min = 0,
  max,
  label,
  disabled = false,
  className = "",
  onChange,
}: {
  value: number;
  min?: number;
  max: number;
  /** 这个数叫什么（读屏和两颗键的名字都从它来），如「自动复审」「最多轮数」。 */
  label: string;
  disabled?: boolean;
  className?: string;
  onChange: (value: number) => void;
}) {
  const less = useRef<HTMLButtonElement>(null);
  const more = useRef<HTMLButtonElement>(null);
  const step = (delta: number) => {
    const next = Math.min(max, Math.max(min, value + delta));
    if (next === value) return;
    onChange(next);
    if (next <= min && document.activeElement === less.current) more.current?.focus();
    if (next >= max && document.activeElement === more.current) less.current?.focus();
  };
  return (
    <span
      className={`rounds-stepper ${className}`.trim()}
      role="group"
      aria-label={label}
      onKeyDown={(event) => {
        // 停在任意一颗键上时，上下方向键也能调数（跟原生数字框一样的手感）。
        if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
        event.preventDefault();
        step(event.key === "ArrowUp" ? 1 : -1);
      }}
    >
      <button ref={less} type="button" aria-label={`${label}少一轮`} disabled={disabled || value <= min} onClick={() => step(-1)}>
        <Minus aria-hidden="true" />
      </button>
      <output aria-live="polite">{value}</output>
      <button ref={more} type="button" aria-label={`${label}多一轮`} disabled={disabled || value >= max} onClick={() => step(1)}>
        <Plus aria-hidden="true" />
      </button>
    </span>
  );
}
