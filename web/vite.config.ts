import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // Dev: proxy API + SSE to the long-running Hono server.
    proxy: {
      "/api": {
        target: "http://localhost:4317",
        changeOrigin: true,
      },
    },
  },
  build: { outDir: "dist" },
});
