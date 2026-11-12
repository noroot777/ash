import type { ReactNode } from "react";
import { HoverTip, useHoverTip, type HoverTipPlacement } from "../components/HoverTip.tsx";

// 侧栏里那一排排纯图标键（随手记、搜索、打开任务列表、底部那四颗）。名字只在提示里，
// 键位跟在名字后面；读屏念的是 aria-label。点下去先把提示收掉 —— 点了多半要跳走或弹层，
// 气泡是 portal 到 body 的，留着会悬在原地。
export function SidebarIconButton({
  label,
  keys,
  pressed,
  expanded,
  haspopup,
  placement = "below",
  className = "",
  onClick,
  children,
}: {
  label: string;
  keys?: string;
  pressed?: boolean;
  expanded?: boolean;
  haspopup?: "menu" | "listbox" | "dialog";
  placement?: HoverTipPlacement;
  className?: string;
  onClick: () => void;
  children: ReactNode;
}) {
  const tip = useHoverTip({ placement });
  return (
    <>
      <button
        className={`workspace-side-icon${className ? ` ${className}` : ""}`}
        type="button"
        aria-label={label}
        aria-pressed={pressed}
        aria-expanded={expanded}
        aria-haspopup={haspopup}
        {...tip.anchorProps}
        onClick={() => { tip.hide(); onClick(); }}
      >
        {children}
      </button>
      <HoverTip at={tip.at}>{label}{keys && <> <kbd>{keys}</kbd></>}</HoverTip>
    </>
  );
}
