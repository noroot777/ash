import { forwardRef, type ButtonHTMLAttributes, type FocusEvent, type MouseEvent, type ReactNode } from "react";
import { HoverTip, useHoverTip, type HoverTipPlacement } from "./HoverTip.tsx";

/**
 * 一颗只画图标的键：名字不写在键上，写在 `aria-label` 和指上去才出的提示里。
 *
 * 改版以后头上、回合尾、侧栏底都是这种键（docs/ui-ux-audit 03：右边只剩图标，名字在提示里），
 * 每一处都自己拼一遍 useHoverTip + aria-label，迟早有一处漏了提示或漏了读屏名。收成一个。
 *
 * `tip` 不给就念 `label`；给了可以多说半句（快捷键、为什么点不了）。
 */
export const IconButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  tip?: ReactNode;
  placement?: HoverTipPlacement;
  size?: "md" | "sm";
  children: ReactNode;
}>(function IconButton(
  { label, tip, placement, size = "md", className = "", children, type = "button", onMouseEnter, onMouseLeave, onFocus, onBlur, onClick, ...props },
  ref,
) {
  const hover = useHoverTip(placement ? { placement } : undefined);
  return (
    <>
      <button
        ref={ref}
        type={type}
        aria-label={label}
        className={`ui-icon-button${size === "sm" ? " is-sm" : ""} ${className}`.trim()}
        onMouseEnter={(event: MouseEvent<HTMLButtonElement>) => { hover.anchorProps.onMouseEnter(event); onMouseEnter?.(event); }}
        onMouseLeave={(event: MouseEvent<HTMLButtonElement>) => { hover.anchorProps.onMouseLeave(); onMouseLeave?.(event); }}
        onFocus={(event: FocusEvent<HTMLButtonElement>) => { hover.anchorProps.onFocus(event); onFocus?.(event); }}
        onBlur={(event: FocusEvent<HTMLButtonElement>) => { hover.anchorProps.onBlur(); onBlur?.(event); }}
        onClick={(event: MouseEvent<HTMLButtonElement>) => { hover.hide(); onClick?.(event); }}
        {...props}
      >
        {children}
      </button>
      <HoverTip at={hover.at}>{tip ?? label}</HoverTip>
    </>
  );
});
