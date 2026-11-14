// 三版 logo 的唯一出处：几何都写在这里，跑 `node docs/logo/build.mjs` 重画同目录下的全部 SVG。
// 每版出三份：icon（自带底，给 app 图标 / favicon）、mark（透明底，跟随深浅色）、lockup（标 + 字）。
// 字不引字体：ash 三个字母按与图形同一套笔画现画，换台机器不会变样。
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
const letters = {
  a(x, base, X) {
    const r = X / 2;
    return [
      `M${n(x + X)} ${n(base - r)}a${n(r)} ${n(r)} 0 1 1 ${n(-X)} 0a${n(r)} ${n(r)} 0 1 1 ${n(X)} 0M${n(x + X)} ${n(base - X)}V${n(base)}`,
      X,
    ];
  },
  s(x, base, X, open = 35) {
    const rx = X * 0.31, ry = X / 4, cx = x + rx;
    const dx = rx * Math.cos((open * Math.PI) / 180), dy = ry * Math.sin((open * Math.PI) / 180);
    return [
      `M${n(cx + dx)} ${n(base - 3 * ry - dy)}A${n(rx)} ${n(ry)} 0 1 0 ${n(cx)} ${n(base - 2 * ry)}A${n(rx)} ${n(ry)} 0 1 1 ${n(cx - dx)} ${n(base - ry + dy)}`,
      rx * 2,
    ];
  },
  h(x, base, X) {
    const w = X * 0.84, r = w / 2;
    return [
      `M${n(x)} ${n(base - X * 1.5)}V${n(base)}M${n(x)} ${n(base - X + r)}a${n(r)} ${n(r)} 0 0 1 ${n(w)} 0V${n(base)}`,
      w,
    ];
  },
};

// 排一行字：gap 是相邻字母笔画中线之间的空当。
function word(text, x, base, X, gap) {
  const paths = [];
  for (const ch of text) {
    const [d, w] = letters[ch](x, base, X);
    paths.push(d);
    x += w + gap;
  }
  return { d: paths.join(""), right: x - gap };
}

// ── 一、分合 ────────────────────────────────────────────────────────────
// 字母 A 就是一张调度图：顶点一个派活的口，两条腿是并行的两路，横杠是接力，落地各一个结点。
function forkMark(color, s = 1, ox = 0, oy = 0) {
  const P = (x, y) => `${n(ox + x * s)} ${n(oy + y * s)}`;
  const w = n(40 * s);
  return (
    `<g fill="none" stroke="${color}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round">` +
    `<path d="M${P(122, 404)}L${P(256, 108)}L${P(390, 404)}M${P(176, 300)}H${n(ox + 336 * s)}"/></g>` +
    `<g fill="${color}"><circle cx="${n(ox + 256 * s)}" cy="${n(oy + 108 * s)}" r="${n(46 * s)}"/>` +
    `<circle cx="${n(ox + 122 * s)}" cy="${n(oy + 404 * s)}" r="${n(46 * s)}"/>` +
    `<circle cx="${n(ox + 390 * s)}" cy="${n(oy + 404 * s)}" r="${n(46 * s)}"/></g>`
  );
}

function fork() {
  const ink = adaptive({ ink: "#0b0b0c" }, { ink: "#f4f4f5" });
  const icon = svg(512, 512, squircle(512, "#000") + forkMark("#fff", 0.74, 66.5, 66.5));
  const mark = svg(512, 512, ink + forkMark("var(--ink)"));
  // 字的线宽与标一致：标缩到 0.5，线宽 20。
  const text = word("ash", 298, 214, 104, 46);
  const lockup = svg(
    text.right + 34,
    256,
    ink + forkMark("var(--ink)", 0.5, 0, 0) +
      `<path d="${text.d}" fill="none" stroke="var(--ink)" stroke-width="20" stroke-linecap="round" stroke-linejoin="round"/>`,
  );
  return { icon, mark, lockup };
}

// ── 二、余烬 ────────────────────────────────────────────────────────────
// 灰里一点没灭的火：小写 a 的字碗是一圈灰，字腔里是烧着的芯。
const emberDefs = (id) =>
  `<defs>` +
  `<linearGradient id="${id}bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2b2a2e"/><stop offset="1" stop-color="#0c0c0e"/></linearGradient>` +
  `<linearGradient id="${id}ash" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fbf8f3"/><stop offset="1" stop-color="#a8a39c"/></linearGradient>` +
  `<radialGradient id="${id}core" cx="0.42" cy="0.38" r="0.7"><stop offset="0" stop-color="#ffe9a8"/><stop offset="0.38" stop-color="#ff9a2e"/><stop offset="0.8" stop-color="#f0481a"/><stop offset="1" stop-color="#b81f12"/></radialGradient>` +
  `<radialGradient id="${id}glow"><stop offset="0" stop-color="#ff7a1f" stop-opacity="0.55"/><stop offset="1" stop-color="#ff7a1f" stop-opacity="0"/></radialGradient>` +
  `</defs>`;

function emberMark(id, s = 1, ox = 0, oy = 0, glow = true) {
  const cx = ox + 232 * s, cy = oy + 270 * s, R = 96 * s, w = 60 * s;
  return (
    (glow ? `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(176 * s)}" fill="url(#${id}glow)"/>` : "") +
    `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(R - w / 2 - 12 * s)}" fill="url(#${id}core)"/>` +
    `<path d="M${n(cx + R)} ${n(cy)}a${n(R)} ${n(R)} 0 1 1 ${n(-2 * R)} 0a${n(R)} ${n(R)} 0 1 1 ${n(2 * R)} 0M${n(cx + R)} ${n(cy - R - w / 2)}V${n(cy + R + w / 2)}"` +
    ` fill="none" stroke="url(#${id}ash)" stroke-width="${n(w)}"/>`
  );
}

function ember() {
  const icon = svg(512, 512, emberDefs("i") + squircle(512, "url(#ibg)") + emberMark("i", 1.25, -34, -81.5));
  // 透明底那份不带光晕：光晕离了深色底就是一团脏橙色。灰圈在浅色页上换成炭黑。
  const flat = (id) =>
    emberDefs(id).replace(
      /<linearGradient id="\w+ash".*?<\/linearGradient>/,
      `<linearGradient id="${id}ash" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="var(--ash0)"/><stop offset="1" stop-color="var(--ash1)"/></linearGradient>`,
    );
  const tone = adaptive({ ash0: "#3a383d", ash1: "#111113", ink: "#111113" }, { ash0: "#fbf8f3", ash1: "#a8a39c", ink: "#f4f1ec" });
  const mark = svg(512, 512, tone + flat("m") + emberMark("m", 1.5, -92, -149, false));
  // 粗体的 s 两个收笔要竖着切才稳：弧多画一段，再用一块缺了右上、左下两角的剪裁区把多出来的切掉。
  const sx = 250, base = 212, X = 132, cx = sx + X * 0.31, cut = X * 0.31 * Math.cos((38 * Math.PI) / 180);
  const [sd, sw] = letters.s(sx, base, X, 8);
  const text = word("h", sx + sw + 60, base, X, 0);
  const clip =
    `<clipPath id="lcut"><path d="M0 0H${n(cx + cut)}V${n(base - X * 0.75)}H900V256H${n(cx - cut)}V${n(base - X * 0.25)}H0Z"/></clipPath>`;
  const lockup = svg(
    text.right + 44,
    256,
    tone + flat("l") + clip + emberMark("l", 0.6875, -48.9, -39.6, false).replace(/url\(#lash\)/, "var(--ink)") +
      `<g fill="none" stroke="var(--ink)" stroke-width="41.25"><path d="${sd}" clip-path="url(#lcut)"/><path d="${text.d}"/></g>`,
  );
  return { icon, mark, lockup };
}

// ── 三、像素 ────────────────────────────────────────────────────────────
// ash 也是一个 shell：一位图的字，后面跟着一块还在等输入的光标。
const glyphs = {
  a: [".###.", "....#", ".####", "#...#", ".####"],
  s: [".####", "#....", ".###.", "....#", "####."],
  h: ["#....", "#....", "####.", "#...#", "#...#", "#...#", "#...#"],
};

// 把点阵按行合并成横条再输出：同一行相邻的点是一个矩形，缩小时不会露缝。
function bitmap(rows, x, bottom, cell, fill) {
  const out = [];
  rows.forEach((row, i) => {
    const y = bottom - (rows.length - i) * cell;
    for (const m of row.matchAll(/#+/g)) {
      out.push(`<rect x="${n(x + m.index * cell)}" y="${n(y)}" width="${n(m[0].length * cell)}" height="${n(cell)}" fill="${fill}"/>`);
    }
  });
  return out.join("");
}

function pixel() {
  const tone = adaptive({ ink: "#111113", cursor: "#5e6ad2" }, { ink: "#f1f0ec", cursor: "#8b95ee" });
  const face = (ink, cursor, cell, x, bottom) =>
    bitmap(glyphs.a, x, bottom, cell, ink) +
    `<rect x="${n(x + 6 * cell)}" y="${n(bottom - 5 * cell)}" width="${n(2 * cell)}" height="${n(5 * cell)}" fill="${cursor}"/>`;
  const icon = svg(512, 512, squircle(512, "#eceae4") + face("#111113", "#5e6ad2", 44, 80, 366), ' shape-rendering="crispEdges"');
  const mark = svg(512, 512, tone + face("var(--ink)", "var(--cursor)", 60, 16, 406), ' shape-rendering="crispEdges"');
  const c = 24;
  let x = 24;
  let body = "";
  for (const ch of "ash") {
    body += bitmap(glyphs[ch], x, 208, c, "var(--ink)");
    x += 6 * c;
  }
  body += `<rect x="${x}" y="${208 - 5 * c}" width="${2 * c}" height="${5 * c}" fill="var(--cursor)"/>`;
  const lockup = svg(x + 2 * c + 24, 256, tone + body, ' shape-rendering="crispEdges"');
  return { icon, mark, lockup };
}

for (const [name, files] of Object.entries({ fork: fork(), ember: ember(), pixel: pixel() })) {
  mkdirSync(join(here, name), { recursive: true });
  for (const [kind, text] of Object.entries(files)) writeFileSync(join(here, name, `${kind}.svg`), text);
}
