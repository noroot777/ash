import type { ReactNode } from "react";
import type { ActionVerdict } from "@ash/shared";
import { HoverTip, useHoverTip } from "./HoverTip.tsx";

/**
 * 更多菜单里一个由服务端判据决定能不能点的动作（判据见 lib/useTaskActions.ts）。
 *
 * 做不了的时候灰着、指上去说原因 —— 用 `aria-disabled` 而不是 `disabled`：Chrome 不给 `disabled`
 * 元素派发 `mouseenter`，那句原因就永远没人看得到。`hidden` 的结论由调用方决定不渲染。
 */
export function ActionMenuItem({ verdict, busy = false, className = "", onSelect, children }: {
  verdict: ActionVerdict;
  busy?: boolean;
  className?: string;
  onSelect: () => void;
  children: ReactNode;
}) {
  const hover = useHoverTip({ placement: "left" });
  const reason = verdict.ok ? null : verdict.reason;
  const off = !!reason || busy;
  return (
    <>
      <button
        type="button"
        role="menuitem"
        className={`${className}${off ? " is-disabled" : ""}`.trim() || undefined}
        aria-disabled={off || undefined}
        {...(reason ? hover.anchorProps : {})}
        onClick={() => { if (!off) onSelect(); }}
      >
        {children}
      </button>
      {reason && <HoverTip at={hover.at}>{reason}</HoverTip>}
    </>
  );
}
