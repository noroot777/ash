// 网页产物的沙箱预览（server/src/task-page.ts）。
//
// 第 1 轮审查复现的就是这块：`web/dist/index.html` 这类构建产物点开一片空白。根因是
// **根路径引用**（`/assets/index-x.js`）——它不跟着页面地址走，直奔 ash 自己的根，取回来
// 的是 ash 的 index.html；加上不透明源下模块脚本恒定走 CORS，没有 ACAO 一律被拦。
//
// 所以这里钉四件事，少一件那个空白页就回来：
//   1. 根路径引用改写到**本次预览的站点根**（站点根≠工作区根，也≠html 所在目录）
//   2. `crossorigin` 摘掉（它把本来 no-cors 的样式表/图片也拖进 CORS）
//   3. `ACAO: null` 只发给不透明源，**绝不回显真实来源**
//   4. 预览令牌：放开 ACAO 之后挡住第三方站点的那一道，错了/没有一律 403
// 跑：npm -w server run test:task-page
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { releaseTmpDb, requireTmpDb } from "./tmp-db.js";

const stage = mkdtempSync(join(tmpdir(), "ash-task-page-"));
process.env.ASH_DB = join(stage, "ash.db");
requireTmpDb("task-page");

const repo = join(stage, "repo");
const TASK_ID = "PageTest0001";
const write = (path: string, body: string) => {
  mkdirSync(join(repo, path, ".."), { recursive: true });
  writeFileSync(join(repo, path), body);
};

try {
  mkdirSync(repo, { recursive: true });
  // 典型 Vite 产物布局：站点根是 web/dist，不是工作区根，也不是 index.html 的「上一级」。
  write("web/dist/index.html", [
    "<!doctype html><html><head>",
    '<script type="module" crossorigin src="/assets/index-abc.js"></script>',
    '<link rel="stylesheet" crossorigin href="/assets/index-def.css">',
    "<style>body{background:url(/assets/bg.png)}</style>",
    "</head><body>",
    '<img src="./local.png"><img srcset="/assets/a.png 1x, /assets/b.png 2x">',
    '<a href="/about.html">关于</a><a href="https://example.com/x">外链</a>',
    '<script>fetch("/api/data")</script>',
    "</body></html>",
  ].join(""));
  write("web/dist/assets/index-def.css", "@font-face{src:url(/assets/f.woff2)}\n.x{background:url('/assets/bg.png')}");
  write("web/dist/assets/index-abc.js", "console.log(1)");
  write("web/dist/local.png", "x");
  // 另一种布局：html 在子目录，站点根在它的上一级。
  write("site/pages/about.html", '<html><body><link href="/css/main.css"></body></html>');
  write("site/css/main.css", ".a{color:red}");

  const { db, ensureSchema } = await import("../src/db/index.js");
  const { projects, sessions, tasks } = await import("../src/db/schema.js");
  const { mountTaskPageRoutes, rewriteHtml, taskPageBase, taskPageUrlFor } = await import("../src/task-page.js");
  const { Hono } = await import("hono");
  await ensureSchema();

  const stamp = new Date().toISOString();
  await db.insert(projects).values({ id: "p", name: "page", repoPath: repo, createdAt: stamp });
  await db.insert(tasks).values({
    id: TASK_ID, projectId: "p", title: "网页", body: "-",
    mode: "single", status: "done", agentType: "claude", createdAt: stamp, updatedAt: stamp,
  });
  await db.insert(sessions).values({
    id: "s1", taskId: TASK_ID, role: "main", agentType: "claude", executor: "claude",
    cwd: repo, startedAt: stamp,
  });

  // 路由挂在 /api 下，跟 routes.ts 一致，否则前缀切割的那一段验不到真的。
  const api = new Hono();
  mountTaskPageRoutes(api);
  const app = new Hono();
  app.route("/api", api);
  const get = (path: string, headers: Record<string, string> = {}) =>
    app.request(`http://ash.test${path}`, { headers });

  // ── 1. 纯函数：改写规则 ────────────────────────────────────────────────────
  const rewritten = rewriteHtml(
    '<script type="module" crossorigin src="/assets/a.js"></script>'
    + '<img src="./keep.png"><img src="//cdn.example.com/x.png"><a href="https://example.com">e</a>'
    + "<style>b{background:url(/assets/bg.png)}</style>",
    "/api/tasks/T/page/tok/web/dist",
  );
  assert(rewritten.includes('src="/api/tasks/T/page/tok/web/dist/assets/a.js"'), "根路径引用要改写");
  assert(!/crossorigin/i.test(rewritten), "crossorigin 要摘掉");
  assert(rewritten.includes('src="./keep.png"'), "相对引用本来就解得对，不许动");
  assert(rewritten.includes('src="//cdn.example.com/x.png"'), "协议相对的外链不是根路径，不许动");
  assert(rewritten.includes('href="https://example.com"'), "绝对外链不许动");
  assert(rewritten.includes("url(/api/tasks/T/page/tok/web/dist/assets/bg.png)"), "<style> 里的 url() 也要改写");

  // ── 2. 令牌 ───────────────────────────────────────────────────────────────
  const base = taskPageBase(TASK_ID);
  const token = base.slice(base.lastIndexOf("/") + 1);
  assert(token.length >= 20, "令牌得有足够熵，别是个短串");
  assert.equal((await get(`/api/tasks/${TASK_ID}/page/wrongtoken00000000000/web/dist/index.html`)).status, 403);
  // 差一个字符也不行。改最后一位，且**换一个确定不同的字符**——直接写死 "x" 会有 1/64
  // 的概率原本就是 x，那种偶发绿灯比红灯更糟。
  const nudged = token.slice(0, -1) + (token.endsWith("x") ? "y" : "x");
  assert.notEqual(nudged, token);
  assert.equal((await get(`/api/tasks/${TASK_ID}/page/${nudged}/web/dist/index.html`)).status, 403);
  // 令牌按任务分发：拿 A 的令牌读 B 的工作区，必须 403。
  await db.insert(tasks).values({
    id: "OtherTask001", projectId: "p", title: "别的", body: "-",
    mode: "single", status: "done", agentType: "claude", createdAt: stamp, updatedAt: stamp,
  });
  assert.equal((await get(`/api/tasks/OtherTask001/page/${token}/web/dist/index.html`)).status, 403);

  // ── 3. 端到端：Vite 布局 ──────────────────────────────────────────────────
  const page = await get(`${base}/web/dist/index.html`);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(page.headers.get("content-security-policy"), "sandbox allow-scripts allow-forms allow-popups allow-modals");
  const html = await page.text();
  const siteBase = `${base}/web/dist`;
  assert(html.includes(`src="${siteBase}/assets/index-abc.js"`), "站点根要认成 web/dist，不是工作区根");
  assert(html.includes(`href="${siteBase}/assets/index-def.css"`));
  assert(html.includes(`url(${siteBase}/assets/bg.png)`));
  assert(html.includes(`${siteBase}/assets/a.png 1x`) && html.includes(`${siteBase}/assets/b.png 2x`), "srcset 每一条都要改");
  assert(html.includes(`href="${siteBase}/about.html"`));
  assert(!/crossorigin/i.test(html));
  assert(html.includes('src="./local.png"'), "相对引用原样");
  assert(html.includes('fetch("/api/data")'), "脚本体里的地址改不动，也不该去改——这正是要留外部打开出口的原因");

  // 改写后的地址真能取到东西（不是拼了个 404 出来）
  const asset = await get(`${siteBase}/assets/index-abc.js`);
  assert.equal(asset.status, 200);
  assert.equal(asset.headers.get("content-type"), "text/javascript; charset=utf-8");

  // 样式表自己的 url() 也要改写，站点根同样是 web/dist
  const css = await get(`${siteBase}/assets/index-def.css`);
  assert.equal(css.status, 200);
  const cssText = await css.text();
  assert(cssText.includes(`url(${siteBase}/assets/f.woff2)`), "@font-face 的根路径也要改写");
  assert(cssText.includes(`url('${siteBase}/assets/bg.png')`), "带引号的 url() 同样要改，且保住引号");

  // ── 4. 另一种布局：站点根在 html 的上一级 ─────────────────────────────────
  const about = await get(`${base}/site/pages/about.html`);
  assert.equal(about.status, 200);
  assert((await about.text()).includes(`href="${base}/site/css/main.css"`),
    "/css/main.css 的站点根是 site，不是 html 所在的 site/pages");

  // ── 5. CORS：只给不透明源，绝不回显真实来源 ───────────────────────────────
  const opaque = await get(`${siteBase}/assets/index-abc.js`, { origin: "null" });
  assert.equal(opaque.headers.get("access-control-allow-origin"), "null", "沙箱 iframe 的模块脚本非它不可");
  assert.equal(opaque.headers.get("vary"), "Origin");
  const evil = await get(`${siteBase}/assets/index-abc.js`, { origin: "https://evil.example" });
  assert.equal(evil.headers.get("access-control-allow-origin"), null, "带着自己源的站点一律不给 ACAO");
  assert.equal((await get(`${siteBase}/assets/index-abc.js`)).headers.get("access-control-allow-origin"), null);

  // ── 6. 越界 ───────────────────────────────────────────────────────────────
  for (const bad of ["..%2F..%2Fash.db", "web%2Fdist%2F..%2F..%2F..%2Fetc%2Fpasswd"]) {
    assert.equal((await get(`${base}/${bad}`)).status, 400, `越界必须拒：${bad}`);
  }

  // ── 7. 只有网页才给预览入口 ────────────────────────────────────────────────
  assert.equal(taskPageUrlFor(TASK_ID, "web/dist/index.html"), `${base}/web/dist/index.html`);
  assert.equal(taskPageUrlFor(TASK_ID, "out/a.png"), null, "图片不走网页预览那条");
  assert.equal(taskPageUrlFor(TASK_ID, "readme.md"), null);

  console.log("✓ task page: 根路径改写(两种站点根布局)、crossorigin 摘除、令牌按任务、ACAO 只给不透明源、越界拒绝");
} finally {
  await releaseTmpDb();
  rmSync(stage, { recursive: true, force: true });
}
