import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { DotsThree, SlidersHorizontal, Star, Trash } from "@phosphor-icons/react";
import { useDismissable } from "../lib/useDismissable.ts";
import { anchoredBelowEnd, useFollowAnchor, type AnchoredPlace } from "./anchoredPlace.ts";
import { ProfileArgsPopover } from "./ProfileArgsPopover.tsx";

/** 菜单收起的退场时长（和 executors-settings.css 里 .profile-row-menu.is-leaving 同一个数）。 */
const LEAVE_MS = 120;

/**
 * 执行器表行尾那颗常驻的「更多」：额外 CLI 参数、设为默认执行器、删除。
 *
 * 以前这三样平时藏着、指到这一行才浮出来——键盘和触屏都得先「找到」它们；现在常驻一颗
 * 按钮，里面还是这三样。额外参数设过时菜单项右边写着几项，原来那颗按钮上的小圆点就是说这个。
 */
export function ProfileRowMenu({
  profileName,
  extraArgs,
  isDefault,
  busy,
  onSaveArgs,
  onMakeDefault,
  onDelete,
}: {
  profileName: string;
  extraArgs: string[];
  isDefault: boolean;
  busy: boolean;
  onSaveArgs: (value: string[]) => Promise<boolean>;
  onMakeDefault: () => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [argsOpen, setArgsOpen] = useState(false);
  const [place, setPlace] = useState<AnchoredPlace | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useDismissable({ enabled: open, containerRef: menuRef, restoreFocusRef: triggerRef, onClose: () => setOpen(false) });

  useLayoutEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    const timer = window.setTimeout(() => setMounted(false), LEAVE_MS);
    return () => window.clearTimeout(timer);
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !mounted) return;
    const anchor = triggerRef.current;
    const menu = menuRef.current;
    if (!anchor || !menu) return;
    setPlace(anchoredBelowEnd(anchor, menu));
    menu.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [open, mounted]);
  useFollowAnchor(open && mounted, triggerRef, menuRef, setPlace);

  const pick = (action: () => void) => {
    setOpen(false);
    action();
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = {
      ArrowDown: items[(at + 1) % items.length],
      ArrowUp: items[(at - 1 + items.length) % items.length],
      Home: items[0],
      End: items[items.length - 1],
    }[event.key];
    if (next) {
      event.preventDefault();
      next.focus();
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    }
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="profile-row-more"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${profileName} 的更多操作`}
        disabled={busy}
        onClick={() => setOpen((current) => !current)}
      >
        <DotsThree size={16} weight="bold" aria-hidden="true" />
      </button>
      {mounted && createPortal(
        <div
          ref={menuRef}
          className={`profile-row-menu${open ? "" : " is-leaving"}${place?.up ? " is-up" : ""}`}
          role="menu"
          aria-label={`${profileName} 的更多操作`}
          style={place ? { left: place.left, top: place.top, bottom: place.bottom, zIndex: place.zIndex } : { visibility: "hidden" }}
          onKeyDown={onKeyDown}
        >
          <button type="button" role="menuitem" onClick={() => pick(() => setArgsOpen(true))}>
            <SlidersHorizontal size={15} aria-hidden="true" />
            <span>额外 CLI 参数</span>
            {extraArgs.length > 0 && <em>{extraArgs.length} 项</em>}
          </button>
          <button type="button" role="menuitem" disabled={isDefault} onClick={() => pick(onMakeDefault)}>
            <Star size={15} aria-hidden="true" />
            <span>设为默认执行器</span>
          </button>
          <hr />
          <button type="button" role="menuitem" className="is-danger" onClick={() => pick(onDelete)}>
            <Trash size={15} aria-hidden="true" />
            <span>删除</span>
          </button>
        </div>,
        document.body,
      )}
      {argsOpen && (
        <ProfileArgsPopover
          profileName={profileName}
          value={extraArgs}
          disabled={busy}
          anchorRef={triggerRef}
          onClose={() => setArgsOpen(false)}
          onSave={onSaveArgs}
        />
      )}
    </>
  );
}
