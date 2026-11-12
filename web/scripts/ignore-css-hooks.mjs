// 给 tsx 跑的服务端渲染测试用：组件文件里 `import "./x.css"` 在浏览器里由 vite 处理，
// 到了 node 里就是「不认识的扩展名」，整个测试起不来。这里把 .css 当成空模块。
// 用法：tsx --import ./scripts/ignore-css-hooks.mjs scripts/<test>.tsx
import { registerHooks } from "node:module";

registerHooks({
  load(url, context, next) {
    if (url.endsWith(".css")) return { format: "module", source: "", shortCircuit: true };
    return next(url, context);
  },
});
