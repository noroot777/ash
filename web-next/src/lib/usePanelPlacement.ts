import { useLayoutEffect, useState, type CSSProperties, type RefObject } from "react";

/**
 * 「贴着触发器弹出的 fixed 浮层」放在哪。选执行器、选模型、选思考强度这几颗胶囊
 * 都要用，所以抽在这里一次算清楚。
 *
 * 为什么不用 CSS 的 absolute + `bottom: 100%`：这些触发器的祖先卡片是
 * `overflow: hidden` 的，贴着卡片内部弹会被裁掉半截。挂到 body 上就得自己算位置。
 *
 * 两条要点：
 * ① 翻转（下方装不下就朝上弹）必须用面板的**真实**高度。拿常量猜的话，猜大了会在
 *    触发器和面板之间留一条「猜多了多少」那么宽的空白 —— 看起来就是浮层飘到了半空；
 *    猜小了又会顶出屏幕。面板行数还随步骤变，所以挂 ResizeObserver 跟着重算。
 * ② 那一侧就那么点地方时给出 maxHeight，让面板自己缩、内部列表滚。
 */

export type PanelPlacement = { left: number; top: number; width: number; maxHeight: number };

export interface PanelPlacementOptions {
  /** 面板最小宽度；实际取它与触发器宽度的较大值。 */
  minWidth?: number;
  /** 面板与触发器之间的缝。 */
  gap?: number;
  /** 首帧还没量到真实高度时的临时值。 */
  fallbackHeight?: number;
  /** 再挤也要留出的高度。 */
  minHeight?: number;
  /** 传 false 就完全不算（内联渲染的那份浮层用）。 */
  enabled?: boolean;
}

export function usePanelPlacement(
  anchorRef: RefObject<HTMLElement | null> | undefined,
  panelRef: RefObject<HTMLElement | null>,
  options: PanelPlacementOptions = {},
): PanelPlacement | null {
  const {
    minWidth = 320,
    gap = 6,
    fallbackHeight = 320,
    minHeight = 180,
    enabled = true,
  } = options;
  const [place, setPlace] = useState<PanelPlacement | null>(null);

  useLayoutEffect(() => {
    if (!anchorRef || !enabled) return;
    const measure = () => {
      const rect = anchorRef.current?.getBoundingClientRect();
      if (!rect) return;
      const height = panelRef.current?.offsetHeight || fallbackHeight;
      const below = window.innerHeight - rect.bottom - gap;
      const above = rect.top - gap;
      const flip = below < height && above > below;
      const width = Math.max(rect.width, minWidth);
      setPlace({
        left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
        top: flip ? Math.max(8, rect.top - gap - height) : rect.bottom + gap,
        width,
        maxHeight: Math.max(minHeight, flip ? above : below),
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (panelRef.current) observer.observe(panelRef.current);
    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
    };
  }, [anchorRef, enabled, fallbackHeight, gap, minHeight, minWidth, panelRef]);

  return place;
}

/** 直接铺给 style 用；还没量出来时返回 undefined（首帧先让它自然渲染再定位）。 */
export function placementStyle(place: PanelPlacement | null): CSSProperties | undefined {
  return place
    ? { left: place.left, top: place.top, width: place.width, maxHeight: place.maxHeight }
    : undefined;
}
