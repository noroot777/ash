import type { Plugin } from "vite";
import { brandCss, faviconSvg } from "../src/brand/naviMark.ts";

// 品牌的那两样在交出文档时现写进 <head>：标签页图标，和页面上标的配色、转轴。
// 都只有 src/brand/naviMark.ts 那一份，改了它这里当场跟着变，不在 index.html 和样式表里各抄一遍。
// 图标内联而不另起一个文件，是因为它不到 1KB，犯不上多一次请求（也顺带挡掉浏览器自己去要 /favicon.ico）。
export function brandHead(): Plugin {
  return {
    name: "navi-brand-head",
    transformIndexHtml: () => [
      {
        tag: "link",
        attrs: { rel: "icon", type: "image/svg+xml", href: `data:image/svg+xml,${encodeURIComponent(faviconSvg())}` },
        injectTo: "head",
      },
      { tag: "style", children: brandCss(), injectTo: "head" },
    ],
  };
}
