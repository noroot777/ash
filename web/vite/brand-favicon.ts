import type { Plugin } from "vite";
import { faviconSvg } from "../src/brand/ashMark.ts";

// 标签页图标在交出文档时现写进 <head>，而不是在 index.html 里贴一串死的 data URI：
// 图只有 src/brand/ashMark.ts 那一份，改了它这里当场跟着变。内联而不另起一个文件，
// 是因为它不到 1KB，犯不上多一次请求（也顺带挡掉浏览器自己去要 /favicon.ico）。
export function brandFavicon(): Plugin {
  return {
    name: "ash-brand-favicon",
    transformIndexHtml: () => [
      {
        tag: "link",
        attrs: { rel: "icon", type: "image/svg+xml", href: `data:image/svg+xml,${encodeURIComponent(faviconSvg())}` },
        injectTo: "head",
      },
    ],
  };
}
