import { useCallback, useLayoutEffect, useRef, useState, type FocusEvent, type MouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

// 应用内的悬停提示。原生 `title` 被约定禁掉（`web/CLAUDE.md`），而「一颗纯图标按钮，
// 指上去才说得清它干什么」这件事在好几处都要做，之前是各写各的一份 portal +
// getBoundingClientRect + 贴边夹取（任务来源角标、窄态筛选点）。抄第三遍之前收成一处。
//
// 位置从事件的 `currentTarget` 上量，不收 ref：锚点可能是 button、span、任何东西，收 ref
// 就得让每个调用点自己声明元素类型，而这里只需要一个矩形。
//
// `position:fixed` + portal 到 body：锚点常常待在 `overflow:auto` 的面板里（比如 SCM 那栏），
// 就地渲染会被裁掉，也会跟着面板一起滚。

/**
 * `below` 是默认：气泡挂在锚点正下方、水平居中。
 * `left` 给贴着窗口右缘的竖排图标条用——那里正下方也还是窗口边缘，只有往左让才有地方站。
 */
export type HoverTipPlacement = "below" | "left" | "above";

export type HoverTipAnchor = { x: number; y: number; placement: HoverTipPlacement };

export function useHoverTip(options?: { placement?: HoverTipPlacement }) {
  const placement = options?.placement ?? "below";
  const [at, setAt] = useState<HoverTipAnchor | null>(null);
  const show = useCallback((event: MouseEvent<Element> | FocusEvent<Element>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (placement === "left") {
      setAt({ x: rect.left - 7, y: rect.top + rect.height / 2, placement });
      return;
    }
    setAt({
      x: rect.left + rect.width / 2,
      y: placement === "above" ? rect.top - 6 : rect.bottom + 6,
      placement,
    });
  }, [placement]);
  const hide = useCallback(() => setAt(null), []);
  return {
    at,
    hide,
    /** 摊到锚点元素上。焦点也算「指上去」——键盘走到这颗按钮同样得看得到这句话。 */
    anchorProps: { onMouseEnter: show, onMouseLeave: hide, onFocus: show, onBlur: hide },
  };
}

function PositionedHoverTip({ at, children }: { at: HoverTipAnchor; children: ReactNode }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [left, setLeft] = useState(at.x);
  useLayoutEffect(() => {
    if (at.placement === "left") { setLeft(at.x); return; }
    const halfWidth = (ref.current?.getBoundingClientRect().width ?? 0) / 2;
    setLeft(Math.max(halfWidth + 8, Math.min(at.x, window.innerWidth - halfWidth - 8)));
  }, [at, children]);
  return (
    <span
      ref={ref}
      className={`ui-hover-tip${at.placement === "below" ? "" : ` is-${at.placement}`}`}
      role="tooltip"
      style={{ left, top: at.y }}
    >
      {children}
    </span>
  );
}

export function HoverTip({ at, children }: { at: HoverTipAnchor | null; children: ReactNode }) {
  return at ? createPortal(<PositionedHoverTip at={at}>{children}</PositionedHoverTip>, document.body) : null;
}
