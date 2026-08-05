// 线路图上所有的微菜单都从这儿出。
//
// **必须挂到 body 上**：就地渲染的话，弹层是「干完之后」那张卡片的后代，卡片的圆角
// + overflow 会把它齐刷刷裁掉一半（截图为证：起手式菜单只露出前两行）。这类事没法靠
// 「把 overflow 改成 visible」根治 —— 沿途任何一个祖先加上滚动或裁剪都会复发，而卡片
// 本来就该裁自己的内容。所以定位交给 portal + fixed，弹层只认锚点的屏幕坐标。
//
// 位置每帧不算，只在开的那一下量一次，之后跟着滚动/缩放重量：菜单开着时页面还能滚，
// 滚了就得跟上，不然它会飘在半空指着别的东西。
import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useDismissable } from "../lib/useDismissable.ts";

const EDGE = 12;
const GAP = 6;

export function Popover({
  anchorRef, label, onClose, onBack, align = "center", matchWidth = false, children,
}: {
  anchorRef: RefObject<HTMLElement | null>;
  /** 菜单顶上那行小字，同时是给读屏用的名字 */
  label: string;
  onClose: () => void;
  /** 给了就在标题左边长出「‹ 返回」——从站点菜单钻进某个参数时用 */
  onBack?: () => void;
  /** center = 以锚点中心对齐（站台上的小按钮）；start = 左边缘对齐（整宽的下拉框） */
  align?: "center" | "start";
  /** 下拉框那种：菜单至少和触发它的框一样宽，才像个真下拉 */
  matchWidth?: boolean;
  children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ left: number; top: number; width: number } | null>(null);
  useDismissable({ enabled: true, containerRef: box, onClose, restoreFocusRef: anchorRef });

  useLayoutEffect(() => {
    const place = () => {
      const anchor = anchorRef.current;
      const pop = box.current;
      if (!anchor || !pop) return;
      const r = anchor.getBoundingClientRect();
      const w = pop.offsetWidth;
      const h = pop.offsetHeight;
      const raw = align === "start" ? r.left : r.left + r.width / 2 - w / 2;
      const left = Math.max(EDGE, Math.min(raw, window.innerWidth - w - EDGE));
      // 下面放不下就翻到锚点上方；上面也放不下就贴着视口顶
      const below = r.bottom + GAP;
      const top = below + h > window.innerHeight - EDGE ? Math.max(EDGE, r.top - GAP - h) : below;
      setAt((current) =>
        current && current.left === left && current.top === top && current.width === r.width
          ? current
          : { left, top, width: r.width });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [anchorRef, align, children]);

  return createPortal(
    <div
      className="wf-pop"
      ref={box}
      role="dialog"
      aria-label={label}
      style={{
        left: at?.left ?? 0,
        top: at?.top ?? 0,
        minWidth: matchWidth && at ? at.width : undefined,
        // 量出位置之前先别画，免得从左上角闪一下再跳过来
        visibility: at ? undefined : "hidden",
      }}
    >
      <div className="wf-pop-title">
        {onBack && (
          <button type="button" className="wf-pop-back" onClick={onBack}>‹ 返回</button>
        )}
        {label}
      </div>
      {children}
    </div>,
    document.body,
  );
}
