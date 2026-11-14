// ash 的标，和它动起来的样子。几何以这一份为准：前端的标（AshMark.tsx）、加载动画（AshLoader.tsx）、
// 标签页图标（vite/brand-favicon.ts）、docs/logo 下那几张 SVG（docs/logo/build.mjs）都从这里取。
// macOS 那边是 Swift 现画的，够不着这里，两处点阵是照着抄的：desktop/macos/scripts/make-icon.swift
// （app 图标）、desktop/macos/Sources/FirstRunView.swift（首启页的 BrandMark）。改标时一起改。
//
// 这个文件不许有 import，也只用擦得掉的类型语法：docs/logo/build.mjs 是拿 node 直接读它的。
//
// 图是 8×8 的一位图，(x, y) 从左上角数。左下角一整块 5×5，右上那个角正在散：缺了五格，
// 飞出去七块，最远那块是亮的。飞出去的比缺的多两块，多出来的两块（spare）是从没缺的格子里
// 冒出来的 —— 散开的东西本来就比原来占地方。

export const MARK_SIZE = 8;

/** 一行里连着的几格。并成一条再画，缩到格子不落在整像素上时中间不露缝。 */
export interface Run {
  x: number;
  y: number;
  w: number;
  accent: boolean;
}

type Cell = readonly [x: number, y: number];
type Dot = readonly [x: number, y: number, accent?: boolean];

interface Piece {
  /** 从块里的那一格（合上时待的地方）一格一格到飞得最远的那一格。 */
  path: readonly Cell[];
  /** 第几拍开始往回走，之后一拍一格。近的先动，亮的那块最后落位。 */
  leave: number;
  accent?: true;
  /** 回去的那一格本来就是实的：它到家就是被那一块吞掉。 */
  spare?: true;
}

const BLOCK = { x: 0, y: 3, size: 5 };

const PIECES: readonly Piece[] = [
  { path: [[1, 3], [2, 2]], leave: 3 },
  { path: [[4, 7], [5, 7], [6, 7]], leave: 3, spare: true },
  { path: [[2, 3], [3, 2], [4, 1]], leave: 4 },
  { path: [[4, 5], [5, 5], [6, 5]], leave: 4 },
  { path: [[4, 4], [5, 3], [6, 2]], leave: 5, spare: true },
  { path: [[3, 4], [5, 3]], leave: 6 },
  { path: [[4, 3], [5, 2], [6, 1], [7, 0]], leave: 6, accent: true },
];

/** 一拍多长。 */
export const LOADER_TICK_MS = 120;
// 一圈十四拍：散着停三拍 → 六拍里一块块收回去（第 8 拍合上）→ 合着停三拍 → 第 11 拍起一齐炸开，
// 三拍后回到散着的样子。收得慢、炸得快，循环的接缝正好落在静止的标上。
const TICKS = 14;
const BURST = 11;

function stepAt(piece: Piece, tick: number): number {
  const far = piece.path.length - 1;
  if (tick < piece.leave) return far;
  if (tick < BURST) return Math.max(0, far - (tick - piece.leave + 1));
  return Math.min(far, tick - BURST + 1);
}

function toRuns(cells: readonly Dot[]): Run[] {
  const sorted = cells
    .map(([x, y, accent]) => ({ x, y, w: 1, accent: accent === true }))
    .sort((a, b) => a.y - b.y || a.x - b.x);
  const runs: Run[] = [];
  for (const cell of sorted) {
    const last = runs[runs.length - 1];
    if (last && last.y === cell.y && last.accent === cell.accent && last.x + last.w === cell.x) last.w += 1;
    // 两块叠在同一格（spare 路过别人待着的地方）只画一次。
    else if (!(last && last.y === cell.y && last.x + last.w - 1 === cell.x)) runs.push(cell);
  }
  return runs;
}

function still(): Cell[] {
  const vacated = new Set(PIECES.filter((p) => !p.spare).map((p) => p.path[0]!.join()));
  const cells: Cell[] = [];
  for (let y = BLOCK.y; y < BLOCK.y + BLOCK.size; y += 1) {
    for (let x = BLOCK.x; x < BLOCK.x + BLOCK.size; x += 1) {
      if (!vacated.has(`${x},${y}`)) cells.push([x, y]);
    }
  }
  return cells;
}

function moving(tick: number): Dot[] {
  return PIECES.flatMap((piece): Dot[] => {
    const step = stepAt(piece, tick);
    if (step === 0 && piece.spare) return [];
    const [x, y] = piece.path[step]!;
    return [[x, y, piece.accent]];
  });
}

/** 动画里从头到尾不动的那些格。 */
export const LOADER_STILL: Run[] = toRuns(still());
/** 每一拍里会动的那几块各在哪。第 0 拍就是静止的标。 */
export const LOADER_FRAMES: Run[][] = Array.from({ length: TICKS }, (_, tick) => toRuns(moving(tick)));
/** 静止的标。 */
export const MARK: Run[] = toRuns([...still(), ...moving(0)]);

/** 标签页图标：标铺满整张 8×8，在 16px 和 32px 上每格正好是整像素。墨色跟着浏览器的深浅色换。 */
export function faviconSvg(): string {
  const rects = MARK.map((r) => `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="1"${r.accent ? ' class="a"' : ""}/>`).join("");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${MARK_SIZE} ${MARK_SIZE}" shape-rendering="crispEdges">` +
    `<style>rect{fill:#111113}.a{fill:#5e6ad2}@media (prefers-color-scheme:dark){rect{fill:#f1f0ec}.a{fill:#8b95ee}}</style>` +
    `${rects}</svg>`
  );
}
