// 审查内容不再堆在对象列表下方——审查任务一多，点完一条还得往下拖很久才看得到它的
// 轮次与截图。改成贴着侧边栏左边缘弹一屉：跟侧边栏一样高、差不多宽，列表留在原地不动，
// 点另一条直接换内容，Esc 或点外面关掉。
//
// 定位照 `workflow/Popover.tsx` 的路子：portal 到 body + fixed，只认锚点的屏幕坐标。
// 就地渲染会被 inspector 的滚动容器裁掉；而侧边栏宽度是能拖的，写死数值迟早错位，
// 所以宽高位置全从锚点量，拖动与窗口变化都跟着重量。
import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { X } from "@phosphor-icons/react";
import { useDismissable } from "../lib/useDismissable.ts";

const EDGE = 12;
const MIN_WIDTH = 280;

type Box = { right: number; top: number; height: number; width: number };

export function ReviewEvidenceDrawer({
  anchorRef,
  keepOpenRef,
  title,
  subtitle,
  onClose,
  children,
}: {
  /** 侧边栏里的任意元素；抽屉贴着它所在的 inspector 面板左边缘展开 */
  anchorRef: RefObject<HTMLElement | null>;
  /** 点它不算「点了外面」——审查对象列表就在这里，点另一条是换内容而不是关抽屉 */
  keepOpenRef?: RefObject<HTMLElement | null>;
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<Box | null>(null);
  useDismissable({ enabled: true, containerRef: box, onClose, restoreFocusRef: keepOpenRef });

  useLayoutEffect(() => {
    const panel = () => anchorRef.current?.closest(".inspector-host") ?? anchorRef.current;
    const place = () => {
      const host = panel();
      if (!host) return;
      const rect = host.getBoundingClientRect();
      // 侧边栏左边留给抽屉的空间就这么多；侧边栏被拖得很宽时抽屉跟着让步，不挤出屏幕。
      const room = Math.max(MIN_WIDTH, rect.left - EDGE);
      const next: Box = {
        right: Math.max(0, window.innerWidth - rect.left),
        top: rect.top,
        height: rect.height,
        width: Math.min(rect.width, room),
      };
      setAt((current) =>
        current
        && current.right === next.right
        && current.top === next.top
        && current.height === next.height
        && current.width === next.width
          ? current
          : next);
    };
    place();
    const host = panel();
    const observer = host ? new ResizeObserver(place) : null;
    if (host && observer) observer.observe(host);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [anchorRef]);

  return createPortal(
    <aside
      className="review-evidence-drawer"
      ref={box}
      role="dialog"
      aria-label={title}
      style={{
        right: at?.right ?? 0,
        top: at?.top ?? 0,
        height: at?.height,
        width: at?.width,
        // 量出位置之前先别画，免得从屏幕角上闪一下再跳过来
        visibility: at ? undefined : "hidden",
      }}
    >
      <header>
        <div><b>{title}</b>{subtitle && <small>{subtitle}</small>}</div>
        <button type="button" onClick={onClose} aria-label="关闭审查内容"><X size={13} />关闭</button>
      </header>
      <div className="review-evidence-drawer__scroll">{children}</div>
    </aside>,
    document.body,
  );
}
