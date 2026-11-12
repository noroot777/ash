/**
 * Select 浮层放在哪：贴着触发器、下方装不下就朝上翻。单独拆出来只是为了让 Select.tsx
 * 只管交互。
 *
 * 往上翻时用 `bottom` 贴住触发器上沿，而不是拿 `rect.top - maxHeight` 反推 `top`：实际
 * 高度不足 maxHeight 的矮浮层那样会悬在触发器上方一大截。
 */
export type SelectPlacement = { left: number; top?: number; bottom?: number; width: number; maxHeight: number; zIndex: number };

const GAP = 4;
const MIN_PANEL = 160;
/** 浮层至少这么宽：紧凑档的触发器只有一格表格那么窄，候选名字要放得下。 */
const MIN_WIDTH = 200;

/**
 * 浮层 portal 到 body 后脱离了触发器所在的堆叠上下文：触发器长在对话框、弹层里时，
 * 浮层得压过那一层，否则坐标对了、画面却被遮罩盖住。
 */
function layerAbove(anchor: HTMLElement): number {
  let zIndex = 60;
  for (let element: HTMLElement | null = anchor; element; element = element.parentElement) {
    const own = Number.parseInt(window.getComputedStyle(element).zIndex, 10);
    if (Number.isFinite(own)) zIndex = Math.max(zIndex, own + 1);
  }
  return zIndex;
}

export function selectPanelPlacement(anchor: HTMLElement, { reserve = 0 }: { reserve?: number } = {}): SelectPlacement {
  const rect = anchor.getBoundingClientRect();
  const below = window.innerHeight - rect.bottom - 10;
  const above = rect.top - 10;
  const flip = below < MIN_PANEL + reserve && above > below;
  const maxHeight = Math.max(MIN_PANEL, Math.min(320, flip ? above : below));
  const width = Math.max(rect.width, MIN_WIDTH);
  return {
    // 夹取要按浮层自己的宽度算：浮层有下限，比触发器宽时按触发器宽度夹取会让右边溢出视口。
    left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
    ...(flip ? { bottom: Math.max(8, window.innerHeight - rect.top + GAP) } : { top: rect.bottom + GAP }),
    width,
    maxHeight,
    zIndex: layerAbove(anchor),
  };
}
