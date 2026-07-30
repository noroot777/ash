import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  base: "/legacy/",
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // Dev: proxy API + SSE to the long-running Hono server.
    // HARNESS_PROXY 可指到别的实例(如 throwaway 预览实例),默认 live :4317。
    proxy: {
      "/api": {
        target: process.env.HARNESS_PROXY ?? "http://localhost:4317",
        changeOrigin: true,
      },
    },
  },
  build: { outDir: "dist" },
});
