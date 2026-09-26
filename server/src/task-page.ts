import { Readable } from "node:stream";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname } from "node:path";
import type { Hono } from "hono";
import { resolveInRoot, taskFileRoot } from "./file-browser.js";

// 在 ash 里直接看任务做出来的**网页**。
//
// 为什么不复用 `/tasks/:id/file/raw`：那个端点带 `content-disposition: inline`，一旦给
// html 配上 `text/html`，工作区里任何一份 html 就能以 ash 自己的源跑脚本——读得到登录态、
// 能带着 cookie 调 ash 的接口。而这些 html 恰恰是 agent 现写的，正是最不该信的那一类。
//
// 所以单开这一条，两道锁叠着：
//   ① 响应头 `Content-Security-Policy: sandbox allow-scripts …` —— **直接在地址栏打开
//      也照样生效**，文档拿到的是不透明源，脚本能跑但碰不到 ash 的 cookie/localStorage，
//      也没法用登录态调接口。光靠 iframe 的 sandbox 属性挡不住直接导航。
//   ② 前端那一侧的 `<iframe sandbox>`（`allow-same-origin` 一律不给）。
//
// 路径做成 `/tasks/:id/page/<相对路径>` 而不是 `?path=`，是为了让页面里的相对引用
// （`./style.css`、`img/a.png`）自己就能解对——查询串形式的地址解出来会全指到同一个端点上。
//
// 已知取舍：`@font-face` 拉的字体是 CORS 请求，不透明源下会被浏览器拦掉，页面会退到系统
// 字体。修它要给这条路加 `access-control-allow-origin: *`，那等于把工作区文件开放给任意
// 网站读——为一个字体不值得。要完整保真就走卡片上的「在浏览器中打开」。

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".avif": "image/avif", ".bmp": "image/bmp", ".ico": "image/x-icon",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4", ".ogg": "audio/ogg",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf",
  ".pdf": "application/pdf",
};

/** 不给 `allow-same-origin`：给了这层沙箱就等于没有。 */
const SANDBOX = "sandbox allow-scripts allow-forms allow-popups allow-modals";
const MAX_PAGE_BYTES = 64 * 1024 * 1024;

export function mountTaskPageRoutes(api: Hono): void {
  api.get("/tasks/:id/page/*", async (c) => {
    const taskId = c.req.param("id");
    const root = await taskFileRoot(taskId);
    if (!root) return c.text("这个任务还没有可浏览的工作目录", 404);

    const prefix = `/api/tasks/${encodeURIComponent(taskId)}/page/`;
    const pathname = new URL(c.req.url).pathname;
    let rel: string;
    try {
      rel = decodeURIComponent(pathname.slice(pathname.indexOf(prefix) + prefix.length));
    } catch {
      return c.text("路径解不开", 400);
    }
    if (!rel) return c.text("没有指定页面", 400);

    try {
      // 越界与软链越狱由它把关，跟文件浏览是同一道门。
      const abs = await resolveInRoot(root.path, rel);
      const info = await stat(abs);
      if (info.isDirectory()) return c.text("这是一个目录", 400);
      if (info.size > MAX_PAGE_BYTES) return c.text("文件过大，无法在线预览", 413);

      const headers: Record<string, string> = {
        "content-type": MIME[extname(abs).toLowerCase()] ?? "application/octet-stream",
        "content-length": String(info.size),
        "content-security-policy": SANDBOX,
        // 页面是 agent 随时在重写的，缓存住等于给用户看上一版。
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      };
      return new Response(Readable.toWeb(createReadStream(abs)) as ReadableStream, { headers });
    } catch (error) {
      const status = (error as { status?: unknown } | null)?.status;
      return c.text(
        error instanceof Error ? error.message : String(error),
        (typeof status === "number" ? status : 500) as 400,
      );
    }
  });
}
