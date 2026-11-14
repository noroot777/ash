// 把标画成文件：跑 `node docs/logo/build.mjs` 重画同目录下的全部 SVG（node 22.18 之前要加
// --experimental-strip-types）。几何不在这里 —— 点阵和尾巴怎么摆都在 web/src/brand/ashMark.ts，
// 前端的加载动画和标签页图标用的是同一份；这里只管排版、配色和 lockup 里那三个字母。
//
//   icon.svg          自带底色的应用图标
//   mark.svg          透明底的标，墨色跟着页面深浅色换
//   favicon.svg       标签页图标：标铺满整张图，不留边（前端那份是构建时内联进页面的，这张只是摆出来看）
//   lockup.svg        标 + ash，同上
//   lockup-light.svg  定死浅色页配色的 lockup（README 用：GitHub 按自己的主题挑图，不看系统深浅色）
//   lockup-dark.svg   定死深色页配色的 lockup
//   loader.svg        动起来的标（甩尾巴），循环播放
//   frames.svg        一个来回切成八张定格
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LOADER_STILL, LOADER_SWING_MS, LOADER_TAIL, MARK, MARK_SIZE, faviconSvg } from "../../web/src/brand/ashMark.ts";

const here = dirname(fileURLToPath(import.meta.url));
const n = (v) => +v.toFixed(2);

const LIGHT = { ink: "#111113", live: "#5e6ad2" };
const DARK = { ink: "#f1f0ec", live: "#8b95ee" };
const vars = (tone) => Object.entries(tone).map(([k, v]) => `--${k}:${v}`).join(";");
const fixed = (tone) => `<style>svg{${vars(tone)}}</style>`;
const adaptive = `<style>svg{${vars(LIGHT)}}@media (prefers-color-scheme:dark){svg{${vars(DARK)}}}</style>`;

const svg = (w, h, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n(w)} ${n(h)}" width="${n(w)}" height="${n(h)}" shape-rendering="crispEdges">\n${body}\n</svg>\n`;

// 颜色一律写在 style 里：属性里的 var() 不是每个渲染器都认。
const dots = (runs, x, y, cell, ink = "var(--ink)", live = "var(--live)") =>
  runs
    .map((r) => `<rect x="${n(x + r.x * cell)}" y="${n(y + r.y * cell)}" width="${n(r.w * cell)}" height="${n(cell)}" style="fill:${r.accent ? live : ink}"/>`)
    .join("");

// lockup 里的字：和标同一种格子，x 高五格，h 的竖笔再高两格。
const GLYPHS = {
  a: [".###.", "....#", ".####", "#...#", ".####"],
  s: [".####", "#....", ".###.", "....#", "####."],
  h: ["#....", "#....", "####.", "#...#", "#...#", "#...#", "#...#"],
};
const glyphRuns = (rows) =>
  rows.flatMap((row, y) => [...row.matchAll(/#+/g)].map((m) => ({ x: m.index, y, w: m[0].length, accent: false })));

function lockup(style) {
  const cell = 22, left = 24, base = 216;
  let x = left + (MARK_SIZE + 3) * cell;
  let body = dots(MARK, left, base - MARK_SIZE * cell, cell);
  for (const ch of "ash") {
    body += dots(glyphRuns(GLYPHS[ch]), x, base - GLYPHS[ch].length * cell, cell);
    x += 6 * cell;
  }
  return svg(x - cell + left, 256, style + body);
}

// 动画：尾巴上的每一块在两头之间来回平移。和前端那份（web/src/styles/ash-loader.css）是同一种摆法。
// 尾巴尖会摆出 8×8，所以这张图四周各留一格：摆出来看时宽度取 10 的倍数，格子才落在整像素上。
const PAD = 1;
function loader() {
  const tail = LOADER_TAIL.map(
    (d) =>
      `<rect class="tail" x="${d.x}" y="${d.y}" width="1" height="1" style="fill:${d.accent ? "var(--live)" : "var(--ink)"};` +
      `--dx:${d.dx};--dy:${d.dy};animation-delay:${d.lagMs - LOADER_SWING_MS / 2}ms"/>`,
  ).join("");
  const motion =
    `<style>.tail{animation:wag ${LOADER_SWING_MS}ms ease-in-out infinite alternate}` +
    `@keyframes wag{from{transform:translate(calc(var(--dx)*-1px),calc(var(--dy)*-1px))}` +
    `to{transform:translate(calc(var(--dx)*1px),calc(var(--dy)*1px))}}</style>`;
  const side = MARK_SIZE + PAD * 2;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-PAD} ${-PAD} ${side} ${side}" width="${side * 32}" height="${side * 32}" shape-rendering="crispEdges">\n` +
    `${adaptive}${motion}${dots(LOADER_STILL, 0, 0, 1)}${tail}\n</svg>\n`
  );
}

// CSS 的 ease-in-out，即 cubic-bezier(.42, 0, .58, 1)：给进度 x 求 y。
function easeInOut(x) {
  const bez = (t, a, b) => 3 * (1 - t) * (1 - t) * t * a + 3 * (1 - t) * t * t * b + t * t * t;
  let lo = 0, hi = 1;
  for (let i = 0; i < 30; i += 1) {
    const mid = (lo + hi) / 2;
    if (bez(mid, 0.42, 0.58) < x) lo = mid;
    else hi = mid;
  }
  return bez((lo + hi) / 2, 0, 1);
}

// 一个来回切成八张定格摆开：看得出身子不动、尾巴尖比尾巴根晚到。
function frames() {
  const cell = 8, shots = 8, step = (MARK_SIZE + PAD * 2 + 1) * cell;
  let body = "";
  for (let shot = 0; shot < shots; shot += 1) {
    const at = (shot / shots) * LOADER_SWING_MS * 2;
    const x0 = shot * step + PAD * cell, y0 = PAD * cell;
    body += dots(LOADER_STILL, x0, y0, cell);
    for (const d of LOADER_TAIL) {
      const u = ((((at + LOADER_SWING_MS / 2 - d.lagMs) / LOADER_SWING_MS) % 2) + 2) % 2;
      const swing = 2 * easeInOut(u <= 1 ? u : 2 - u) - 1;
      // 定格里的尾巴不在整格上，按 crispEdges 画会被吸到最近的像素，位置就不准了。
      body += dots([{ x: d.x + d.dx * swing, y: d.y + d.dy * swing, w: 1, accent: d.accent }], x0, y0, cell)
        .replace('style="', 'style="shape-rendering:geometricPrecision;');
    }
  }
  return svg(shots * step - cell, (MARK_SIZE + PAD * 2) * cell, adaptive + body);
}

const files = {
  "icon.svg": svg(512, 512, `<rect width="512" height="512" rx="115.2" style="fill:#eceae4;shape-rendering:geometricPrecision"/>` + dots(MARK, 96, 96, 40, LIGHT.ink, LIGHT.live)),
  "mark.svg": svg(512, 512, adaptive + dots(MARK, 32, 32, 56)),
  "favicon.svg": `${faviconSvg()}\n`,
  "lockup.svg": lockup(adaptive),
  "lockup-light.svg": lockup(fixed(LIGHT)),
  "lockup-dark.svg": lockup(fixed(DARK)),
  "loader.svg": loader(),
  "frames.svg": frames(),
};
for (const [name, text] of Object.entries(files)) writeFileSync(join(here, name), text);
