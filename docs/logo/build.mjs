// 把标画成文件：跑 `node docs/logo/build.mjs` 重画同目录下的全部 SVG 和手机端的图标。
// 几何和配色不在这里 —— 都在 web/src/brand/naviMark.ts，前端的标、加载动画和标签页图标用的是同一份；
// 这里只管排版。手机端的位图要在 macOS 上出（交给 rasterize.swift，SVG 由 AppKit 解析），别的系统上跳过。
//
//   icon.svg          自带底色的应用图标（mac 的应用图标就是把它栅格化的：desktop/macos/scripts/make-icon.swift）
//   mark.svg          透明底的标，颜色跟着系统深浅色换
//   favicon.svg       标签页图标（前端那份是构建时内联进页面的，这张只是摆出来看）
//   lockup.svg        字标 navi，同上跟着深浅色换
//   lockup-light.svg  定死浅色页配色的字标（README 用：GitHub 按自己的主题挑图，不看系统深浅色）
//   lockup-dark.svg   定死深色页配色的字标
//   loader.svg        加载动画「找北」，循环播放
//
//   mobile/assets/images/*.png    应用图标、安卓自适应图标三层、网页图标、启动图
//   mobile/assets/expo.icon/      iOS 的 Icon Composer 图标：一层标，底色是 icon.json 里的纯色
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  COLORS,
  TILE_MARK,
  TILE_RADIUS,
  VIEW,
  WORDMARK,
  adaptivePaint,
  adaptiveStyle,
  faviconSvg,
  fixedPaint,
  markBody,
  wordBody,
} from "../../web/src/brand/naviMark.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../..");
const n = (v) => +v.toFixed(2);

const svg = (viewBox, w, h, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" width="${n(w)}" height="${n(h)}">\n${body}\n</svg>\n`;

/** 标放进 size 见方的画布，占 share 那么宽，居中。 */
const placed = (size, share, body) => {
  const k = (size * share) / VIEW;
  return `<g transform="translate(${n((size - size * share) / 2)} ${n((size - size * share) / 2)}) scale(${n(k)})">${body}</g>`;
};

/** 应用图标那一块：米白底上的标。rounded=false 出直角的满底（iOS / 安卓自己会切圆角）。 */
const tile = (size, rounded = true) =>
  svg(
    `0 0 ${size} ${size}`,
    size,
    size,
    `<rect width="${size}" height="${size}"${rounded ? ` rx="${n(size * TILE_RADIUS)}"` : ""} fill="${COLORS.tile}"/>` +
      placed(size, TILE_MARK, markBody(fixedPaint(COLORS.light))),
  );

const lockup = (style, paint) =>
  svg(WORDMARK.viewBox, WORDMARK.width * 3, VIEW * 3, style + markBody(paint) + wordBody(paint));

// 动画：和前端是同一份样式 —— 把 web/src/styles/navi-brand.css 原样嵌进来，元素结构照 NaviMark.tsx 摆。
// 那份样式认的是 currentColor 和 --navi-north，这里把它们接到本文件跟着深浅色换的两个色上
// （样式里的 :root 在独立的 SVG 里就是 <svg> 本身，所以这里要用更具体的选择器压过它）。
function loader() {
  const css = readFileSync(join(root, "web/src/styles/navi-brand.css"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\s+/g, " ")
    .trim();
  const body = markBody((role) => (role === "north" ? `class="navi-mark__north"` : ""), "navi-mark__needle");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" class="navi-mark navi-loader" viewBox="0 0 ${VIEW} ${VIEW}" width="256" height="256">\n` +
    `${adaptiveStyle()}<style>${css} svg.navi-loader{color:var(--ink);--navi-north:var(--north)}</style>${body}\n</svg>\n`
  );
}

const docs = {
  "icon.svg": tile(512),
  "mark.svg": svg(`0 0 ${VIEW} ${VIEW}`, 512, 512, adaptiveStyle() + markBody(adaptivePaint)),
  "favicon.svg": `${faviconSvg()}\n`,
  "lockup.svg": lockup(adaptiveStyle(), adaptivePaint),
  "lockup-light.svg": lockup("", fixedPaint(COLORS.light)),
  "lockup-dark.svg": lockup("", fixedPaint(COLORS.dark)),
  "loader.svg": loader(),
};
for (const [name, text] of Object.entries(docs)) writeFileSync(join(here, name), text);

// ── 手机端 ────────────────────────────────────────────────────────────────────
const mobile = join(root, "mobile/assets");
const light = markBody(fixedPaint(COLORS.light));
const mono = markBody(fixedPaint({ ink: "#000000", north: "#000000" }));
const square = (size, body) => svg(`0 0 ${size} ${size}`, size, size, body);

// 安卓自适应图标：108dp 的画布只露出中间 72dp，标占露出来那块的六成，和 iOS 的图标一个比例。
const ADAPTIVE_MARK = (72 / 108) * TILE_MARK;
const bitmaps = [
  ["images/icon.png", 1024, tile(1024, false)],
  ["images/android-icon-background.png", 512, square(512, `<rect width="512" height="512" fill="${COLORS.tile}"/>`)],
  ["images/android-icon-foreground.png", 512, square(512, placed(512, ADAPTIVE_MARK, light))],
  ["images/android-icon-monochrome.png", 432, square(432, placed(432, ADAPTIVE_MARK, mono))],
  // 网页图标是位图，跟不了深浅色，所以带着底。
  ["images/favicon.png", 48, tile(48)],
  // 启动图铺在 app.json 里那块米白上，app.json 按 76pt 宽摆它。
  ["images/splash-icon.png", 228, square(228, placed(228, 1, light))],
];

// iOS：Icon Composer 的图层是按点数原样摆在 1024 的画布正中的，标的边长就是画布的六成。
const composer = join(mobile, "expo.icon");
for (const name of readdirSync(join(composer, "Assets"))) rmSync(join(composer, "Assets", name));
writeFileSync(join(composer, "Assets/navi-mark.svg"), svg(`0 0 ${VIEW} ${VIEW}`, 1024 * TILE_MARK, 1024 * TILE_MARK, light));
const channel = (hex, at) => (parseInt(hex.slice(at, at + 2), 16) / 255).toFixed(5);
const tileColor = `extended-srgb:${channel(COLORS.tile, 1)},${channel(COLORS.tile, 3)},${channel(COLORS.tile, 5)},1.00000`;
writeFileSync(
  join(composer, "icon.json"),
  `${JSON.stringify(
    {
      fill: { solid: tileColor },
      groups: [{ layers: [{ "image-name": "navi-mark.svg", name: "navi-mark" }], shadow: { kind: "neutral", opacity: 0.5 } }],
      "supported-platforms": { circles: ["watchOS"], squares: "shared" },
    },
    null,
    2,
  )}\n`,
);

if (process.platform !== "darwin") {
  console.warn("不是 macOS：手机端的位图没有重画（SVG 交给 AppKit 解析，别处没有）。");
} else {
  const scratch = mkdtempSync(join(tmpdir(), "navi-logo-"));
  try {
    const jobs = bitmaps.flatMap(([out, px, text], i) => {
      const source = join(scratch, `${i}.svg`);
      writeFileSync(source, text);
      return [source, join(mobile, out), String(px)];
    });
    execFileSync("swift", [join(here, "rasterize.swift"), ...jobs], { stdio: "inherit" });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
