import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5174,
    strictPort: true,
    proxy: {
      "/api": {
        target: process.env.HARNESS_PROXY ?? "http://localhost:4317",
        changeOrigin: true,
      },
    },
  },
  build: { outDir: "dist" },
});
