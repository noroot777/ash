// 输入导航条的几何，全是纯函数：间距、放大、按指针找格、「读到哪一条了」。
// 跟 DOM 分开放，是为了这些数能脱离浏览器钉住（scripts/test-conversation-inputs.ts）。

/** 相邻两格的间距上限。格子少时就按这个排，一簇居中；多到排不下才压密。 */
export const RAIL_PITCH_MAX = 8;
/**
 * 横线平时多长、指针正对着时多长。正读着的那一格另外再长 TICK_ACTIVE_EXTRA：
 * 三者加上横线的起点（离左边 8px）正好是刻度带的宽度（30px），鼓到最大也不会被它裁平。
 */
export const TICK_WIDTH = 8;
export const TICK_WIDTH_PEAK = 18;
export const TICK_ACTIVE_EXTRA = 4;
/**
 * 放大波及的范围（高斯的 σ，像素）。按像素而不是按「隔几格」算：格子压密之后，
 * 同样几格只占几个像素，按格数算会让放大缩成一根针。
 */
const MAGNIFY_SIGMA = 14;

/**
 * 多到排不下就一直压，压成一整条也要整条留在会话区里：伸出去的那截会盖住下面的回复框，
 * 而且那几条输入从导航条上就再也够不着了。压得再密，按指针找格、放大照样按像素算得出来。
 */
export function railPitch(count: number, available: number): number {
  if (count < 2) return RAIL_PITCH_MAX;
  return Math.max(0, Math.min(RAIL_PITCH_MAX, available / (count - 1)));
}

/** 指针离第一格多远（y，可以是负的或超出末格）→ 离它最近的那一格。 */
export function nearestTick(y: number, count: number, pitch: number): number {
  if (count < 1) return -1;
  if (pitch <= 0) return 0;
  return Math.max(0, Math.min(count - 1, Math.round(y / pitch)));
}

/**
 * 这一格此刻多长：离指针越近越长，像程序坞那样一路平滑地鼓起来，不是只有正对着的
 * 那一格变长。指针不在导航条上时一律是平时的长度。
 */
export function tickWidth(tickY: number, pointerY: number | null): number {
  if (pointerY === null) return TICK_WIDTH;
  const distance = tickY - pointerY;
  return TICK_WIDTH + (TICK_WIDTH_PEAK - TICK_WIDTH) * Math.exp(-(distance * distance) / (2 * MAGNIFY_SIGMA * MAGNIFY_SIGMA));
}

/**
 * 读到哪一条了：气泡顶边已经越过阅读线（视口上三分之一处）的最后一条。
 *
 * `tops[i]` 是第 i 条相对滚动区可视顶边的位置，找不到那颗气泡的是 null（不参与）。
 * 原始需求的位置是会话顶端，恒在阅读线之上，所以至少落在第 0 条。
 *
 * 贴着底的时候另算：最后几条追问往往短到永远够不着阅读线，人已经翻到最底下了，导航条
 * 却还标在更早那条上。那时视口里露出来的最后一条就是正在读的。
 */
export function activeInput(tops: readonly (number | null)[], viewHeight: number, atBottom: boolean): number {
  const line = viewHeight / 3;
  let active = 0;
  tops.forEach((top, index) => {
    if (top === null) return;
    if (top <= line || (atBottom && top < viewHeight)) active = index;
  });
  return active;
}
