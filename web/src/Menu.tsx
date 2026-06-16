import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check } from "@phosphor-icons/react";

export type MenuOption = { value: string; label: string; icon?: ReactNode };

// App-styled dropdown (replaces native <select> for visual consistency):
// DOM popover, click-outside + Esc close, arrow-key nav, checkmark on selected.
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
  children: ReactNode; // trigger content
  triggerClassName?: string;
  align?: "left" | "right";
  menuWidth?: number;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setActive(Math.max(0, options.findIndex((o) => o.value === value)));
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
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
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, active, options, value, onChange]);

  return (
    <div ref={wrapRef} className="relative inline-block">
      <button type="button" onClick={() => setOpen((o) => !o)} className={triggerClassName}>
        {children}
      </button>
      {open && (
        <div
          className={`absolute top-full z-50 mt-1 max-h-72 min-w-[180px] overflow-y-auto rounded-lg border border-line2 bg-panel p-1 shadow-xl ${
            align === "right" ? "right-0" : "left-0"
          }`}
          style={menuWidth ? { width: menuWidth } : undefined}
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
        </div>
      )}
    </div>
  );
}
