// ash 的标，和它动起来的样子。几何以这一份为准：前端的标（AshMark.tsx）、加载动画（AshLoader.tsx）、
// 标签页图标（vite/brand-favicon.ts）、docs/logo 下那几张 SVG（docs/logo/build.mjs）都从这里取。
// macOS 那边是 Swift 现画的，够不着这里，两处点阵是照着抄的：desktop/macos/scripts/make-icon.swift
// （app 图标）、desktop/macos/Sources/FirstRunView.swift（首启页的 BrandMark）。改标时一起改。
//
// 这个文件不许有 import，也只用擦得掉的类型语法：docs/logo/build.mjs 是拿 node 直接读它的。
//
// 图是 8×8 的一位图，(x, y) 从左上角数：左下角一整块，右上那个角正在散，最远那块是亮的。
// 动起来是一道火从左下角烧到右上角：烧到哪条斜线，那条线上的格子亮一下、淡下去、再回来，
// 火走到头就是一直亮着的那一格。

export const MARK_SIZE = 8;

// # 墨；@ 亮的那一格。
const GRID = [
  ".......@",
  "....#...",
  "..#...#.",
  "#..#.#..",
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

/** 火同时烧到的一排格子：一条从左上到右下的斜线。step 是火从左下角出发第几拍烧到它。 */
export interface BurnLine {
  step: number;
  cells: { x: number; y: number }[];
}

const CELLS = GRID.flatMap((row, y) => [...row].flatMap((ch, x) => (ch === "." ? [] : [{ x, y, accent: ch === "@" }])));

/** 静止的标。 */
export const MARK: Run[] = CELLS.reduce<Run[]>((runs, { x, y, accent }) => {
  const last = runs[runs.length - 1];
  if (last && last.y === y && last.accent === accent && last.x + last.w === x) last.w += 1;
  else runs.push({ x, y, w: 1, accent });
  return runs;
}, []);

/** 墨色的格子按斜线分组，离左下角近的在前。 */
export const LOADER_LINES: BurnLine[] = CELLS.filter((cell) => !cell.accent)
  .reduce<BurnLine[]>((lines, { x, y }) => {
    const step = x + (MARK_SIZE - 1 - y);
    const line = lines.find((l) => l.step === step);
    if (line) line.cells.push({ x, y });
    else lines.push({ step, cells: [{ x, y }] });
    return lines;
  }, [])
  .sort((a, b) => a.step - b.step);

/** 一直亮着的那一格：火的终点，它自己不参加动画。 */
export const LOADER_TIP = CELLS.find((cell) => cell.accent)!;

/** 标签页图标：标铺满整张 8×8，在 16px 和 32px 上每格正好是整像素。墨色跟着浏览器的深浅色换。 */
export function faviconSvg(): string {
  const rects = MARK.map((r) => `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="1"${r.accent ? ' class="a"' : ""}/>`).join("");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${MARK_SIZE} ${MARK_SIZE}" shape-rendering="crispEdges">` +
    `<style>rect{fill:#111113}.a{fill:#5e6ad2}@media (prefers-color-scheme:dark){rect{fill:#f1f0ec}.a{fill:#8b95ee}}</style>` +
    `${rects}</svg>`
  );
}
