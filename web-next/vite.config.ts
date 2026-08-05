import { createRequire } from "node:module";
import { dirname } from "node:path";
import { defineConfig, searchForWorkspaceRoot } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const require = createRequire(import.meta.url);
// npm workspace 的字体包真实路径在主仓库 node_modules，worktree 默认白名单无法覆盖。
const interPackageRoot = dirname(require.resolve("@fontsource-variable/inter/package.json"));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // 端口不写死。两件事都得让开：
    // ① harness 起预览时会借一个空闲端口用环境变量 PORT 递进来（server/src/preview.ts 的
    //    freePort），但 vite 自己不读 PORT（Next/CRA/Nest 都读，就它不读），得在这儿接一手；
    // ② 没人借端口时（自己 `npm run dev`）5173 也常常已经有一份在跑，所以**不开 strictPort**，
    //    让 vite 自己顺延到下一个空闲端口 —— 撞一下就整个崩掉，纯属没必要。
    // 顺延是安全的：harness 判断预览起没起来，是从日志里读它**实际**打印的那个 URL，
    // 不是拿借出去的端口去连；vite 顺延时那句 "Port 5173 is in use, trying another one..."
    // 也已经被 preview-log.ts 的 PORT_RETRY_RE 排除在「撞车」之外。
    port: Number(process.env.PORT) || 5173,
    // 显式绑 IPv4 回环。vite 默认的 `localhost` 在这台机器上只落到 `::1`，日志里却照样
    // 印 `http://localhost:…` —— 于是任何「连 127.0.0.1 探一下」的东西（harness 的就绪
    // 探测、各种反代和脚本）都会认定它没起来，而人在浏览器里点开又是好的，最难查的那
    // 一类。两头都不吃亏：绑 127.0.0.1 时浏览器访问 localhost 照旧通。
    host: "127.0.0.1",
    fs: {
      allow: [searchForWorkspaceRoot(process.cwd()), interPackageRoot],
    },
    proxy: {
      "/api": {
        target: process.env.HARNESS_PROXY ?? "http://localhost:4317",
        changeOrigin: true,
      },
    },
  },
  build: { outDir: "dist" },
});
