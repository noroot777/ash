import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { DotsThree } from "@phosphor-icons/react";
import { useDismissable } from "../lib/useDismissable.ts";

export type MenuItem = {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  separator?: boolean;
  icon?: ReactNode;
};
export function WorkbenchMenu({
  label,
  children,
  items,
  disabled,
  className = "icon-btn",
}: {
  label: string;
  children?: ReactNode;
  items: MenuItem[];
  disabled?: boolean;
  className?: string;
}) {
  const [position, setPosition] = useState<{
    left: number;
    top: number;
  } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const close = () => setPosition(null);
  useDismissable({
    enabled: !!position,
    containerRef: panel,
    onClose: close,
    restoreFocusRef: trigger,
  });
  useEffect(() => {
    if (!position) return;
    panel.current
      ?.querySelector<HTMLButtonElement>("button:not(:disabled)")
      ?.focus();
    window.addEventListener("resize", close);
    return () => window.removeEventListener("resize", close);
  }, [position]);
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
              className="menu"
              role="menu"
              aria-label={label}
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
              {items.map((item, index) => (
                <div key={index}>
                  {item.separator && (
                    <div className="menu-sep" role="separator" />
                  )}
                  <button
                    type="button"
                    role="menuitem"
                    className={`menu-item${item.danger ? " tone-danger" : ""}`}
                    disabled={item.disabled}
                    onClick={() => {
                      close();
                      item.onClick();
                    }}
                  >
                    {item.icon}
                    {item.label}
                  </button>
                </div>
              ))}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
