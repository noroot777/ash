// 一格最上面那一块：一句结论（InspConclusion）、一个主动作（InspMainButton）和「更多」。
//
// 「更多」：其余动作收进这里。只剩一项时不绕一层菜单，直接摆成一颗安静键；一项都没有就什么
// 也不画。菜单挂到 body 上（面板是会滚的容器，贴着里面弹会被裁），关法统一走 useDismissable。
import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, HandPalm, MagnifyingGlass, SpinnerGap, X } from "@phosphor-icons/react";
import { Menu, MenuItem } from "../components/ui.tsx";
import { useDismissable } from "../lib/useDismissable.ts";
import { placementStyle, usePanelPlacement } from "../lib/usePanelPlacement.ts";
import { InspButton } from "./parts.tsx";
import { DrawnCheck } from "../lib/motion/index.ts";

export type InspTone = "ok" | "bad" | "stale" | "busy" | "hold" | "none";

export interface InspMainAction {
  label: string;
  onClick: () => void;
  /** 有事要你办的时候才是实心的。 */
  pri?: boolean;
  disabled?: boolean;
  pressed?: boolean;
  dialog?: boolean;
}

const TONE_ICON: Record<Exclude<InspTone, "busy">, ReactNode> = {
  ok: <Check size={16} weight="bold" />,
  bad: <X size={16} weight="bold" />,
  stale: <MagnifyingGlass size={16} />,
  hold: <HandPalm size={16} weight="fill" />,
  none: <MagnifyingGlass size={16} />,
};

/** 那一句结论：在跑的只用主色字，其余前面一颗表示结论的图标。 */
export function InspConclusion({ tone, children }: { tone: InspTone; children: ReactNode }) {
  // 看着它从「在跑」落成「通过」的那一下，对勾描出来（08「点睛」对勾）；打开时就已经通过的不描。
  const previous = useRef(tone);
  const drawCheck = tone === "ok" && previous.current === "busy";
  useLayoutEffect(() => { previous.current = tone; }, [tone]);
  return (
    <p className={`insp-now is-${tone}`} role="status">
      {tone === "busy"
        ? <><SpinnerGap size={16} className="is-spinning" aria-hidden="true" /><span className="insp-live">{children}</span></>
        : <><span className="insp-now__icon" aria-hidden="true">{tone === "ok" ? <DrawnCheck draw={drawCheck} /> : TONE_ICON[tone]}</span><span>{children}</span></>}
    </p>
  );
}

export function InspMainButton({ action }: { action: InspMainAction }) {
  return (
    <InspButton
      variant={action.pri ? "pri" : "default"}
      disabled={action.disabled}
      aria-pressed={action.pressed}
      aria-haspopup={action.dialog ? "dialog" : undefined}
      onClick={action.onClick}
    >
      {action.label}
    </InspButton>
  );
}

export interface InspMoreItem {
  key: string;
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  danger?: boolean;
}

/** 一格顶上的那一排：主动作在前，「更多」在后。 */
export function InspActions({ children }: { children: ReactNode }) {
  return <div className="insp-do">{children}</div>;
}

export function InspMore({ items, label = "更多" }: { items: InspMoreItem[]; label?: string }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const place = usePanelPlacement(triggerRef, menuRef, { minWidth: 180, minHeight: 80, fallbackHeight: 40 * items.length + 8, enabled: open });
  useDismissable({ enabled: open, containerRef: menuRef, onClose: () => setOpen(false), restoreFocusRef: triggerRef });

  useLayoutEffect(() => {
    if (open) menuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [open]);

  if (!items.length) return null;
  if (items.length === 1) {
    const [only] = items;
    return (
      <InspButton variant={only.danger ? "danger" : "quiet"} disabled={only.disabled} onClick={only.onSelect}>
        {only.label}
      </InspButton>
    );
  }

  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
    const buttons = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
    if (!buttons.length) return;
    event.preventDefault();
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home" ? 0
      : event.key === "End" ? buttons.length - 1
        : (at + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next]?.focus();
  };

  return (
    <>
      <InspButton
        ref={triggerRef}
        variant="quiet"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        {label}
      </InspButton>
      {open && createPortal(
        <div ref={menuRef} className="insp-more-menu" style={place ? { ...placementStyle(place), width: undefined } : { visibility: "hidden" }} onKeyDown={move}>
          <Menu>
            {items.map((item) => (
              <MenuItem
                key={item.key}
                danger={item.danger}
                disabled={item.disabled}
                onClick={() => {
                  setOpen(false);
                  triggerRef.current?.focus();
                  item.onSelect();
                }}
              >
                {item.label}
              </MenuItem>
            ))}
          </Menu>
        </div>,
        document.body,
      )}
    </>
  );
}
