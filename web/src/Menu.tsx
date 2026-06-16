import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, PushPin } from "@phosphor-icons/react";

export type MenuOption = { value: string; label: string; icon?: ReactNode };

// Only one menu open at a time (so Tab-focusing a new pill closes the previous).
let activeClose: (() => void) | null = null;

// App-styled dropdown (replaces native <select>). Portal-positioned (never
// clipped by modal overflow, flips up near the bottom). Keyboard-focusing the
// trigger (Tab) auto-opens it; arrow keys + Enter pick; click-outside + Esc close.
// Optional per-option "set as default" pin (onSetDefault/defaultValue).
export function Menu({
  options,
  value,
  onChange,
  children,
  triggerClassName = "",
  align = "left",
  menuWidth,
  onSetDefault,
  defaultValue,
}: {
  options: MenuOption[];
  value?: string;
  onChange: (v: string) => void;
  children: ReactNode;
  triggerClassName?: string;
  align?: "left" | "right";
  menuWidth?: number;
  onSetDefault?: (v: string) => void;
  defaultValue?: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number; width: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const mouse = useRef(false); // distinguishes pointer-focus from keyboard(Tab)-focus

  const close = useCallback(() => {
    setOpen(false);
    if (activeClose === close) activeClose = null;
  }, []);
  const openMenu = useCallback(() => {
    if (activeClose && activeClose !== close) activeClose();
    activeClose = close;
    setOpen(true);
  }, [close]);

  const place = () => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const w = menuWidth ?? Math.max(r.width, 180);
    const left = align === "right" ? Math.max(8, r.right - w) : Math.min(r.left, window.innerWidth - w - 8);
    const spaceBelow = window.innerHeight - r.bottom;
    if (spaceBelow < 260 && r.top > spaceBelow) setPos({ left, bottom: window.innerHeight - r.top + 4, width: w });
    else setPos({ left, top: r.bottom + 4, width: w });
  };

  useLayoutEffect(() => {
    if (open) place();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Keyboard (Tab) focus auto-opens the menu. Native listener fires reliably for
  // both real Tab and programmatic focus; mouse-initiated focus is skipped.
  useEffect(() => {
    const el = triggerRef.current;
    if (!el) return;
    const onFocus = () => {
      if (!mouse.current) openMenu();
    };
    el.addEventListener("focus", onFocus);
    return () => el.removeEventListener("focus", onFocus);
  }, [openMenu]);

  useEffect(() => {
    if (!open) return;
    setActive(Math.max(0, options.findIndex((o) => o.value === value)));
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!triggerRef.current?.contains(t) && !menuRef.current?.contains(t)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
        triggerRef.current?.focus();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((a) => Math.min(a + 1, options.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((a) => Math.max(a - 1, 0));
      } else if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        const o = options[active];
        if (o) {
          onChange(o.value);
          close();
        }
      }
    };
    const onScroll = () => place();
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", onScroll);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", onScroll);
      window.removeEventListener("scroll", onScroll, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, active, options, value, onChange, close]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={triggerClassName}
        onPointerDown={() => {
          mouse.current = true;
          setTimeout(() => (mouse.current = false), 400);
        }}
        onClick={() => (open ? close() : openMenu())}
      >
        {children}
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={menuRef}
            className="fixed z-[100] max-h-72 overflow-y-auto rounded-lg border border-line2 bg-panel p-1 shadow-xl"
            style={{ left: pos.left, top: pos.top, bottom: pos.bottom, width: pos.width }}
          >
            {options.map((o, i) => (
              <button
                key={o.value}
                type="button"
                tabIndex={-1}
                onMouseEnter={() => setActive(i)}
                onClick={() => {
                  onChange(o.value);
                  close();
                }}
                className={`group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] ${
                  i === active ? "bg-raised" : ""
                }`}
              >
                {o.icon}
                <span className="flex-1 truncate text-ink">{o.label}</span>
                {onSetDefault &&
                  (defaultValue === o.value ? (
                    <span className="inline-flex items-center gap-1 text-[10px] text-accent">
                      <PushPin size={11} weight="fill" />默认
                    </span>
                  ) : (
                    <span
                      role="button"
                      title="设为默认"
                      onClick={(e) => {
                        e.stopPropagation();
                        onSetDefault(o.value);
                      }}
                      className="text-faint opacity-0 transition-opacity hover:text-accent group-hover:opacity-100"
                    >
                      <PushPin size={13} />
                    </span>
                  ))}
                {value === o.value && <Check size={13} weight="bold" className="text-accent" />}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}

// Shared Linear-style property pill (rounded-full trigger + Menu dropdown).
export function Pill({
  icon,
  label,
  value,
  onChange,
  options,
  menuWidth,
  onSetDefault,
  defaultValue,
}: {
  icon?: ReactNode;
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: MenuOption[];
  menuWidth?: number;
  onSetDefault?: (v: string) => void;
  defaultValue?: string;
}) {
  return (
    <Menu
      value={value}
      onChange={onChange}
      options={options}
      menuWidth={menuWidth}
      onSetDefault={onSetDefault}
      defaultValue={defaultValue}
      triggerClassName="inline-flex items-center gap-1.5 rounded-full border border-line bg-panel px-2.5 py-1 text-[12px] text-ink transition-colors hover:bg-raised focus:border-accent focus:outline-none"
    >
      {icon}
      <span className="whitespace-nowrap">{label}</span>
    </Menu>
  );
}
