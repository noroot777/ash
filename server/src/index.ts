import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { existsSync, statSync, createReadStream, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { join, extname, normalize } from "node:path";
import { api } from "./routes.js";
import { ensureSchema } from "./db/index.js";
import { reconcileInterrupted } from "./orchestrator.js";
import { startScheduler } from "./schedules.js";

// Never let a stray async error (e.g. an SSE write to a disconnected client)
// take the whole server down — log and keep running.
process.on("unhandledRejection", (e) => console.error("[harness] unhandledRejection:", e));
process.on("uncaughtException", (e) => console.error("[harness] uncaughtException:", e));

await ensureSchema();
await reconcileInterrupted(); // recover tasks left "running"/"queued" by a previous crash/restart
startScheduler();

const app = new Hono();
app.route("/api", api);

// ── 待审视频预览(Tailscale 旁路)─────────────────────────────────────────────
// 待审 mp4 软链到仓库根的 review/ 下,手机经 Tailscale 直接开
// http://<tailnet-ip>:4317/review/current/ 审核,不必另起第二个服务。必须注册在下方
// catch-all "/*" 之前,否则被 SPA 兜底截走。SPA 那条 readFile 把整文件读进内存、不支持
// Range;视频大且要拖动进度,所以这里单独用 createReadStream 流式 + 解析 Range 返回 206。
// createReadStream 跟随软链,所以 review 目录放软链即可,无需拷贝原片。
// 根目录默认跟随 harness 项目(review/ 在仓库根下,迁机器也不失效);可用 HARNESS_REVIEW_ROOT
// 覆盖。src 与编译后的 dist 都在 server/ 下一层,../../ 均指向仓库根。
const REVIEW_ROOT = normalize(
  process.env.HARNESS_REVIEW_ROOT ?? fileURLToPath(new URL("../../review", import.meta.url)),
);
app.get("/review", (c) => c.redirect("/review/"));
app.get("/review/*", async (c) => {
  const rel = decodeURIComponent(new URL(c.req.url).pathname).replace(/^\/review\/?/, "");
  const target = normalize(join(REVIEW_ROOT, rel));
  // 防路径穿越:解析后必须仍落在 ROOT 内(软链的"目标"可以在 ROOT 外——那正是本方案的关键)。
  if (target !== REVIEW_ROOT && !target.startsWith(REVIEW_ROOT + "/")) return c.notFound();
  if (!existsSync(target)) return c.notFound();
  const st = statSync(target); // 跟随软链

  // 目录 → 极简清单页,手机点开就能播。
  if (st.isDirectory()) {
    const base = "/review/" + (rel ? rel.replace(/\/+$/, "") + "/" : "");
    const items = readdirSync(target)
      .filter((n) => n.toLowerCase().endsWith(".mp4"))
      .sort()
      .map((n) => {
        const href = base + encodeURIComponent(n);
        return `<li><a href="${href}">${n}</a><video controls preload="metadata" src="${href}"></video></li>`;
      })
      .join("\n");
    return c.html(
      `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">` +
        `<title>待审视频</title><style>body{font:16px/1.5 -apple-system,system-ui,sans-serif;margin:1rem;background:#111;color:#eee}` +
        `h2{font-size:1.1rem}ul{padding:0}li{list-style:none;margin:0 0 2rem}a{color:#6cf;word-break:break-all}` +
        `video{display:block;width:100%;max-width:760px;margin:.5rem 0;border-radius:8px;background:#000}</style>` +
        `<h2>待审视频 ${rel || "/"}</h2><ul>${items || "<li>(暂无 mp4)</li>"}</ul>`,
    );
  }

  // 文件:只放行 mp4,支持 Range 拖动。
  if (extname(target).toLowerCase() !== ".mp4") return c.notFound();
  const size = st.size;
  const range = c.req.header("range");
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    const start = m && m[1] ? Number(m[1]) : 0;
    const end = m && m[2] ? Number(m[2]) : size - 1;
    if (start >= size || end >= size || start > end) {
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
    }
    return new Response(Readable.toWeb(createReadStream(target, { start, end })) as any, {
      status: 206,
      headers: {
        "Content-Type": "video/mp4",
        "Accept-Ranges": "bytes",
        "Content-Range": `bytes ${start}-${end}/${size}`,
        "Content-Length": String(end - start + 1),
      },
    });
  }
  return new Response(Readable.toWeb(createReadStream(target)) as any, {
    status: 200,
    headers: { "Content-Type": "video/mp4", "Accept-Ranges": "bytes", "Content-Length": String(size) },
  });
});

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
