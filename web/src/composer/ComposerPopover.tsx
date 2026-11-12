import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { CaretDown, X } from "@phosphor-icons/react";
import { HoverTip, useHoverTip } from "../components/HoverTip.tsx";
import { useDismissable } from "../lib/useDismissable.ts";

/**
 * 新建卡片上那一排选项入口点开的浮层，也给回复框的旧发送设置用（`tone` 不传 = 旧长相，带下拉尖角）。
 *
 * `tone="opt"` 是输入区下面那排入口：图标 + 当前值，没有底色和尖角，名字和当前值在提示里；
 * `iconOnly` 时键上只有图标（更多选项、快捷键）。`plain` 去掉浮层的标题行（帮助卡自己分组）。
 * `align="end"` 让浮层右缘对齐入口（入口在卡片右半边时，例如「谁来做」）。
 * `open` / `onOpenChange` 传了就由外面管开关（⌘/ 要能从键盘开合帮助）。
 */
export function ComposerPopover({ label, value, trigger, children, wide = false, className = "", disabled = false,
  tone, iconOnly = false, plain = false, align = "start", panelClassName = "", shortcut, heading, open: controlled, onOpenChange }: {
  label: string;
  /** 浮层标题行写的字，缺省同 label（「更多选项」点开后标题是里面那一样的名字）。 */
  heading?: string;
  value?: string;
  trigger: ReactNode;
  children: ReactNode | ((close: () => void) => ReactNode);
  wide?: boolean;
  className?: string;
  disabled?: boolean;
  tone?: "opt";
  iconOnly?: boolean;
  plain?: boolean;
  align?: "start" | "end";
  panelClassName?: string;
  /** 提示里跟在名字后面的键名（帮助那颗写 ⌘/）。 */
  shortcut?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [own, setOwn] = useState(false);
  const open = controlled ?? own;
  const setOpen = (next: boolean) => { if (controlled === undefined) setOwn(next); onOpenChange?.(next); };
  const [position, setPosition] = useState({ left: 12, top: 12 });
  const anchor = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  const tip = useHoverTip({ placement: "above" });
  const close = () => setOpen(false);
  useDismissable({ enabled: open, containerRef: panel, restoreFocusRef: anchor, onClose: close });

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      if (!anchor.current || !panel.current) return;
      const rect = anchor.current.getBoundingClientRect();
      const { offsetWidth: width, offsetHeight: height } = panel.current;
      const from = align === "end" ? rect.right - width : rect.left;
      const left = Math.max(12, Math.min(from, window.innerWidth - width - 12));
      const below = rect.bottom + 6;
      const top = below + height <= window.innerHeight - 12 ? below : Math.max(12, rect.top - height - 6);
      setPosition((previous) => previous.left === left && previous.top === top ? previous : { left, top });
    };
    place();
    panel.current?.focus({ preventScroll: true });
    const observer = new ResizeObserver(place);
    if (panel.current) observer.observe(panel.current);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [align, open]);

  const finish = () => { close(); anchor.current?.focus(); };
  const opt = tone === "opt";
  const named = value ? `${label}：${value}` : label;
  return <>
    <button type="button" ref={anchor}
      className={opt ? `composer-opt${iconOnly ? " is-icon" : ""} ${className}`.trim() : `studio-aux-button ${className}`}
      aria-label={named} aria-haspopup="dialog"
      aria-expanded={open} aria-controls={id} disabled={disabled} onClick={() => { tip.hide(); setOpen(!open); }}
      {...(opt ? tip.anchorProps : {})}>
      {trigger}{!opt && <CaretDown size={10} className="studio-aux-caret" aria-hidden="true" />}
    </button>
    {opt && !open && <HoverTip at={tip.at}>{named}{shortcut && <kbd>{shortcut}</kbd>}</HoverTip>}
    {createPortal(<div ref={panel} id={id} role="dialog" aria-label={label} tabIndex={-1}
      hidden={!open} className={`studio-popover${wide ? " is-wide" : ""}${plain ? " is-plain" : ""} ${panelClassName}`.trim()} style={position}>
      {!plain && <header><b>{heading ?? label}</b><button type="button" aria-label={`收起${heading ?? label}`} onClick={finish}><X size={14} /></button></header>}
      <div className="studio-popover-body">{typeof children === "function" ? children(finish) : children}</div>
    </div>, document.body)}
  </>;
}
