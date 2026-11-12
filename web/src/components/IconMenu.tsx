import { useRef, useState, type ReactNode, type RefObject } from "react";
import { DotsThree } from "@phosphor-icons/react";
import { useDismissable } from "../lib/useDismissable.ts";
import { IconButton } from "./IconButton.tsx";
import type { HoverTipPlacement } from "./HoverTip.tsx";

export type IconMenuItem = {
  label: string;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  testId?: string;
  onPick: () => void;
};

/**
 * 一颗「更多」图标键加它弹出来的那张菜单。回合尾、气泡这些地方的「更多」都是它：
 * 平时只画三个点，名字在提示里，菜单的关法（点外面、Esc、焦点回到键上）走 useDismissable。
 */
export function IconMenu({ label = "更多", items, placement, size = "sm", align = "start", side = "below", buttonRef, className }: {
  label?: string;
  items: IconMenuItem[];
  placement?: HoverTipPlacement;
  size?: "md" | "sm";
  /** 菜单贴着键的哪一边展开。 */
  align?: "start" | "end";
  /** 菜单开在键的下面还是上面（贴着屏幕底的回复框里开在上面）。 */
  side?: "below" | "above";
  /** 菜单项开出对话框时，关掉对话框要把焦点还给这颗键：调用方拿着它。 */
  buttonRef?: RefObject<HTMLButtonElement | null>;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const ownButton = useRef<HTMLButtonElement>(null);
  const button = buttonRef ?? ownButton;
  useDismissable({ enabled: open, containerRef: root, onClose: () => setOpen(false), restoreFocusRef: button });
  if (!items.length) return null;
  return (
    <span className={`ui-menu-anchor${className ? ` ${className}` : ""}`} ref={root}>
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
        <div className={`ui-menu${align === "end" ? " is-end" : ""}${side === "above" ? " is-above" : ""}`} role="menu">
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className={item.danger ? "is-danger" : undefined}
              disabled={item.disabled}
              data-testid={item.testId}
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
