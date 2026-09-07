import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { CaretDown, X } from "@phosphor-icons/react";
import { useDismissable } from "../lib/useDismissable.ts";

export function ComposerPopover({ label, value, trigger, children, wide = false, className = "", disabled = false }: {
  label: string;
  value?: string;
  trigger: ReactNode;
  children: ReactNode | ((close: () => void) => ReactNode);
  wide?: boolean;
  className?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 12, top: 12 });
  const anchor = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  const close = () => setOpen(false);
  useDismissable({ enabled: open, containerRef: panel, restoreFocusRef: anchor, onClose: close });

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      if (!anchor.current || !panel.current) return;
      const rect = anchor.current.getBoundingClientRect();
      const { offsetWidth: width, offsetHeight: height } = panel.current;
      const left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12));
      const below = rect.bottom + 8;
      const top = below + height <= window.innerHeight - 12 ? below : Math.max(12, rect.top - height - 8);
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
  }, [open]);

  const finish = () => { close(); anchor.current?.focus(); };
  return <>
    <button type="button" ref={anchor} className={`studio-aux-button ${className}`}
      aria-label={value ? `${label}：${value}` : label} aria-haspopup="dialog"
      aria-expanded={open} aria-controls={id} disabled={disabled} onClick={() => setOpen(!open)}>
      {trigger}<CaretDown size={10} className="studio-aux-caret" aria-hidden="true" />
    </button>
    {createPortal(<div ref={panel} id={id} role="dialog" aria-label={label} tabIndex={-1}
      hidden={!open} className={`studio-popover${wide ? " is-wide" : ""}`} style={position}>
      <header><b>{label}</b><button type="button" aria-label={`收起${label}`} onClick={finish}><X size={14} /></button></header>
      <div className="studio-popover-body">{typeof children === "function" ? children(finish) : children}</div>
    </div>, document.body)}
  </>;
}
