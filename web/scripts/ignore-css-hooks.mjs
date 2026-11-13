// 给 tsx 跑的服务端渲染测试用：组件文件里 `import "./x.css"` 在浏览器里由 vite 处理，
// 到了 node 里就是「不认识的扩展名」，整个测试起不来。这里把 .css 当成空模块；
// `import x from "./y.svg?raw"`（智能体的标）同样是 vite 的写法，照 vite 的意思交出文件原文。
// 用法：tsx --import ./scripts/ignore-css-hooks.mjs scripts/<test>.tsx
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

registerHooks({
  load(url, context, next) {
    if (url.endsWith(".css")) return { format: "module", source: "", shortCircuit: true };
    if (url.endsWith("?raw")) {
      const text = readFileSync(fileURLToPath(url.slice(0, -"?raw".length)), "utf8");
      return { format: "module", source: `export default ${JSON.stringify(text)};`, shortCircuit: true };
    }
    return next(url, context);
  },
});
