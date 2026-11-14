// ash 的标，和它动起来的样子。几何以这一份为准：前端的标（AshMark.tsx）、加载动画（AshLoader.tsx）、
// 标签页图标（vite/brand-favicon.ts）、docs/logo 下那几张 SVG（docs/logo/build.mjs）都从这里取。
// macOS 那边是 Swift 现画的，够不着这里，两处点阵是照着抄的：desktop/macos/scripts/make-icon.swift
// （app 图标）、desktop/macos/Sources/FirstRunView.swift（首启页的 BrandMark）。改标时一起改。
//
// 这个文件不许有 import，也只用擦得掉的类型语法：docs/logo/build.mjs 是拿 node 直接读它的。
//
// 图是 8×8 的一位图，(x, y) 从左上角数：左下角一整块，右上那个角正在散，最远那块是亮的。
// 动起来是甩尾巴 —— 身子不动，往右上去的那一撮（t 和 @）绕着身子里的一点左右摆。

export const MARK_SIZE = 8;

// # 墨；t 也是墨，但属于尾巴；@ 亮的那一格，尾巴尖。
const GRID = [
  ".......@",
  "....t...",
  "..#...t.",
  "#..#.t..",
  "###.#...",
  "####..#.",
  "#####...",
  "#####.#.",
];

/** 一行里连着的几格。并成一条再画，缩到格子不落在整像素上时中间不露缝。 */
export interface Run {
  x: number;
  y: number;
  w: number;
  accent: boolean;
}

/** 尾巴上的一块：待在哪一格，往两边各摆出去多远（单位是格），比尾巴根晚多少毫秒动。 */
export interface TailDot {
  x: number;
  y: number;
  accent: boolean;
  dx: number;
  dy: number;
  lagMs: number;
}

function runs(pick: (ch: string) => boolean): Run[] {
  const out: Run[] = [];
  GRID.forEach((row, y) => {
    [...row].forEach((ch, x) => {
      if (!pick(ch)) return;
      const accent = ch === "@";
      const last = out[out.length - 1];
      if (last && last.y === y && last.accent === accent && last.x + last.w === x) last.w += 1;
      else out.push({ x, y, w: 1, accent });
    });
  });
  return out;
}

const isTail = (ch: string) => ch === "t" || ch === "@";

/** 静止的标。 */
export const MARK: Run[] = runs((ch) => ch !== ".");
/** 动画里不动的那部分：身子，和落在身子旁边的几粒。 */
export const LOADER_STILL: Run[] = runs((ch) => ch === "#");

/** 从一头摆到另一头多久；一个来回是它的两倍。 */
export const LOADER_SWING_MS = 420;
// 尾巴根在身子里面。每一块绕它转同一个角度，所以离得越远摆得越开；再让远的比近的晚一点动，
// 整条尾巴才是甩出去的，不是一块板子在转。尾巴尖摆到头时会探出 8×8 的格子将近一格。
const PIVOT = { x: 3, y: 5 };
const SWING_RAD = 0.21;
const LAG_MS_PER_CELL = 30;

const round = (v: number) => Math.round(v * 100) / 100;

const TAIL_CELLS = GRID.flatMap((row, y) =>
  [...row].flatMap((ch, x) => (isTail(ch) ? [{ x, y, accent: ch === "@", rx: x + 0.5 - PIVOT.x, ry: y + 0.5 - PIVOT.y }] : [])),
);
const NEAREST = Math.min(...TAIL_CELLS.map((c) => Math.hypot(c.rx, c.ry)));

/** 尾巴上的每一块。摆的时候只平移不旋转：方块得一直是正的。 */
export const LOADER_TAIL: TailDot[] = TAIL_CELLS.map(({ x, y, accent, rx, ry }) => ({
  x,
  y,
  accent,
  // 转一个小角度，位移就是垂直于半径的那一段。
  dx: round(-ry * SWING_RAD),
  dy: round(rx * SWING_RAD),
  lagMs: Math.round((Math.hypot(rx, ry) - NEAREST) * LAG_MS_PER_CELL),
}));

/** 标签页图标：标铺满整张 8×8，在 16px 和 32px 上每格正好是整像素。墨色跟着浏览器的深浅色换。 */
export function faviconSvg(): string {
  const rects = MARK.map((r) => `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="1"${r.accent ? ' class="a"' : ""}/>`).join("");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${MARK_SIZE} ${MARK_SIZE}" shape-rendering="crispEdges">` +
    `<style>rect{fill:#111113}.a{fill:#5e6ad2}@media (prefers-color-scheme:dark){rect{fill:#f1f0ec}.a{fill:#8b95ee}}</style>` +
    `${rects}</svg>`
  );
}
