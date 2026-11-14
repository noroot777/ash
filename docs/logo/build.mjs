// 把标画成文件：跑 `node docs/logo/build.mjs` 重画同目录下的全部 SVG（node 22.18 之前要加
// --experimental-strip-types）。几何不在这里 —— 点阵和火烧过去的次序都在 web/src/brand/ashMark.ts，
// 前端的加载动画和标签页图标用的是同一份；这里只管排版、配色和 lockup 里那三个字母。
//
//   icon.svg          自带底色的应用图标
//   mark.svg          透明底的标，墨色跟着页面深浅色换
//   favicon.svg       标签页图标：标铺满整张图，不留边（前端那份是构建时内联进页面的，这张只是摆出来看）
//   lockup.svg        标 + ash，同上
//   lockup-light.svg  定死浅色页配色的 lockup（README 用：GitHub 按自己的主题挑图，不看系统深浅色）
//   lockup-dark.svg   定死深色页配色的 lockup
//   loader.svg        动起来的标（一道火从左下烧到右上），循环播放
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LOADER_LINES, LOADER_TIP, MARK, MARK_SIZE, faviconSvg } from "../../web/src/brand/ashMark.ts";

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

// 动画：和前端是同一份样式 —— 把 web/src/styles/ash-loader.css 原样嵌进来，元素结构照 AshLoader.tsx 摆。
// 那份样式认的是 currentColor 和 --accent，这里把它们接到本文件的两个色上。
function loader() {
  const css = readFileSync(join(here, "../../web/src/styles/ash-loader.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ").trim();
  const lines = LOADER_LINES.map(
    (line) =>
      `<g class="ash-loader__line" style="--step:${line.step}">` +
      line.cells.map((c) => `<rect x="${c.x}" y="${c.y}" width="1" height="1"/>`).join("") +
      `</g>`,
  ).join("");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" class="ash-loader" viewBox="0 0 ${MARK_SIZE} ${MARK_SIZE}" width="256" height="256" shape-rendering="crispEdges">\n` +
    `${adaptive}<style>svg{color:var(--ink);--accent:var(--live)}${css}</style>${lines}` +
    `<rect class="ash-loader__tip" x="${LOADER_TIP.x}" y="${LOADER_TIP.y}" width="1" height="1"/>\n</svg>\n`
  );
}

const files = {
  "icon.svg": svg(512, 512, `<rect width="512" height="512" rx="115.2" style="fill:#eceae4;shape-rendering:geometricPrecision"/>` + dots(MARK, 96, 96, 40, LIGHT.ink, LIGHT.live)),
  "mark.svg": svg(512, 512, adaptive + dots(MARK, 32, 32, 56)),
  "favicon.svg": `${faviconSvg()}\n`,
  "lockup.svg": lockup(adaptive),
  "lockup-light.svg": lockup(fixed(LIGHT)),
  "lockup-dark.svg": lockup(fixed(DARK)),
  "loader.svg": loader(),
};
for (const [name, text] of Object.entries(files)) writeFileSync(join(here, name), text);
