// navi 的标：字母 N —— 两道往前斜 20° 的杠，中间一根竖直的指南针，指北那半截是朱红。
// 几何和配色以这一份为准：前端的标与加载动画（NaviMark.tsx / NaviLoader.tsx）、页面上标的配色和转轴与
// 标签页图标（都由 vite/brand-head.ts 写进页面 <head>）、
// docs/logo 下的整套 SVG 和手机端图标（docs/logo/build.mjs）都从这里取；mac 的应用图标是把
// docs/logo/icon.svg 栅格化出来的（desktop/macos/scripts/make-icon.swift），首启页的标就是应用图标本身。
//
// 这个文件不许有 import，也只用擦得掉的类型语法：docs/logo/build.mjs 是拿 node 直接读它的。
//
// 画在 24×24 里。针绕 (12,12) 转；先画针再画杠，针压在杠下面。16px 下针和杠之间还留着近一个像素的缝。

export const VIEW = 24;
export const PIVOT = 12;

export const NEEDLE_SOUTH = "12,20.4 9.48,12 14.52,12";
export const NEEDLE_NORTH = "12,3.6 14.52,12 9.48,12";
export const BARS = ["7.92,3 11.32,3 4.77,21 1.37,21", "19.23,3 22.63,3 16.08,21 12.68,21"];

/** 墨色、朱红各分浅底、深底两份；tile 是应用图标那块底，图标里一律用浅底那组。 */
export const COLORS = {
  light: { ink: "#111113", north: "#e5484d" },
  dark: { ink: "#f1f0ec", north: "#ff6b6b" },
  tile: "#eceae4",
};
/** 应用图标：圆角是边长的 22.5%，标占边长的 60%。 */
export const TILE_RADIUS = 0.225;
export const TILE_MARK = 0.6;

/**
 * 字标：标本身当 N，后面跟不斜的 avi，笔画和杠一样粗，i 头上那一点是朱红的正圆。
 * 字母在自己的格子里画，再整体挪到杠后面；viewBox 让标留在原位。
 */
export const WORDMARK = {
  viewBox: "0.97 0 62.23 24",
  width: 62.23,
  transform: "translate(22.2 2.15) scale(1.45)",
  stroke: 2.34,
  strokes: [
    { circle: { cx: 5.02, cy: 8.5, r: 3.85 } },
    { d: "M8.87,4 V13" },
    { d: "M13.74,4 L17.54,12.6 L21.34,4" },
    { d: "M26.42,4 V13" },
  ] as ({ circle: { cx: number; cy: number; r: number } } | { d: string })[],
  dot: { cx: 26.42, cy: 0.5, r: 1.47 },
};

export interface Tone {
  ink: string;
  north: string;
}

/** 给某一笔上色：返回挂在元素上的属性。定死的颜色直接写进属性；要跟着深浅色换的走 CSS 变量。 */
export type Paint = (role: keyof Tone, prop?: "fill" | "stroke") => string;
export const fixedPaint = (tone: Tone): Paint => (role, prop = "fill") => `${prop}="${tone[role]}"`;
/** 颜色从 --ink / --north 取，配 adaptiveStyle()。写在 style 里：属性里的 var() 不是每个渲染器都认。 */
export const adaptivePaint: Paint = (role, prop = "fill") => `style="${prop}:var(--${role})"`;
/** 给 adaptivePaint 配的那段样式：浅色一组，系统切到深色换另一组。 */
export function adaptiveStyle(): string {
  const vars = (tone: Tone) => `--ink:${tone.ink};--north:${tone.north}`;
  return `<style>svg{${vars(COLORS.light)}}@media (prefers-color-scheme:dark){svg{${vars(COLORS.dark)}}}</style>`;
}

/** 标的 SVG 片段（不带外层 <svg>）。needleClass 给针那一组挂类名，加载动画靠它转。 */
export function markBody(paint: Paint, needleClass = ""): string {
  const cls = needleClass ? ` class="${needleClass}"` : "";
  return (
    `<g${cls}><polygon points="${NEEDLE_SOUTH}" ${paint("ink")}/><polygon points="${NEEDLE_NORTH}" ${paint("north")}/></g>` +
    BARS.map((points) => `<polygon points="${points}" ${paint("ink")}/>`).join("")
  );
}

/** 字标里 avi 那几笔（不带标），接在 markBody 后面画。 */
export function wordBody(paint: Paint): string {
  const pen = `fill="none" ${paint("ink", "stroke")} stroke-width="${WORDMARK.stroke}" stroke-linejoin="round" stroke-linecap="butt"`;
  const strokes = WORDMARK.strokes
    .map((s) => ("circle" in s ? `<circle cx="${s.circle.cx}" cy="${s.circle.cy}" r="${s.circle.r}" ${pen}/>` : `<path d="${s.d}" ${pen}/>`))
    .join("");
  const { cx, cy, r } = WORDMARK.dot;
  return `<g transform="${WORDMARK.transform}">${strokes}<circle cx="${cx}" cy="${cy}" r="${r}" ${paint("north")}/></g>`;
}

/** 标签页图标：标铺满整张图，颜色跟着浏览器的深浅色换（标签栏是浏览器画的，不归应用的主题管）。 */
export function faviconSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VIEW} ${VIEW}">${adaptiveStyle()}${markBody(adaptivePaint)}</svg>`;
}

/**
 * 网页上标的配色与转轴。墨色、朱红跟着应用的深浅色换（根上的 data-theme，不是系统偏好）；
 * 挂 .navi-tile 的那一块是应用图标的米白底，底是定死的浅色，里面的标也定死浅底那组。
 * .navi-inverse 给落在实心键上的标：键的底色和页面反着（浅色页上是黑键），标就取另一组。
 * vite/brand-head.ts 把它写进页面 <head>；docs/logo/build.mjs 把它嵌进 loader.svg。
 */
export function brandCss(): string {
  const { light, dark, tile } = COLORS;
  return (
    `:root{--navi-ink:${light.ink};--navi-north:${light.north}}` +
    `:root[data-theme="dark"]{--navi-ink:${dark.ink};--navi-north:${dark.north}}` +
    `.navi-tile{background:${tile};--navi-ink:${light.ink};--navi-north:${light.north}}` +
    `.navi-inverse{--navi-ink:${dark.ink};--navi-north:${dark.north}}` +
    `:root[data-theme="dark"] .navi-inverse{--navi-ink:${light.ink};--navi-north:${light.north}}` +
    `.navi-mark__needle{transform-box:view-box;transform-origin:${PIVOT}px ${PIVOT}px}`
  );
}
