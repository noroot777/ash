import { layerAbove } from "../components/selectPlacement.ts";

/**
 * 「挂在某颗按钮下面、右边缘对齐」的 fixed 浮层放在哪：执行器表行尾的「更多」菜单和
 * 它打开的参数浮层都用。下面放不下就翻到上面，用 bottom 贴住按钮上沿（矮浮层不悬空）。
 * 层高压过按钮所在的那一层（设置页本身没有，首启向导、对话框里有）。
 */
export type AnchoredPlace = { left: number; top?: number; bottom?: number; zIndex: number; up: boolean };

const GAP = 4;
const EDGE = 8;

export function anchoredBelowEnd(anchor: HTMLElement, box: HTMLElement): AnchoredPlace {
  const rect = anchor.getBoundingClientRect();
  const width = box.offsetWidth;
  const height = box.offsetHeight;
  const below = window.innerHeight - rect.bottom - GAP - EDGE;
  const up = below < height && rect.top - GAP - EDGE > below;
  const left = Math.max(EDGE, Math.min(rect.right - width, window.innerWidth - width - EDGE));
  return up
    ? { left, bottom: window.innerHeight - rect.top + GAP, zIndex: layerAbove(anchor), up }
    : { left, top: rect.bottom + GAP, zIndex: layerAbove(anchor), up };
}
