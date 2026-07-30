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
    port: 5174,
    strictPort: true,
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
