// 三版 logo 的唯一出处：几何都写在这里，跑 `node docs/logo/build.mjs` 重画同目录下的全部 SVG。
// 每版出三份：icon（自带底，给 app 图标 / favicon）、mark（透明底，跟随深浅色）、lockup（标 + 字）。
// 图形都是抽象的，不带字母；字只出现在 lockup 里，也不引字体：ash 三个字母按各版的笔画现画，换台机器不会变样。
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const n = (v) => +v.toFixed(2);

// 下面画图时颜色一律按属性写（fill="var(--ink)"）；带 var() 的在这里统一挪进 style ——
// 属性里的 var() 不是每个渲染器都认，写在 style 里的才稳。
const inlineVars = (body) =>
  body.replace(/<[^>]+>/g, (tag) => {
    const css = [];
    const rest = tag.replace(/ (fill|stroke|stop-color)="(var\([^"]+\))"/g, (_, k, v) => (css.push(`${k}:${v}`), ""));
    return css.length ? rest.replace(/(\/?>)$/, ` style="${css.join(";")}"$1`) : tag;
  });

const svg = (w, h, body, extra = "") =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n(w)} ${n(h)}" width="${n(w)}" height="${n(h)}"${extra}>\n${inlineVars(body)}\n</svg>\n`;

// 透明底的那两份要在深浅两种页面上都站得住：颜色走 CSS 变量，深色时换一套。
const adaptive = (light, dark) => {
  const vars = (o) => Object.entries(o).map(([k, v]) => `--${k}:${v}`).join(";");
  return `<style>svg{${vars(light)}}@media (prefers-color-scheme:dark){svg{${vars(dark)}}}</style>`;
};

const squircle = (size, fill, r = 0.225) =>
  `<rect width="${size}" height="${size}" rx="${n(size * r)}" fill="${fill}"/>`;

// 等线宽的 a / s / h。x = 字母左缘（按笔画中线算），base = 基线，X = x 高，返回 [路径, 字宽]。
// ext：平头收笔时直笔两端各补出的长度（半个线宽），补了才和圆弧的外缘齐平；圆头收笔自带，传 0。
const letters = {
  a(x, base, X, ext = 0) {
    const r = X / 2;
    return [
      `M${n(x + X)} ${n(base - r)}a${n(r)} ${n(r)} 0 1 1 ${n(-X)} 0a${n(r)} ${n(r)} 0 1 1 ${n(X)} 0M${n(x + X)} ${n(base - X - ext)}V${n(base + ext)}`,
      X,
    ];
  },
  s(x, base, X, _ext = 0, open = 35) {
    const rx = X * 0.31, ry = X / 4, cx = x + rx;
    const dx = rx * Math.cos((open * Math.PI) / 180), dy = ry * Math.sin((open * Math.PI) / 180);
    return [
      `M${n(cx + dx)} ${n(base - 3 * ry - dy)}A${n(rx)} ${n(ry)} 0 1 0 ${n(cx)} ${n(base - 2 * ry)}A${n(rx)} ${n(ry)} 0 1 1 ${n(cx - dx)} ${n(base - ry + dy)}`,
      rx * 2,
    ];
  },
  h(x, base, X, ext = 0) {
    const w = X * 0.84, r = w / 2;
    return [
      `M${n(x)} ${n(base - X * 1.5 - ext)}V${n(base + ext)}M${n(x)} ${n(base - X + r)}a${n(r)} ${n(r)} 0 0 1 ${n(w)} 0V${n(base + ext)}`,
      w,
    ];
  },
};

// 排一行字：gap 是相邻字母笔画中线之间的空当。
function word(text, x, base, X, gap, ext = 0) {
  const paths = [];
  for (const ch of text) {
    const [d, w] = letters[ch](x, base, X, ext);
    paths.push(d);
    x += w + gap;
  }
  return { d: paths.join(""), right: x - gap };
}

// ── 一、分合 ────────────────────────────────────────────────────────────
// 一个整圆斜切成三路，各自错开往前走；合起来还是那个圆。
function forkMark(id, color, s = 1, ox = 0, oy = 0) {
  const r = 168, gap = 24, t = (2 * r - 2 * gap) / 3;
  const bands = [-36, 0, 36].map((slide, i) =>
    `<clipPath id="${id}${i}"><rect x="0" y="${n(256 - r + i * (t + gap))}" width="512" height="${n(t)}"/></clipPath>` +
    `<circle cx="256" cy="256" r="${r}" transform="translate(${slide} 0)" clip-path="url(#${id}${i})" fill="${color}"/>`);
  // 剪裁条跟着圆一起平移：每一路都是原来那个圆上切下来的一段，整段沿斜向推出去。
  return `<g transform="translate(${n(ox)} ${n(oy)}) scale(${s}) rotate(-45 256 256)">${bands.join("")}</g>`;
}

function fork() {
  const ink = adaptive({ ink: "#0b0b0c" }, { ink: "#f4f4f5" });
  const icon = svg(512, 512, squircle(512, "#000") + forkMark("i", "#fff", 0.84, 41, 41));
  const mark = svg(512, 512, ink + forkMark("m", "var(--ink)", 1.2, -51.2, -51.2));
  const text = word("ash", 270, 186, 108, 50);
  const lockup = svg(
    text.right + 40,
    256,
    ink + forkMark("l", "var(--ink)", 0.5, 0, 0) +
      `<path d="${text.d}" fill="none" stroke="var(--ink)" stroke-width="26" stroke-linecap="round" stroke-linejoin="round"/>`,
  );
  return { icon, mark, lockup };
}

// ── 二、余烬 ────────────────────────────────────────────────────────────
// 一颗还烧着的，身后拖着两弯已经凉下去的：干完的成了灰，正在干的那个亮着。
const DISCS = [
  { x: 138, y: 378, r: 62 },
  { x: 212, y: 306, r: 88 },
  { x: 322, y: 206, r: 116 },
];
const GAP = 16;

const emberDefs = (id, far, near) =>
  `<defs>` +
  `<linearGradient id="${id}bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2b2a2e"/><stop offset="1" stop-color="#0c0c0e"/></linearGradient>` +
  `<linearGradient id="${id}near" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="${near[0]}"/><stop offset="1" stop-color="${near[1]}"/></linearGradient>` +
  `<radialGradient id="${id}core" cx="0.42" cy="0.4" r="0.7"><stop offset="0" stop-color="#ffd27a"/><stop offset="0.45" stop-color="#ff8f2a"/><stop offset="0.85" stop-color="#ee4a1a"/><stop offset="1" stop-color="#c4260f"/></radialGradient>` +
  `<radialGradient id="${id}glow"><stop offset="0" stop-color="#ff7a1f" stop-opacity="0.5"/><stop offset="1" stop-color="#ff7a1f" stop-opacity="0"/></radialGradient>` +
  // 后一颗压着前一颗的地方留一道缝：用蒙版挖，透明底上也成立。
  [1, 2].map((i) =>
    `<mask id="${id}m${i}" maskUnits="userSpaceOnUse" x="0" y="0" width="512" height="512"><rect width="512" height="512" fill="#fff"/>` +
    `<circle cx="${DISCS[i].x}" cy="${DISCS[i].y}" r="${DISCS[i].r + GAP}" fill="#000"/></mask>`).join("") +
  `</defs>`;

function emberMark(id, far, glow, s = 1, ox = 0, oy = 0) {
  const [a, b, c] = DISCS;
  return (
    `<g transform="translate(${n(ox)} ${n(oy)}) scale(${s})">` +
    (glow ? `<circle cx="${c.x}" cy="${c.y}" r="${c.r * 1.9}" fill="url(#${id}glow)"/>` : "") +
    `<circle cx="${a.x}" cy="${a.y}" r="${a.r}" fill="${far}" mask="url(#${id}m1)"/>` +
    `<circle cx="${b.x}" cy="${b.y}" r="${b.r}" fill="url(#${id}near)" mask="url(#${id}m2)"/>` +
    `<circle cx="${c.x}" cy="${c.y}" r="${c.r}" fill="url(#${id}core)"/></g>`
  );
}

function ember() {
  const icon = svg(512, 512,
    emberDefs("i", "#4b484f", ["#8f8a84", "#e4e0da"]) + squircle(512, "url(#ibg)") + emberMark("i", "#4b484f", true, 1, 0, -9));
  // 透明底那两份不带光晕：光晕离了深色底就是一团脏橙色。两弯灰跟着页面深浅换：离火越远越接近底色。
  const tone = adaptive(
    { far: "#d3d0cb", near0: "#a5a19b", near1: "#7d7973", ink: "#111113" },
    { far: "#4b484f", near0: "#8f8a84", near1: "#e4e0da", ink: "#f4f1ec" },
  );
  const defs = (id) => emberDefs(id, "var(--far)", ["var(--near0)", "var(--near1)"]);
  const mark = svg(512, 512, tone + defs("m") + emberMark("m", "var(--far)", false, 1.2, -52.4, -62));
  const w = 36, X = 116;
  const base = 204, gap = 54, ax = 268, sx = ax + X + gap;
  const [ad] = letters.a(ax, base, X, w / 2);
  // 粗体的 s 两个收笔要竖着切才稳：弧多画一段，再用一块缺了右上、左下两角的剪裁区把多出来的切掉。
  const [sd, sw] = letters.s(sx, base, X, 0, 8);
  const cx = sx + sw / 2, cut = (sw / 2) * Math.cos((38 * Math.PI) / 180);
  const [hd, hw] = letters.h(sx + sw + gap, base, X, w / 2);
  const right = sx + sw + gap + hw + w / 2 + 28;
  const clip =
    `<clipPath id="lcut"><path d="M0 0H${n(cx + cut)}V${n(base - X * 0.75)}H${n(right)}V256H${n(cx - cut)}V${n(base - X * 0.25)}H0Z"/></clipPath>`;
  const lockup = svg(
    right,
    256,
    tone + defs("l") + clip + emberMark("l", "var(--far)", false, 0.52, -10, -10) +
      `<g fill="none" stroke="var(--ink)" stroke-width="${w}"><path d="${ad}${hd}"/><path d="${sd}" clip-path="url(#lcut)"/></g>`,
  );
  return { icon, mark, lockup };
}

// ── 三、像素 ────────────────────────────────────────────────────────────
// 一整块东西从一角开始散成点：烧过的会散，散出去的最远那一点还亮着。
const DUST = [
  ".......@",
  "....#...",
  "..#...#.",
  "#..#.#..",
  "###.#...",
  "####..#.",
  "#####...",
  "#####.#.",
];
const glyphs = {
  a: [".###.", "....#", ".####", "#...#", ".####"],
  s: [".####", "#....", ".###.", "....#", "####."],
  h: ["#....", "#....", "####.", "#...#", "#...#", "#...#", "#...#"],
};

// 把点阵按行合并成横条再输出：同一行相邻的点是一个矩形，缩小时不会露缝。
function bitmap(rows, x, bottom, cell, fill, accent) {
  const out = [];
  rows.forEach((row, i) => {
    const y = bottom - (rows.length - i) * cell;
    for (const m of row.matchAll(/#+|@+/g)) {
      out.push(`<rect x="${n(x + m.index * cell)}" y="${n(y)}" width="${n(m[0].length * cell)}" height="${n(cell)}" fill="${m[0][0] === "@" ? accent : fill}"/>`);
    }
  });
  return out.join("");
}

function pixel() {
  const tone = adaptive({ ink: "#111113", live: "#5e6ad2" }, { ink: "#f1f0ec", live: "#8b95ee" });
  const crisp = ' shape-rendering="crispEdges"';
  const icon = svg(512, 512, squircle(512, "#eceae4") + bitmap(DUST, 96, 416, 40, "#111113", "#5e6ad2"), crisp);
  const mark = svg(512, 512, tone + bitmap(DUST, 32, 480, 56, "var(--ink)", "var(--live)"), crisp);
  const c = 22;
  let x = 24 + 8 * c + 3 * c;
  let body = bitmap(DUST, 24, 216, c, "var(--ink)", "var(--live)");
  for (const ch of "ash") {
    body += bitmap(glyphs[ch], x, 216, c, "var(--ink)");
    x += 6 * c;
  }
  const lockup = svg(x - c + 24, 256, tone + body, crisp);
  return { icon, mark, lockup };
}

for (const [name, files] of Object.entries({ fork: fork(), ember: ember(), pixel: pixel() })) {
  mkdirSync(join(here, name), { recursive: true });
  for (const [kind, text] of Object.entries(files)) writeFileSync(join(here, name, `${kind}.svg`), text);
}
