import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FocusEvent, type MouseEvent, type ReactNode } from "react";
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

// 什么时候出：鼠标第一次指上去等 0.4 秒（划过去不算想看）；刚看完一个、0.3 秒内接着指下一个
// 不再等（顺着一排图标看过去时不该每颗都卡一下）；键盘走到的那一刻就出，鼠标点进去的焦点
// 不出（点了就是知道它是什么）。按下去就收。这几条全应用一份，所以记在模块上而不是每颗各记。
const FIRST_DELAY = 400;
const WARM_WINDOW = 300;
let warmUntil = 0;
let showing = 0;

function measure(element: Element, placement: HoverTipPlacement): HoverTipAnchor {
  const rect = element.getBoundingClientRect();
  if (placement === "left") return { x: rect.left - 7, y: rect.top + rect.height / 2, placement };
  return {
    x: rect.left + rect.width / 2,
    y: placement === "above" ? rect.top - 6 : rect.bottom + 6,
    placement,
  };
}

function focusVisible(element: Element): boolean {
  try {
    return element.matches(":focus-visible");
  } catch {
    return true;
  }
}

export function useHoverTip(options?: { placement?: HoverTipPlacement }) {
  const placement = options?.placement ?? "below";
  const [at, setAt] = useState<HoverTipAnchor | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const shown = useRef(false);

  const open = useCallback((element: Element) => {
    setAt(measure(element, placement));
    if (!shown.current) {
      shown.current = true;
      showing += 1;
    }
  }, [placement]);
  const hide = useCallback(() => {
    window.clearTimeout(timer.current);
    if (shown.current) {
      shown.current = false;
      showing = Math.max(0, showing - 1);
      warmUntil = performance.now() + WARM_WINDOW;
    }
    setAt(null);
  }, []);
  const enter = useCallback((event: MouseEvent<Element>) => {
    const element = event.currentTarget;
    window.clearTimeout(timer.current);
    if (showing > 0 || performance.now() < warmUntil) {
      open(element);
      return;
    }
    timer.current = window.setTimeout(() => {
      if (element.isConnected) open(element);
    }, FIRST_DELAY);
  }, [open]);
  const focus = useCallback((event: FocusEvent<Element>) => {
    if (focusVisible(event.currentTarget)) open(event.currentTarget);
  }, [open]);

  useEffect(() => () => {
    window.clearTimeout(timer.current);
    if (shown.current) showing = Math.max(0, showing - 1);
  }, []);

  return {
    at,
    hide,
    /** 摊到锚点元素上。键盘走到这颗按钮同样得看得到这句话。 */
    anchorProps: { onMouseEnter: enter, onMouseLeave: hide, onFocus: focus, onBlur: hide, onPointerDown: hide },
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
