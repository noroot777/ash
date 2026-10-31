// 真人动作凭据的**交付面**:凡是交出这个应用 HTML 文档的入口,文档上都得有凭据。
//
// 后端自己那条路(`serveSpa`)早就盖了,缺的是 vite 这两条 —— `npm -w web run dev`(本仓
// 说「起个预览」就是它)和 `npm -w web run preview`。缺了之后页面上「放开回合占位」「杀 CUA
// 旁路会话」这类开关一律 403,而它给的恢复路径「重新加载页面」也救不回来(本轮审查 F2)。
//
// 为什么非得在这里测:`test:turn-remedy-dom` 用的是一份自带 `page-token-1` 的 fixture 文档
// (它要测的是 meta→请求头→轮换那条前端链路),**那份 fixture 一个字都证明不了真实文档上
// 有没有凭据**。所以这一条打的是 vite 真正交出去的那两份文档,凭据必须来自后端。
import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

// 假后端只负责「交出一份页面文档」这一件事 —— 盖凭据的是服务端的真函数。
let served = 0;
let serving = true;
const backend = createHttpServer((_req, res) => {
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
  assert.equal(spendable(await fetch(`${previewOrigin}/tasks/abc`).then((r) => r.text())), true,
    "SPA 深链也是一份文档");
  const asset = await fetch(`${previewOrigin}/nope.js`);
  assert.doesNotMatch(await asset.text(), new RegExp(META), "带扩展名的请求不走文档那条路");

  // ── ⑤ 绝不进 build ────────────────────────────────────────────────────────────
  // 打进 `web/dist/index.html` 的凭据是一份死号,而它排在 `serveSpa` 追加的那一份**前面**,
  // 页面读到的就是它 —— 那会把后端自己交付的每一个页面也一起弄坏。
  const forBuild = await resolveConfig({ root, logLevel: "error" }, "build");
  assert.equal(forBuild.plugins.some((p) => p.name === "ash-page-token"), false, "build 里不许有这个插件");
  const forServe = await resolveConfig({ root, logLevel: "error" }, "serve");
  assert.equal(forServe.plugins.some((p) => p.name === "ash-page-token"), true, "serve 里必须有");

  console.log("✓ 页面凭据交付面:dev / preview 两条文档路都接上了后端那一份,build 一个字不盖");
} finally {
  await dev?.close();
  await previewServer?.close();
  backend.close();
  rmSync(dist, { recursive: true, force: true });
}
