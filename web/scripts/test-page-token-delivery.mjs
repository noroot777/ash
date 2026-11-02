// 真人动作凭据的**交付面**:凡是交出这个应用 HTML 文档的入口,文档上都得有凭据。
//
// 后端自己那条路(`serveSpa`)早就盖了,缺的是 vite 这两条 —— `npm -w web run dev`(本仓
// 说「起个预览」就是它)和 `npm -w web run preview`。缺了之后页面上「放开回合占位」「杀 CUA
// 旁路会话」这类开关一律 403,而它给的恢复路径「重新加载页面」也救不回来(本轮审查 F2)。
//
// 为什么非得在这里测:`test:turn-remedy-dom` 用的是一份自带 `page-token-1` 的 fixture 文档
// (它要测的是 meta→请求头→轮换那条前端链路),**那份 fixture 一个字都证明不了真实文档上
// 有没有凭据**。所以这一条打的是 vite 真正交出去的那两份文档,凭据必须来自后端。
//
// 还钉**路由归属**(第 2 轮审查 F1):preview 那段中间件排在代理前面、先看见所有请求,上一版
// 据此把 `/api/projects`、`/preview/<id>/` 也当文档发了,整页读不出数据最后白屏。所以这里的
// 不变量是两头的:**该归代理的请求,状态码、内容类型、字节都不许被这一段改动**;**真正的
// 应用文档必须带凭据**。只验「文档上有 token」证不出前者 —— 那正是上一版通过登记的盲区。
import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

// 盖凭据与核验凭据都用**服务端那一份真货**(`stampHumanActionToken` / `consumeHumanActionToken`):
// 测的是「vite 交出的文档上那一份,后端真的认」,所以这两头一个字都不许自己抄 —— 抄一遍形状
// 就变成在测抄件(那正是 fixture 里写死 `page-token-1` 的毛病)。
const { HUMAN_ACTION_TOKEN_META: META, consumeHumanActionToken, stampHumanActionToken } =
  await import("../../server/src/auth/human-action-token.ts");

const tokensIn = (html) => [...html.matchAll(new RegExp(`<meta[^>]*\\bname="${META}"[^>]*>`, "g"))]
  .map((m) => /content="([^"]+)"/.exec(m[0])?.[1] ?? "");
/** 这一份后端认不认 —— 认的话顺带烧掉它(一次性,正是真实链路里的那一下)。 */
const spendable = (html) => {
  const tokens = tokensIn(html);
  assert.equal(tokens.length, 1, `文档上应当有且只有一份凭据,实际 ${tokens.length} 份`);
  return consumeHumanActionToken(tokens[0]);
};

// 假后端按路径分流:文档一条、数据一条、流式一条、预览一条 —— 后三条是**代理该拿到的**那些,
// 用来钉「页面交付层没把它们截走」。盖凭据的仍是服务端的真函数。
const PROJECTS = JSON.stringify([{ id: "review-project", name: "backend project" }]);
let served = 0;
let serving = true;
const reached = [];
const backend = createHttpServer((req, res) => {
  const path = (req.url ?? "/").split("?")[0];
  reached.push(`${req.method} ${path}`);
  if (path === "/api/projects") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(req.method === "POST" ? JSON.stringify({ created: true }) : PROJECTS);
    return;
  }
  if (path === "/api/events") { // 流式:内容类型必须原样穿过去
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" });
    res.end("event: hello\ndata: 1\n\n");
    return;
  }
  if (path.startsWith("/preview/")) { // 不存在的预览:后端那句 404 要原样交到用户面前
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("preview not found");
    return;
  }
  if (!serving) { // 后端起着但交不出文档(它那边没有 web/dist)
    res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
    res.end("Ash web build not found — run `npm -w web run build`.");
    return;
  }
  served += 1;
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(stampHumanActionToken("<!doctype html><html><head><title>backend</title></head><body></body></html>"));
});
await new Promise((done) => backend.listen(0, "127.0.0.1", done));
process.env.ASH_PROXY = `http://127.0.0.1:${backend.address().port}`;

const { createServer, preview, resolveConfig } = await import("vite");

const dist = mkdtempSync(join(tmpdir(), "ash-page-token-"));
writeFileSync(join(dist, "index.html"), "<!doctype html><html><head><title>built</title></head><body></body></html>");
mkdirSync(join(dist, "assets"));
writeFileSync(join(dist, "assets", "app.js"), "export const built = true;\n");

/** 浏览器导航发的那种 accept —— SPA 深链只在这一下才算「要一份文档」。 */
const asDocument = { accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" };

let dev;
let previewServer;
try {
  // ── ① dev:交出的每一份文档都带着后端那一份凭据,而且一份一个号 ──────────────
  // 不开依赖扫描:这一条只取文档,不加载任何模块;扫描器在关服务时还在跑,会吐一堆
  // 「Failed to scan for dependencies」的收尾噪音(esbuild 被连带停掉),跟本条无关。
  dev = await createServer({
    root, logLevel: "error",
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  await dev.listen();
  const devOrigin = `http://127.0.0.1:${dev.httpServer.address().port}`;
  const first = await fetch(`${devOrigin}/`);
  const firstHtml = await first.text();
  assert.equal(first.status, 200);
  const firstTokens = tokensIn(firstHtml);
  assert.equal(firstTokens.length, 1, "dev 文档上必须有且只有一份凭据");
  assert.equal(consumeHumanActionToken(firstTokens[0]), true, "而且后端真的认它 —— 这才叫接上了");
  assert.equal(consumeHumanActionToken(firstTokens[0]), false, "一次性:同一串按第二下不算");
  const second = await fetch(`${devOrigin}/tasks/abc`).then((r) => r.text());
  assert.notEqual(tokensIn(second)[0], firstTokens[0], "每交一份文档换一份,不许两个页面共用一串");
  assert.equal(spendable(second), true, "第二份同样是后端认的");

  // ── ② 文档自己带着一份时不叠第二份 ─────────────────────────────────────────
  // `fromDocument()` 读的是第一个 meta,叠上去的那一份永远读不到,却会让「页面上有几份
  // 凭据」变成一个要靠顺序推理的问题。回归 fixture 就是这种自带一份的文档。
  const fixture = await fetch(`${devOrigin}/scripts/fixtures/turn-remedy.html`).then((r) => r.text());
  assert.deepEqual(tokensIn(fixture), ["page-token-1"], "自带凭据的文档原样交出,不叠第二份");
  assert.equal(served, 2, "也不该为它白跑一趟后端(白跑 = 白烧一份凭据)");

  // ── ③ 取不到就什么都不盖(绝不编一份假的)────────────────────────────────────
  serving = false;
  const noDist = await fetch(`${devOrigin}/`);
  assert.equal(noDist.status, 200, "取不到凭据不影响页面打开");
  assert.deepEqual(tokensIn(await noDist.text()), [], "后端交不出文档时一个字都不盖");

  // ── ④ preview:dist/index.html 是静态发的,钩子不过那条路,得另挂一段 ──────────
  serving = true;
  previewServer = await preview({
    root, logLevel: "error",
    build: { outDir: dist },
    preview: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  const previewOrigin = `http://127.0.0.1:${previewServer.httpServer.address().port}`;
  const shown = await fetch(`${previewOrigin}/`);
  const shownHtml = await shown.text();
  assert.equal(spendable(shownHtml), true, "preview 交出的文档同样要带一份后端认的凭据");
  assert.match(shownHtml, /<title>built<\/title>/, "交出去的还得是那份构建产物,不是另造一份文档");
  assert.match(shown.headers.get("cache-control") ?? "", /no-cache/,
    "带凭据的文档不许被缓存 —— 端出一份用过的凭据,开关就按不动了");
  assert.equal(spendable(await fetch(`${previewOrigin}/tasks/abc`, { headers: asDocument }).then((r) => r.text())), true,
    "SPA 深链也是一份文档");
  assert.equal(spendable(await fetch(`${previewOrigin}/index.html`).then((r) => r.text())), true,
    "直接点名 /index.html 也得有凭据 —— 少这一条,照着它起的页面就按不动开关");
  const asset = await fetch(`${previewOrigin}/nope.js`);
  assert.doesNotMatch(await asset.text(), new RegExp(META), "带扩展名的请求不走文档那条路");

  // ── ④b 路由归属:该归代理的请求,这一段一个字都不许动(第 2 轮审查 F1)─────────
  // 上一版的判据是「最后一段有没有点号」,于是 `/api/projects` 这种没点号的路径被当成文档,
  // 在代理之前就把首页发了回去 —— 页面读不出任何数据、最后白屏,而每个请求都是 200。
  const reachedBefore = reached.length;
  const data = await fetch(`${previewOrigin}/api/projects`);
  assert.equal(data.status, 200, "代理该拿到的请求,状态码不许被页面交付层改掉");
  assert.match(data.headers.get("content-type") ?? "", /application\/json/,
    `内容类型也不许改 —— 实际:${data.headers.get("content-type")}`);
  assert.equal(await data.text(), PROJECTS, "字节要和后端那一份一模一样");
  const stream = await fetch(`${previewOrigin}/api/events`);
  assert.match(stream.headers.get("content-type") ?? "", /text\/event-stream/,
    "流式连接同样原路出去,不许被换成一份 HTML");
  await stream.text();
  const absent = await fetch(`${previewOrigin}/preview/absent/`, { headers: asDocument });
  assert.equal(absent.status, 404, "不存在的预览要保住后端那句 404,不能被首页盖成 200");
  assert.equal(await absent.text(), "preview not found");
  const posted = await fetch(`${previewOrigin}/api/projects`, { method: "POST" });
  assert.equal(await posted.text(), JSON.stringify({ created: true }), "写动作照旧原路到后端");
  assert.deepEqual(reached.slice(reachedBefore),
    ["GET /api/projects", "GET /api/events", "GET /preview/absent/", "POST /api/projects"],
    "这四条必须**真的到过后端** —— 只看响应长得对,截在本地的假首页也可能长得对");
  const built = await fetch(`${previewOrigin}/assets/app.js`);
  assert.match(built.headers.get("content-type") ?? "", /javascript/, "dist 里的真实资源归静态中间件");
  assert.doesNotMatch(await built.text(), new RegExp(META));
  const json = await fetch(`${previewOrigin}/tasks/abc`, { headers: { accept: "application/json" } });
  assert.equal(json.status, 404, "没配代理、又要 JSON 的那一下,不该收到一份首页冒充数据");

  // ── ⑤ 绝不进 build ────────────────────────────────────────────────────────────
  // 打进 `web/dist/index.html` 的凭据是一份死号,而它排在 `serveSpa` 追加的那一份**前面**,
  // 页面读到的就是它 —— 那会把后端自己交付的每一个页面也一起弄坏。
  const forBuild = await resolveConfig({ root, logLevel: "error" }, "build");
  assert.equal(forBuild.plugins.some((p) => p.name === "ash-page-token"), false, "build 里不许有这个插件");
  const forServe = await resolveConfig({ root, logLevel: "error" }, "serve");
  assert.equal(forServe.plugins.some((p) => p.name === "ash-page-token"), true, "serve 里必须有");

  console.log("✓ 页面凭据交付面:dev / preview 两条文档路都接上了后端那一份;代理该拿到的请求原样穿过;build 一个字不盖");
} finally {
  await dev?.close();
  await previewServer?.close();
  backend.close();
  rmSync(dist, { recursive: true, force: true });
}
