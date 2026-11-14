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
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);
  useDismissable({ enabled: open, containerRef: layer, onClose, restoreFocusRef: anchorRef });
  // 开着就一直量：下面放不下、上面放得下就翻到上面；左右夹在视口里（窄屏、侧栏里的那几处）。
  useLayoutEffect(() => {
    if (!open) { setAt(null); return; }
    const place = () => {
      const anchor = anchorRef.current?.getBoundingClientRect();
      const panel = layer.current;
      if (!anchor || !panel) return;
      const width = panel.offsetWidth;
      const height = panel.offsetHeight;
      const room = window.innerHeight - anchor.bottom - 6;
      const top = room < height && anchor.top - 6 >= height ? anchor.top - 6 - height : anchor.bottom + 6;
      const wanted = align === "end" ? anchor.right - width : anchor.left;
      const left = Math.max(8, Math.min(wanted, window.innerWidth - width - 8));
      setAt((prev) => prev && prev.top === top && prev.left === left ? prev : { top, left });
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
      style={at ? { top: at.top, left: at.left } : { top: -9999, left: -9999 }}
    >
      {children}
    </div>,
    document.body,
  );
}
