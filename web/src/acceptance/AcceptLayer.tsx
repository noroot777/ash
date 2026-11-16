import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useDismissable } from "../lib/useDismissable.ts";

/**
 * 从验收台某一颗键下面点出来的那一层（确认、打回、换目标分支、提交清单、前置命令设置）。
 *
 * portal 到 body、按键的位置 fixed 摆：这套控件住的四处宿主里有三处会裁内容（团队记录卡
 * `overflow:hidden`、讨论结论横条和工作流侧栏都是滚动容器），就地 absolute 会被切掉一半。
 * 关法走 useDismissable：点外面、Esc、焦点回到那颗键；键本身登记成 restoreFocusRef，所以
 * 点它不算「点了外面」，开关由它自己的 onClick 来翻。
 */
export function AcceptLayer({ open, anchorRef, onClose, label, role = "dialog", align = "start", className = "", children }: {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  label: string;
  role?: "dialog" | "menu";
  align?: "start" | "end";
  className?: string;
  children: ReactNode;
}) {
  const layer = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ top: number; left: number; maxHeight: number } | null>(null);
  useDismissable({ enabled: open, containerRef: layer, onClose, restoreFocusRef: anchorRef });
  // 开着就一直量：下面放得下就放下面，不行而上面放得下就翻上去；上下都放不下（层高、窗口矮）就
  // 整层收进视口、盖住那颗键 —— 决定键在层底，任何一边越出去都等于按不到。高度上限也按视口量，
  // 不靠 CSS 的 100vh（手机浏览器里它比可见区高）。左右同样夹在视口里。
  useLayoutEffect(() => {
    if (!open) { setAt(null); return; }
    const place = () => {
      const anchor = anchorRef.current?.getBoundingClientRect();
      const panel = layer.current;
      if (!anchor || !panel) return;
      const viewport = window.innerHeight;
      const maxHeight = Math.max(0, viewport - 16);
      const width = panel.offsetWidth;
      const height = Math.min(panel.offsetHeight, maxHeight);
      const below = anchor.bottom + 6;
      const above = anchor.top - 6 - height;
      const top = below + height <= viewport - 8 ? below
        : above >= 8 ? above
        : Math.max(8, viewport - 8 - height);
      const wanted = align === "end" ? anchor.right - width : anchor.left;
      const left = Math.max(8, Math.min(wanted, window.innerWidth - width - 8));
      setAt((prev) => prev && prev.top === top && prev.left === left && prev.maxHeight === maxHeight ? prev : { top, left, maxHeight });
    };
    place();
    const observer = new ResizeObserver(place);
    if (layer.current) observer.observe(layer.current);
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      observer.disconnect();
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open, align, anchorRef]);
  if (!open) return null;
  return createPortal(
    <div
      ref={layer}
      role={role}
      aria-label={label}
      className={`acc-layer ${className}`}
      style={at ? { top: at.top, left: at.left, maxHeight: at.maxHeight } : { top: -9999, left: -9999 }}
    >
      {children}
    </div>,
    document.body,
  );
}
