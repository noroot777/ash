import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check } from "@phosphor-icons/react";

export type MenuOption = { value: string; label: string; icon?: ReactNode };

// App-styled dropdown (replaces native <select>). Renders the popover in a
// portal with fixed positioning so it is never clipped by a modal's overflow;
// flips upward when there isn't room below. Click-outside + Esc + arrow keys.
export function Menu({
  options,
  value,
  onChange,
  children,
  triggerClassName = "",
  align = "left",
  menuWidth,
}: {
  options: MenuOption[];
  value?: string;
  onChange: (v: string) => void;
  children: ReactNode;
  triggerClassName?: string;
  align?: "left" | "right";
  menuWidth?: number;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number; width: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const place = () => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const w = menuWidth ?? Math.max(r.width, 180);
    const left = align === "right" ? Math.max(8, r.right - w) : Math.min(r.left, window.innerWidth - w - 8);
    const spaceBelow = window.innerHeight - r.bottom;
    if (spaceBelow < 260 && r.top > spaceBelow) {
      setPos({ left, bottom: window.innerHeight - r.top + 4, width: w });
    } else {
      setPos({ left, top: r.bottom + 4, width: w });
    }
  };

  useLayoutEffect(() => {
    if (open) place();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setActive(Math.max(0, options.findIndex((o) => o.value === value)));
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!triggerRef.current?.contains(t) && !menuRef.current?.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((a) => Math.min(a + 1, options.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((a) => Math.max(a - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const o = options[active];
        if (o) {
          onChange(o.value);
          setOpen(false);
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
  }, [open, active, options, value, onChange]);

  return (
    <>
      <button ref={triggerRef} type="button" onClick={() => setOpen((o) => !o)} className={triggerClassName}>
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
                onMouseEnter={() => setActive(i)}
                onClick={() => {
                  onChange(o.value);
                  setOpen(false);
                }}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] ${
                  i === active ? "bg-raised" : ""
                }`}
              >
                {o.icon}
                <span className="flex-1 truncate text-ink">{o.label}</span>
                {value === o.value && <Check size={13} weight="bold" className="text-accent" />}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
