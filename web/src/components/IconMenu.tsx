import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
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
export function IconMenu({ label = "更多", items, info, placement, size = "sm", align = "start", side = "below", buttonRef, className }: {
  label?: string;
  items: IconMenuItem[];
  /** 菜单底部一块只读的说明（回合尾的本轮用量），排在菜单项下面。 */
  info?: ReactNode;
  placement?: HoverTipPlacement;
  size?: "md" | "sm";
  /** 菜单贴着键的哪一边展开。 */
  align?: "start" | "end";
  /** 菜单开在键的下面还是上面（贴着屏幕底的回复框里开在上面）。开在下面却会被裁掉时（会话最后
   *  一回合的「更多」，下面就是回复框）自动翻到上面。 */
  side?: "below" | "above";
  /** 菜单项开出对话框时，关掉对话框要把焦点还给这颗键：调用方拿着它。 */
  buttonRef?: RefObject<HTMLButtonElement | null>;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const ownButton = useRef<HTMLButtonElement>(null);
  const button = buttonRef ?? ownButton;
  const menu = useRef<HTMLDivElement>(null);
  const [flipped, setFlipped] = useState(false);
  useDismissable({ enabled: open, containerRef: root, onClose: () => setOpen(false), restoreFocusRef: button });
  // 打开的那一下量一次：下面露不全、上面放得下才翻，两头都不够就照旧开在下面（滚一下能看全）。
  useLayoutEffect(() => {
    if (!open) {
      setFlipped(false);
      return;
    }
    if (side !== "below" || !menu.current || !root.current) return;
    const rect = menu.current.getBoundingClientRect();
    const visible = visibleRange(root.current);
    const roomAbove = root.current.getBoundingClientRect().top - visible.top;
    if (rect.bottom > visible.bottom && roomAbove >= rect.height + 4) setFlipped(true);
  }, [open, side]);
  if (!items.length && !info) return null;
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
        <div ref={menu} className={`ui-menu${align === "end" ? " is-end" : ""}${side === "above" || flipped ? " is-above" : ""}`} role="menu">
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
          {info && <>{items.length > 0 && <div className="ui-menu-separator" role="separator" />}<div className="ui-menu-info">{info}</div></>}
        </div>
      )}
    </span>
  );
}

/** 菜单能露出来的那一截：视口，再按一层层会裁掉它的容器收窄。 */
function visibleRange(element: HTMLElement): { top: number; bottom: number } {
  let top = 0;
  let bottom = window.innerHeight;
  for (let node = element.parentElement; node; node = node.parentElement) {
    if (getComputedStyle(node).overflowY === "visible") continue;
    const rect = node.getBoundingClientRect();
    top = Math.max(top, rect.top);
    bottom = Math.min(bottom, rect.bottom);
  }
  return { top, bottom };
}
