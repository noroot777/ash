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
// ## 令牌：挡住第三方站点的那一道
//
// `ACAO: null` 会匹配**任何**不透明源的请求者——攻击者在自己站上开一个 sandbox iframe
// 就能造出 `Origin: null`。所以路径里带一段令牌（进程级随机密钥对 taskId 做 HMAC）：
// 地址由服务端随文件内容一起发给前端，猜不出也枚举不动。重启换密钥，前端下次读文件时
// 自然拿到新的。
//
// ## 但页面读不到工作区，靠的不是令牌，是「压根不发 ACAO」
//
// 令牌就写在 iframe 的地址里，页面脚本一句 `location.pathname` 就拿到了。**防得了别人，
// 防不了页面自己。** 第 2、3 轮审查连着从这里打进来：先是 `fetch` 读走任意文件，堵掉
// `fetch` 之后又用 `import()` 跑工作区里的 JS 模块、读它的导出值。
//
// 这两轮之后能确认一件事：**凡是「按页面声明的依赖发通行证」的方案都是假的**——HTML 就是
// agent 写的，它在页面里写一句 `<script type="module" src="/secrets.js">`，服务端就会
// 老老实实给那个文件发通行证。白名单由攻击者填，等于没有白名单。
//
// 所以判据换成「**能不能读到字节**」，而不是「该不该给这个路径」：
//   • 脚本（含 `import()`）**一律不发 ACAO**——模块脚本恒定走 CORS，没有 ACAO 就既读不到
//     也跑不了。这条路彻底断掉，不留可收窄的余地。
//   • 页面自己那几个模块脚本怎么办：服务端在改写 HTML 时**把它们的代码直接内联进文档**。
//     行内模块脚本不需要 CORS，所以普通页面照常跑。
//   • 样式表、图片、媒体、普通（非 module）脚本本来就是 no-cors 加载，**从来不需要**
//     ACAO；没有 `crossorigin`（已摘），画到 canvas 会被污染，页面读不到像素。
//   • 只剩字体还发 ACAO：`@font-face` 恒定走 CORS，而字体加载只认得懂字体格式的字节，
//     解不出内容也拿不到源文本；`fetch` 一个文件再喂给 `FontFace` 那条路已经被堵死。
//
// 代价写在这里，别当成 bug 再修一轮：页面里**模块之间的相对 import**（多文件 ESM 源码、
// 构建产物的懒加载分块）加载不了。ash 自己那份 dist 的入口块就没有静态 import，只有两处
// 懒加载路由，所以外壳照常挂得出来。真要完整跑，走「在浏览器中打开」。
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
 * 只有字体拿得到 `ACAO: null`。
 *
 * `@font-face` 恒定走 CORS，不给就没有自定义字体；而字体解析只吃得懂字体格式的字节，
 * 页面拿不到源文本，`fetch` 一个文件再喂给 `FontFace` 那条路也已经被同一道闸堵死。
 * **脚本一律不在这里面**——原因见顶部「靠的不是令牌」那一节，别顺手加回来。
 */
const CORS_DESTINATIONS = new Set(["font"]);
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

/** 外链模块脚本：`<script type="module" src="…"></script>`，src 已经是改写过的预览地址。 */
const MODULE_SCRIPT = /<script\b([^>]*\btype\s*=\s*["']module["'][^>]*)>\s*<\/script\s*>/gi;
const SRC_ATTR = /\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;
/** `modulepreload` 现在必然加载失败（脚本不发 ACAO），留着只会在控制台刷红。 */
const MODULE_PRELOAD = /<link\b[^>]*\brel\s*=\s*["']modulepreload["'][^>]*>\s*/gi;
/**
 * 模块专属语法。有这些就当不了普通脚本，只能让它加载失败。
 *
 * `import(` 是动态导入，普通脚本也支持，**不算**。判错方向是安全的：误判成「有」只是少
 * 转一个页面（用户还有外部打开），误判成「没有」才会让页面报 SyntaxError。
 */
const MODULE_ONLY_SYNTAX = /(?:^|[\s;}])export\b|(?:^|[\s;}])import\s*(?:["'{*]|[A-Za-z$_])|import\.meta/;

/**
 * 外链模块脚本能不能改当普通脚本发。
 *
 * 这是「脚本一律不发 ACAO」之后还能让普通页面跑起来的那一半：**普通脚本是 no-cors 加载**
 * ——浏览器照跑，而页面读不到它的源码（跨源脚本没有任何读取入口，`crossorigin` 也已摘）。
 * 模块脚本做不到这点，它恒定走 CORS，给了 ACAO 就等于把文件正文交出去。
 *
 * 返回每个 src 的判定：`true` = 可以当普通脚本，`false` = 只能让它失败。
 */
export async function planModuleScripts(
  html: string,
  workspaceRoot: string,
  pageBase: string,
  fileDir: string,
): Promise<Map<string, boolean>> {
  const plan = new Map<string, boolean>();
  for (const [, attrs] of html.matchAll(MODULE_SCRIPT)) {
    const hit = SRC_ATTR.exec(attrs);
    const src = hit ? (hit[1] ?? hit[2] ?? hit[3] ?? "") : "";
    if (!src || plan.has(src)) continue;
    const bare = src.split(/[?#]/)[0];
    let rel: string | null = null;
    if (bare.startsWith(`${pageBase}/`)) rel = bare.slice(pageBase.length + 1);
    else if (!/^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(bare)) rel = fileDir ? `${fileDir}/${bare}` : bare;
    if (!rel) continue;
    try {
      const abs = await resolveInRoot(workspaceRoot, decodeURIComponent(rel));
      if ((await stat(abs)).size > MAX_REWRITE_BYTES) { plan.set(src, false); continue; }
      plan.set(src, !MODULE_ONLY_SYNTAX.test(await readFile(abs, "utf8")));
    } catch {
      plan.set(src, false);
    }
  }
  return plan;
}

/** 按 `planModuleScripts` 的判定把能转的转成普通脚本；转不了的原样留着，让它自己失败。 */
export function convertModuleScripts(html: string, plan: ReadonlyMap<string, boolean>): string {
  return html.replace(MODULE_PRELOAD, "").replace(MODULE_SCRIPT, (whole, attrs: string) => {
    const hit = SRC_ATTR.exec(attrs);
    const src = hit ? (hit[1] ?? hit[2] ?? hit[3] ?? "") : "";
    if (!src || !plan.get(src)) return whole;
    // 模块脚本本来就是延迟执行的，转普通脚本要补 `defer` 才不会把执行时机提前到文档就绪前。
    const kept = attrs.replace(/\stype\s*=\s*["']module["']/i, "").replace(/\sdefer\b/gi, "").trim();
    return `<script defer ${kept}></script>`;
  });
}

/** 这份网页有没有跑不起来的模块脚本——有就得当面告诉用户，别让他对着半死的预览猜。 */
export function blockedModuleScripts(plan: ReadonlyMap<string, boolean>): number {
  let blocked = 0;
  for (const ok of plan.values()) if (!ok) blocked += 1;
  return blocked;
}

/**
 * 打开某份网页之前先问一句：它在沙箱里跑得全吗。跑不全就把话说在前面（见 FileViewer）。
 *
 * 判据只有一条硬事实——**有没有转不成普通脚本的外链模块脚本**。有就意味着那几段 JS 在
 * 预览里根本不会执行，页面十有八九是个空壳；与其让用户对着空壳猜，不如直接指向外部打开。
 */
export async function pagePreviewNotice(
  workspaceRoot: string,
  relPath: string,
  html: string,
): Promise<string | null> {
  if (!PAGE_EXTENSIONS.has(extname(relPath).toLowerCase())) return null;
  const fileDir = relPath.includes("/") ? relPath.slice(0, relPath.lastIndexOf("/")) : "";
  const siteRoot = resolveSiteRoot(workspaceRoot, fileDir, rootSegments(html, HTML_ROOT_REF));
  // 令牌是什么无所谓，这里只关心「哪些 src 指向工作区里的哪个文件」，所以拿占位前缀跑一遍
  // 改写，让 planModuleScripts 走的是跟真实渲染**同一条**解析路径（前缀的拆法也必须同源：
  // 站点根拼进改写基址，剥前缀时只剥到令牌那一段）。
  const pageBase = "/api/tasks/x/page/x";
  const base = `${pageBase}${siteRoot ? `/${encodePath(siteRoot)}` : ""}`;
  const plan = await planModuleScripts(rewriteHtml(html, base), workspaceRoot, pageBase, fileDir);
  const blocked = blockedModuleScripts(plan);
  return blocked
    ? "这个网页要用模块脚本（ES module），沙箱预览里跑不起来，你看到的多半只是个空壳。点「在浏览器中打开」看完整效果。"
    : null;
}

export function mountTaskPageRoutes(api: Hono): void {  api.get("/tasks/:id/page/:token/*", async (c) => {
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
        const pageBase = taskPageBase(taskId);
        const base = `${pageBase}${siteRoot ? `/${encodePath(siteRoot)}` : ""}`;
        if (!isPage) return new Response(rewriteCss(text, base), { headers });
        const rewritten = rewriteHtml(text, base);
        const plan = await planModuleScripts(rewritten, root.path, pageBase, fileDir);
        return new Response(convertModuleScripts(rewritten, plan), { headers });
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
