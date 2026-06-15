import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, extname, normalize } from "node:path";
import { api } from "./routes.js";
import { ensureSchema } from "./db/index.js";
import { startScheduler } from "./schedules.js";

await ensureSchema();
startScheduler();

const app = new Hono();
app.route("/api", api);

// Serve the built SPA (web/dist) in production. Path is resolved relative to this
// module (works regardless of cwd). In dev, Vite serves on :5173 and proxies /api.
const DIST = fileURLToPath(new URL("../../web/dist", import.meta.url));
const hasBuild = existsSync(join(DIST, "index.html"));

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

if (hasBuild) {
  app.get("/*", async (c) => {
    const urlPath = decodeURIComponent(new URL(c.req.url).pathname);
    // Resolve within DIST; fall back to index.html for SPA routes.
    const candidate = normalize(join(DIST, urlPath));
    const file =
      candidate.startsWith(DIST) && existsSync(candidate) && statSync(candidate).isFile()
        ? candidate
        : join(DIST, "index.html");
    const body = await readFile(file);
    return c.body(body, 200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
  });
} else {
  app.get("/", (c) =>
    c.text("Harness server running. Web build not found — run `npm run dev` (Vite :5173) or `npm run build`."),
  );
}

const port = Number(process.env.PORT ?? 4317);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[harness] server on http://localhost:${info.port}`);
});
