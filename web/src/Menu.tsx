import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, PushPin } from "@phosphor-icons/react";

export type MenuOption = { value: string; label: string; icon?: ReactNode; detail?: string; separatorBefore?: boolean };

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
  maxHeight = 288,
  onSetDefault,
  defaultValue,
  header,
  footer,
}: {
  options: MenuOption[];
  value?: string;
  onChange: (v: string) => void;
  children: ReactNode;
  triggerClassName?: string;
  align?: "left" | "right";
  menuWidth?: number;
  maxHeight?: number;
  onSetDefault?: (v: string) => void;
  defaultValue?: string;
  header?: (api: { select: (v: string) => void; close: () => void }) => ReactNode;
  footer?: (api: { select: (v: string) => void; close: () => void }) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  // `closing` keeps the portal mounted through the exit animation; the enter
  // animation is pure CSS (the .t-dropdown keyframe plays when the portal mounts).
  const [closing, setClosing] = useState(false);
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number; width: number; maxH: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // 开/关的时刻:用来识别「刚由聚焦自动展开」和「刚被 Esc 关掉」这两个瞬间(见下)。
  const openedAt = useRef(0);
  const closedAt = useRef(0);
  const pointerAt = useRef(0); // 最近一次落在 trigger 上的 pointerdown
  const openRef = useRef(false);
  openRef.current = open;
  // refs so the listener effect can stay subscribed without resetting `active`
  const activeRef = useRef(0);
  activeRef.current = active;
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const valueRef = useRef(value);
  valueRef.current = value;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const close = useCallback(() => {
    closedAt.current = Date.now();
    setOpen(false);
    setClosing(true);
    const ms =
      parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue("--dropdown-close-dur"),
      ) || 150;
    window.setTimeout(() => setClosing(false), ms);
    if (activeClose === close) activeClose = null;
  }, []);
  const openMenu = useCallback(() => {
    if (activeClose && activeClose !== close) activeClose();
    activeClose = close;
    openedAt.current = Date.now();
    setClosing(false);
    setOpen(true);
  }, [close]);

  const place = () => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const w = menuWidth ?? Math.max(r.width, 180);
    const left = align === "right" ? Math.max(8, r.right - w) : Math.min(r.left, window.innerWidth - w - 8);
    const spaceBelow = window.innerHeight - r.bottom;
    const spaceAbove = r.top;
    // Flip up only when below is genuinely cramped and above is roomier. Either
    // way cap the height to the space actually available so a tall menu (e.g. the
    // project switcher) never spills past the viewport — the list scrolls instead.
    const up = spaceBelow < Math.min(maxHeight, 280) && spaceAbove > spaceBelow;
    const maxH = Math.min(maxHeight, Math.max(160, (up ? spaceAbove : spaceBelow) - 12));
    setPos(up
      ? { left, bottom: window.innerHeight - r.top + 4, width: w, maxH }
      : { left, top: r.bottom + 4, width: w, maxH });
  };

  useLayoutEffect(() => {
    if (open) place();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // 键盘(Tab)聚焦自动展开;鼠标点击带来的聚焦不算——那条路由 pointerdown 负责开关。
  // 判据用 `:focus-visible` 而不是自己维护「刚按过鼠标」的标志:从别的窗口切回来时,
  // 浏览器会给原本就聚焦的元素**重新派发 focus**,而且它排在 pointerdown 之前,标志
  // 那时早已过期 —— 于是 focus 先把菜单展开、紧跟着的 click 又当成收起把它关掉,表现
  // 正是「点一下闪一下就没了,再点一次才正常弹出」。
  useEffect(() => {
    const el = triggerRef.current;
    if (!el) return;
    const onFocus = () => {
      if (openRef.current) return;
      // Esc 关闭后会把焦点还给 trigger,别让它立刻又弹回来
      if (Date.now() - closedAt.current < 250) return;
      let keyboard = true;
      try {
        keyboard = el.matches(":focus-visible");
      } catch {
        /* 不认识 :focus-visible 的浏览器:退回旧行为(聚焦即展开) */
      }
      if (keyboard) openMenu();
    };
    el.addEventListener("focus", onFocus);
    return () => el.removeEventListener("focus", onFocus);
  }, [openMenu]);

  // Set the highlighted option to the current value when the menu opens.
  useEffect(() => {
    if (open) setActive(Math.max(0, optionsRef.current.findIndex((o) => o.value === valueRef.current)));
  }, [open]);

  // Listeners while open. Reads dynamic data from refs so it stays subscribed
  // across renders without resetting `active` (the arrow-key bug).
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!triggerRef.current?.contains(t) && !menuRef.current?.contains(t)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      const inInput = tag === "INPUT" || tag === "TEXTAREA";
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
        triggerRef.current?.focus();
        return;
      }
      if (inInput) return; // let the header input handle typing / Enter
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((a) => Math.min(a + 1, optionsRef.current.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((a) => Math.max(a - 1, 0));
      } else if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        const o = optionsRef.current[activeRef.current];
        if (o) {
          onChangeRef.current(o.value);
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
  }, [open, close]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={triggerClassName}
        onPointerDown={() => {
          pointerAt.current = Date.now();
          // 指针交互一律在 pointerdown 定开关,click 不再切换:否则「focus 先开、click 又关」。
          // 刚展开 250ms 内的按下是「打开它的那一下」,不当作收起(人也来不及看一眼就关)。
          if (open) {
            if (Date.now() - openedAt.current > 250) close();
          } else openMenu();
        }}
        onClick={() => {
          // 没有 pointerdown 的激活(键盘 Enter/Space、辅助技术派发的 click)才在这里处理;
          // 指针那一路已经在 pointerdown 定过开关了。
          if (Date.now() - pointerAt.current < 500) return;
          if (!open) openMenu();
          else if (Date.now() - openedAt.current > 250) close();
        }}
      >
        {children}
      </button>
      {(open || closing) &&
        pos &&
        createPortal(
          <div
            ref={menuRef}
            data-origin={`${pos.top !== undefined ? "top" : "bottom"}-${align === "right" ? "right" : "left"}`}
            className={`t-dropdown ${closing ? "is-closing" : ""} fixed z-[100] flex flex-col rounded-lg border border-line2 bg-panel p-1 shadow-xl`}
            style={{ left: pos.left, top: pos.top, bottom: pos.bottom, width: pos.width, maxHeight: pos.maxH }}
          >
            {header && (
              <div className="mb-1 shrink-0 border-b border-line px-1 pb-1.5 pt-0.5">
                {header({ select: (v: string) => { onChange(v); close(); }, close })}
              </div>
            )}
            <div className="min-h-0 flex-1 overflow-y-auto">
            {options.map((o, i) => (
              <div key={o.value} className={o.separatorBefore ? "mt-1 border-t border-line pt-1" : ""}>
                <button
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
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-ink">{o.label}</span>
                    {o.detail && <span className="truncate text-[11px] text-faint">{o.detail}</span>}
                  </span>
                  {onSetDefault &&
                    (defaultValue === o.value ? (
                      <span className="inline-flex items-center gap-1 text-[10px] text-accent">
                        <PushPin size={11} weight="fill" />默认
                      </span>
                    ) : (
                      <span
                        role="button"
                        title="设为默认（并选中）"
                        onClick={(e) => {
                          e.stopPropagation();
                          onSetDefault(o.value);
                          onChange(o.value);
                          close();
                        }}
                        className="text-faint opacity-0 transition-opacity hover:text-accent group-hover:opacity-100"
                      >
                        <PushPin size={13} />
                      </span>
                    ))}
                  {value === o.value && <Check size={13} weight="bold" className="text-accent" />}
                </button>
              </div>
            ))}
            </div>
            {footer && (
              <div className="mt-1 shrink-0 border-t border-line px-1 pt-1.5">
                {footer({ select: (v: string) => { onChange(v); close(); }, close })}
              </div>
            )}
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
  header,
}: {
  icon?: ReactNode;
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: MenuOption[];
  menuWidth?: number;
  onSetDefault?: (v: string) => void;
  defaultValue?: string;
  header?: (api: { select: (v: string) => void }) => ReactNode;
}) {
  return (
    <Menu
      value={value}
      onChange={onChange}
      options={options}
      menuWidth={menuWidth}
      onSetDefault={onSetDefault}
      defaultValue={defaultValue}
      header={header}
      triggerClassName="inline-flex items-center gap-1.5 rounded-full border border-line bg-panel px-2.5 py-1 text-[12px] text-ink transition-colors hover:bg-raised focus:border-accent focus:outline-none"
    >
      {icon}
      <span className="whitespace-nowrap">{label}</span>
    </Menu>
  );
}
