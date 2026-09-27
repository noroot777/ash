import { Readable } from "node:stream";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import type { Hono } from "hono";
import { resolveInRoot, taskFileRoot } from "./file-browser.js";

// 在 ash 里直接看任务做出来的**网页**。
//
// 为什么不复用 `/tasks/:id/file/raw`：那个端点带 `content-disposition: inline`，一旦给
// html 配上 `text/html`，工作区里任何一份 html 就能以 ash 自己的源跑脚本——读得到登录态、
// 能带着 cookie 调 ash 的接口。而这些 html 恰恰是 agent 现写的，正是最不该信的那一类。
//
// 所以单开这一条，三道锁叠着：
//   ① 响应头 `Content-Security-Policy: sandbox allow-scripts …` —— **直接在地址栏打开
//      也照样生效**，文档拿到的是不透明源，脚本能跑但碰不到 ash 的 cookie/localStorage，
//      也没法用登录态调接口。光靠 iframe 的 sandbox 属性挡不住直接导航。
//   ② 前端那一侧的 `<iframe sandbox>`（`allow-same-origin` 一律不给）。
//   ③ 路径里的**预览令牌**（见下）。
//
// ## 根路径资源：为什么非得改写不可
//
// 第 1 轮审查复现：`web/dist/index.html` 这类构建产物点开是一片空白。两个原因叠在一起：
//   • Vite / CRA / 绝大多数静态构建写的是 `/assets/index-x.js` 这种**根路径**引用。它不
//     跟着页面地址走，而是直奔 ash 自己的根，于是取回来的是 ash 的 index.html；
//   • 就算指对了，文档是不透明源，`<script type="module">` **恒定走 CORS**（跟有没有
//     `crossorigin` 属性无关），没有 `access-control-allow-origin` 一律被拦。
// 所以这里做三件事：把根路径引用改写到本次预览的站点根、摘掉 `crossorigin`（它只会把
// 本来 no-cors 就能加载的样式表/图片也拖进 CORS 检查）、对不透明源回 `ACAO: null`。
//
// ## 令牌：放开 ACAO 之后必须补的那一道
//
// `ACAO: null` 会匹配**任何**不透明源的请求者——攻击者在自己站上开一个 sandbox iframe
// 就能造出 `Origin: null`。所以不能光凭这个头就把工作区文件交出去。路径里因此多一段
// 令牌（进程级随机密钥对 taskId 做 HMAC）：地址由服务端随文件内容一起发给前端，猜不出
// 也枚举不动，拿不到令牌的第三方站点连 404 都摸不到。重启换密钥，前端下次读文件时自然
// 拿到新的。
//
// ## 但令牌挡不住页面自己（第 2 轮审查复现的洞）
//
// 令牌就写在 iframe 的地址里，页面脚本一句 `location.pathname` 就拿到了。于是这些
// **agent 现写、最不该信**的页面可以 `fetch(base + "/secret.txt")`，靠 `ACAO: null`
// 把同一工作区里任意文件的正文读走——再 POST 到任何外站。令牌防的是别人，防不了自己。
//
// 所以 ACAO **按请求目的发**，判据是 `Sec-Fetch-Dest`（`Sec-` 前缀是禁止头，页面脚本
// 改不动，只有浏览器自己填）：
//   • 真正非 CORS 不可的只有**模块脚本**和**字体**（这两类恒定走 CORS 模式），外加
//     module worker。给它们 ACAO。
//   • `fetch()` / `XMLHttpRequest` 的 dest 是 `empty`——正是读文件那条路，一律不给。
//   • 样式表、图片、媒体是 no-cors 加载（`crossorigin` 已被摘掉），**本来就不需要**
//     ACAO，所以也不给。
//   • 头缺失（老浏览器、curl）时**按不给处理**：宁可这类页面退回外部打开，也不因为
//     认不出请求目的就把工作区交出去。
//
// 剩下的口子只有「执行」不是「读取」：页面仍能 `import()` 工作区里一个**真的是 JS 模块**
// 的文件并跑它。拿不到源码文本，且 `nosniff` + 严格 MIME 让非 JS 的文件连加载都过不去。
//
// ## 仍然做不到的事（所以外部打开那颗按钮不能撤）
//
// 改写只能碰 HTML 属性和 CSS 的 `url()`。页面若在**打包后的 JS 里** `fetch("/api/…")`，
// 那串地址在字符串常量里，谁也改不动——这类页面在沙箱里只会渲染出外壳。查看器头上那颗
// 「在浏览器中打开」就是为这种情况留的，别当成冗余入口删掉。

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
/**
 * 只有这几类请求目的拿得到 `ACAO: null`——它们非 CORS 不可，而且拿到的是「能跑」不是
 * 「能读正文」。`fetch`/`XHR` 的 `empty`、以及任何认不出来的目的，一律不给（见顶部注释）。
 */
const CORS_DESTINATIONS = new Set(["script", "worker", "sharedworker", "font"]);
const MAX_PAGE_BYTES = 64 * 1024 * 1024;
/** 改写要把整份读进内存，所以文本类另设一道上限，别为一个 200 MB 的 .map 爆掉。 */
const MAX_REWRITE_BYTES = 8 * 1024 * 1024;
const PAGE_EXTENSIONS = new Set([".html", ".htm"]);

// 进程级密钥：重启即失效。预览地址本来就是每次读文件时现拿的，不需要跨重启稳定。
const TOKEN_SECRET = randomBytes(32);

function pageToken(taskId: string): string {
  return createHmac("sha256", TOKEN_SECRET).update(taskId).digest("base64url").slice(0, 22);
}

function tokenMatches(taskId: string, candidate: string): boolean {
  const expected = Buffer.from(pageToken(taskId));
  const given = Buffer.from(candidate);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

const encodePath = (path: string) => path.split("/").filter(Boolean).map(encodeURIComponent).join("/");

/** 这个任务的预览根地址（不含尾斜杠）。前端拿它拼 iframe 的 src。 */
export function taskPageBase(taskId: string): string {
  return `/api/tasks/${encodeURIComponent(taskId)}/page/${pageToken(taskId)}`;
}

/** 某个 html 的预览地址。不是网页就返回 null——调用方据此决定给不给渲染入口。 */
export function taskPageUrlFor(taskId: string, relPath: string): string | null {
  return PAGE_EXTENSIONS.has(extname(relPath).toLowerCase())
    ? `${taskPageBase(taskId)}/${encodePath(relPath)}`
    : null;
}

/**
 * 这份文件的「站点根」在哪。
 *
 * `/assets/x.js` 里的那个 `/` 指的是**站点**根，不是工作区根，也不一定是文件自己所在的
 * 目录：`web/dist/index.html` 的站点根是 `web/dist`，而 `site/pages/about.html` 引用
 * `/css/a.css` 时站点根是 `site`。所以从文件所在目录往上走，第一个真的装着这些顶层段
 * （`assets`、`css`…）的目录就是它。一个都对不上就退回文件自己的目录。
 *
 * html 和 css 走同一套：两边都会写根路径引用，只是一个在属性里、一个在 `url()` 里。
 */
function resolveSiteRoot(workspaceRoot: string, fileDir: string, segments: ReadonlySet<string>): string {
  if (!segments.size) return fileDir;
  const candidates: string[] = [];
  for (let dir = fileDir; ; dir = dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : "") {
    candidates.push(dir);
    if (!dir) break;
  }
  for (const dir of candidates) {
    for (const segment of segments) {
      if (existsSync(join(workspaceRoot, dir, segment))) return dir;
    }
  }
  return fileDir;
}

/** 根路径引用的顶层那一段（`/assets/x.js` → `assets`），用来反推站点根。 */
function rootSegments(text: string, pattern: RegExp): Set<string> {
  const segments = new Set<string>();
  for (const match of text.matchAll(pattern)) {
    segments.add(match[1]);
    if (segments.size >= 8) break;
  }
  return segments;
}

const HTML_ROOT_REF = /\s(?:src|href)\s*=\s*["']\/(?!\/)([^"'/?#]+)/gi;
const CSS_ROOT_REF = /url\(\s*["']?\/(?!\/)([^"')/?#]+)/gi;

const ROOT_RELATIVE = /^\/(?!\/)/;

/** CSS 里的 `url(/x)`：样式表自己也会指根路径（字体、背景图）。 */
function rewriteCss(css: string, base: string): string {
  return css.replace(
    /url\(\s*(["']?)(\/(?!\/)[^"')\s]*)\1\s*\)/g,
    (_whole, quote: string, url: string) => `url(${quote}${base}${url}${quote})`,
  );
}

function rewriteTag(tag: string, base: string): string {
  // `crossorigin` 在不透明源下只有坏处：把本来 no-cors 就能加载的样式表、图片、预加载
  // 也拖进 CORS 检查。模块脚本那一档本来就走 CORS，摘不摘都一样。
  let out = tag.replace(/\scrossorigin(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/gi, "");
  out = out.replace(
    /(\s(?:src|href|poster|action|data-src)\s*=\s*)("([^"]*)"|'([^']*)'|([^\s>]+))/gi,
    (whole: string, prefix: string, _raw: string, dq?: string, sq?: string, bare?: string) => {
      const value = dq ?? sq ?? bare ?? "";
      if (!ROOT_RELATIVE.test(value)) return whole;
      const quote = dq !== undefined ? '"' : sq !== undefined ? "'" : "";
      return `${prefix}${quote}${base}${value}${quote}`;
    },
  );
  // srcset 是逗号分隔的候选表，每一条的前半截才是 URL。
  out = out.replace(
    /(\ssrcset\s*=\s*)("([^"]*)"|'([^']*)')/gi,
    (_whole: string, prefix: string, _raw: string, dq?: string, sq?: string) => {
      const value = dq ?? sq ?? "";
      const quote = dq !== undefined ? '"' : "'";
      const next = value.split(",")
        .map((part) => part.replace(/^(\s*)(\/(?!\/)\S*)/, (_m, space: string, url: string) => `${space}${base}${url}`))
        .join(",");
      return `${prefix}${quote}${next}${quote}`;
    },
  );
  return out;
}

export function rewriteHtml(html: string, base: string): string {
  // 只碰标签内部：正文、脚本体一律不动（`<script>` 的**开标签**会被这条匹配到，
  // 它的**内容**不会——那正是我们想要的边界）。
  const tagged = html.replace(/<[a-zA-Z][^>]*>/g, (tag) => rewriteTag(tag, base));
  return tagged.replace(
    /(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi,
    (_whole, open: string, body: string, close: string) => `${open}${rewriteCss(body, base)}${close}`,
  );
}

export function mountTaskPageRoutes(api: Hono): void {
  api.get("/tasks/:id/page/:token/*", async (c) => {
    const taskId = c.req.param("id");
    const token = c.req.param("token");
    // 先验令牌，再碰磁盘：没令牌的请求连「这个任务在不在」都不该问出来。
    if (!tokenMatches(taskId, token)) return c.text("预览地址已失效，重新打开这个文件", 403);

    const root = await taskFileRoot(taskId);
    if (!root) return c.text("这个任务还没有可浏览的工作目录", 404);

    const prefix = `/page/${token}/`;
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

      const extension = extname(abs).toLowerCase();
      const headers: Record<string, string> = {
        "content-type": MIME[extension] ?? "application/octet-stream",
        "content-security-policy": SANDBOX,
        // 页面是 agent 随时在重写的，缓存住等于给用户看上一版。
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      };
      // 只对不透明源放行（沙箱 iframe 的 Origin 字面量就是 `null`），且**绝不回显**真实
      // 来源——带着自己源的普通网站一律拿不到 ACAO，照常被 CORS 拦下。再按请求目的收一道：
      // 页面脚本的 `fetch` 是 `empty`，给了它就等于把整个工作区交给一份 agent 现写的 html。
      if (c.req.header("origin") === "null" && CORS_DESTINATIONS.has(c.req.header("sec-fetch-dest") ?? "")) {
        headers["access-control-allow-origin"] = "null";
      }
      // 发不发 ACAO 同时取决于这两个请求头，缓存键就得带上它们——哪怕这里是 no-store。
      headers["vary"] = "Origin, Sec-Fetch-Dest";

      const isPage = PAGE_EXTENSIONS.has(extension);
      const rewritable = (isPage || extension === ".css") && info.size <= MAX_REWRITE_BYTES;
      if (rewritable) {
        const text = await readFile(abs, "utf8");
        const fileDir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
        const siteRoot = resolveSiteRoot(
          root.path,
          fileDir,
          rootSegments(text, isPage ? HTML_ROOT_REF : CSS_ROOT_REF),
        );
        const base = `${taskPageBase(taskId)}${siteRoot ? `/${encodePath(siteRoot)}` : ""}`;
        return new Response(isPage ? rewriteHtml(text, base) : rewriteCss(text, base), { headers });
      }

      headers["content-length"] = String(info.size);
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
