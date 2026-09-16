import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, DotsThree } from "@phosphor-icons/react";
import { useDismissable } from "../lib/useDismissable.ts";

export type MenuItem = {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  separator?: boolean;
  icon?: ReactNode;
  description?: string;
  selected?: boolean;
  labelMono?: boolean;
  descriptionMono?: boolean;
};
export function WorkbenchMenu({
  label,
  children,
  items,
  disabled,
  className = "icon-btn",
  variant = "menu",
}: {
  label: string;
  children?: ReactNode;
  items: MenuItem[];
  disabled?: boolean;
  className?: string;
  variant?: "menu" | "picker";
}) {
  const [position, setPosition] = useState<{
    left: number;
    top: number;
  } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const open = position !== null;
  const close = () => setPosition(null);
  useDismissable({
    enabled: open,
    containerRef: panel,
    onClose: close,
    restoreFocusRef: trigger,
  });
  useLayoutEffect(() => {
    if (!open || variant !== "picker" || !panel.current) return;
    const menu = panel.current;
    const reposition = () => {
      const rect = menu.getBoundingClientRect();
      const anchor = trigger.current!.getBoundingClientRect();
      const left = Math.max(8, Math.min(anchor.left, window.innerWidth - rect.width - 8));
      const top = Math.max(8, Math.min(anchor.bottom + 6, window.innerHeight - rect.height - 8));
      setPosition((current) => !current || (left === current.left && top === current.top) ? current : { left, top });
    };
    reposition();
    const observer = new ResizeObserver(reposition);
    observer.observe(menu);
    return () => observer.disconnect();
  }, [open, variant]);
  useEffect(() => {
    if (!open) return;
    (panel.current?.querySelector<HTMLButtonElement>("button:not(:disabled)") || panel.current)?.focus();
    const closeOnScroll = (event: Event) => {
      if (event.target instanceof Node && panel.current?.contains(event.target)) return;
      close();
    };
    window.addEventListener("scroll", closeOnScroll, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", closeOnScroll, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);
  return (
    <>
      <button
        type="button"
        ref={trigger}
        className={className}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={!!position}
        disabled={disabled}
        onClick={() => {
          if (position) {
            close();
            return;
          }
          const rect = trigger.current!.getBoundingClientRect();
          const height = Math.min(items.length * 29 + 8, 320);
          setPosition({
            left: Math.max(8, Math.min(rect.left, window.innerWidth - 258)),
            top: Math.max(
              8,
              Math.min(rect.bottom + 4, window.innerHeight - height - 8),
            ),
          });
        }}
      >
        {children || <DotsThree size={18} weight="bold" />}
      </button>
      {position &&
        createPortal(
          <div className="gwb-design gwb-menu-portal">
            <div
              ref={panel}
              className={`menu${variant === "picker" ? " gwb-picker-menu" : ""}`}
              role="menu"
              aria-label={label}
              tabIndex={-1}
              style={position}
              onKeyDown={(event) => {
                if (
                  !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)
                )
                  return;
                event.preventDefault();
                const buttons = [
                  ...panel.current!.querySelectorAll<HTMLButtonElement>(
                    "button:not(:disabled)",
                  ),
                ];
                const index = buttons.indexOf(
                  document.activeElement as HTMLButtonElement,
                );
                const next =
                  event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? buttons.length - 1
                      : (index +
                          (event.key === "ArrowDown" ? 1 : -1) +
                          buttons.length) %
                        buttons.length;
                buttons[next]?.focus();
              }}
            >
              {variant === "picker" && (
                <div className="gwb-picker-heading" aria-hidden="true">
                  <strong>{label}</strong>
                  <span>{items.length}</span>
                </div>
              )}
              <div className={variant === "picker" ? "gwb-picker-list" : undefined}>
                {items.map((item, index) => (
                  <div key={index}>
                    {item.separator && (
                      <div className="menu-sep" role="separator" />
                    )}
                    <button
                      type="button"
                      role="menuitem"
                      className={`menu-item${item.danger ? " tone-danger" : ""}${item.selected ? " is-current" : ""}`}
                      aria-label={item.description ? `${item.label} · ${item.description}` : undefined}
                      aria-current={item.selected || undefined}
                      disabled={item.disabled}
                      onClick={() => {
                        close();
                        item.onClick();
                      }}
                    >
                      {variant === "picker" ? (
                        <>
                          <span className="gwb-picker-icon" aria-hidden="true">{item.icon}</span>
                          <span className="gwb-picker-copy">
                            <span className={`gwb-picker-name${item.labelMono ? " is-mono" : ""}`}>{item.label}</span>
                            {item.description && <span className={`gwb-picker-description${item.descriptionMono ? " is-mono" : ""}`}>{item.description}</span>}
                          </span>
                          {item.selected && <span className="gwb-picker-current" aria-hidden="true"><Check size={11} weight="bold" />当前</span>}
                        </>
                      ) : <>{item.icon}{item.label}</>}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
