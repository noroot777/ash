import { useRef, useState, type ReactNode } from "react";
import { DotsThree } from "@phosphor-icons/react";
import { useDismissable } from "../lib/useDismissable.ts";
import { IconButton } from "./IconButton.tsx";
import type { HoverTipPlacement } from "./HoverTip.tsx";

export type IconMenuItem = {
  label: string;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  onPick: () => void;
};

/**
 * 一颗「更多」图标键加它弹出来的那张菜单。回合尾、气泡这些地方的「更多」都是它：
 * 平时只画三个点，名字在提示里，菜单的关法（点外面、Esc、焦点回到键上）走 useDismissable。
 */
export function IconMenu({ label = "更多", items, placement, size = "sm", align = "start" }: {
  label?: string;
  items: IconMenuItem[];
  placement?: HoverTipPlacement;
  size?: "md" | "sm";
  /** 菜单贴着键的哪一边展开。 */
  align?: "start" | "end";
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useDismissable({ enabled: open, containerRef: root, onClose: () => setOpen(false), restoreFocusRef: button });
  if (!items.length) return null;
  return (
    <span className="ui-menu-anchor" ref={root}>
      <IconButton
        ref={button}
        label={label}
        size={size}
        placement={placement}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <DotsThree size={size === "sm" ? 15 : 17} weight="bold" aria-hidden="true" />
      </IconButton>
      {open && (
        <div className={`ui-menu${align === "end" ? " is-end" : ""}`} role="menu">
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className={item.danger ? "is-danger" : undefined}
              disabled={item.disabled}
              onClick={() => { setOpen(false); item.onPick(); }}
            >
              {item.icon}{item.label}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}
