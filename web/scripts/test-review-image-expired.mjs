// 过了保留期被删掉的审查截图：报告里引用它的地方、截图条上，都要如实说「已过保留期」——不是
// 裂图，也不是「图取不到 + 再试一次」（那句说的是临时故障，这张图不会回来）。登记晚于首次
// 渲染才到时也要跟着改过来；页面没读过那个任务的状态时按证据地址现取（审查第 1 轮 F2），清单
// 过时的话图片一取不到就重取。
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { launchChrome, viteCacheDir } from "./dom-stage.mjs";

const PIXELS = '<svg xmlns="http://www.w3.org/2000/svg" width="6" height="6"><rect width="6" height="6" fill="#4b7"/></svg>';
const EXPIRED = new Set(["a.png", "shots/b.png", "c.png", "late.png"]);
const listRequests = {};

const root = fileURLToPath(new URL("..", import.meta.url));
const server = await createServer({
  root,
  cacheDir: viteCacheDir("review-image-expired"),
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0, strictPort: false },
  plugins: [{
    name: "fixture-review-files",
    configureServer(vite) {
      // 跟服务端同一个口径：删掉的回 410，还在的吐字节。
      vite.middlewares.use("/api/tasks", (req, res) => {
        const url = new URL(req.url ?? "/", "http://fixture.invalid");
        const list = /^\/([^/]+)\/free-workflow\/expired-screenshots$/.exec(url.pathname)?.[1];
        if (list) {
          listRequests[list] = (listRequests[list] ?? 0) + 1;
          // T8 第一次取时清扫还没跑：清单是空的；之后再取才有。
          const rounds = list === "T9"
            ? [{ runId: "R9", round: 1, names: ["a.png", "c.png", "shots/b.png"] }]
            : listRequests[list] > 1 ? [{ runId: "R8", round: 1, names: ["late.png"] }] : [];
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ rounds }));
          return;
        }
        const name = url.searchParams.get("name") ?? "";
        if (EXPIRED.has(name) || EXPIRED.has(name.replace(/\\/g, "/"))) {
          res.statusCode = 410;
          res.setHeader("content-type", "application/json");
          res.end('{"error":"已过保留期"}');
          return;
        }
        res.setHeader("content-type", "image/svg+xml");
        res.end(PIXELS);
      });
    },
  }],
});

let browser;
try {
  await server.listen();
  const address = server.httpServer?.address();
  assert(address && typeof address === "object", "Vite test server did not expose a port");
  browser = await launchChrome();
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/review-image-expired.html`);

  const report = page.locator(".expired-report");
  await page.waitForFunction(() => document.querySelectorAll(".expired-report .task-markdown-image-missing").length === 4
    && [...document.querySelectorAll(".expired-report .task-markdown-image-missing-tag")].every((tag) => tag.textContent === "已过保留期"));
  const notes = await report.locator(".task-markdown-image-missing").allInnerTexts();
  assert.match(notes[0], /已过保留期[\s\S]*复现截图 · a\.png/, "内嵌图：原来那句说明和地址都留着");
  assert.match(notes[1], /已过保留期[\s\S]*第二张 · shots\/b\.png/, "链接：链接文字留着");
  assert.match(notes[2], /已过保留期[\s\S]*绝对路径/, "绝对路径改写过来的那一种也认得出");
  assert.match(notes[3], /已过保留期[\s\S]*别名/, "round=01、反斜杠子路径认作同一张");
  // 首屏取一次；图片在清单回来之前就 410 的话再补一趟。不许按图片张数、按渲染次数一直取。
  assert.ok(listRequests.T9 >= 1 && listRequests.T9 <= 2, `没读过状态的任务按证据地址现取清单（取了 ${listRequests.T9} 次）`);
  assert.equal(await report.locator(".task-markdown-image-retry").count(), 0, "不会回来的图不给「再试一次」");
  assert.equal(await report.locator('img[src*="a.png"], img[src*="c.png"]').count(), 0, "不留裂图");
  assert.equal(await report.locator('a[href*="b.png"]').count(), 0, "不留一个点开是空灯箱的链接");
  await page.waitForFunction(() => {
    const img = document.querySelector('.expired-report img[src*="kept.png"]');
    return !!img && img.complete && img.naturalWidth > 0;
  });

  // 清单过时：第一次取到的是空的，图片 410 之后重取，改口成「已过保留期」，不留「再试一次」。
  await page.waitForFunction(() => document.querySelector(".stale-report .task-markdown-image-missing-tag")?.textContent === "已过保留期");
  assert.equal(await page.locator(".stale-report .task-markdown-image-retry").count(), 0);
  assert.ok(listRequests.T8 >= 2, "图片取不到时重取了清单");

  const partial = page.locator(".strip-partial .review-screenshot-strip");
  assert.equal(await partial.locator("header em").innerText(), "1");
  assert.equal(await partial.locator("header small").innerText(), "另 3 张已过保留期");
  assert.equal(await partial.locator(".review-screenshot-strip__item img").count(), 1);

  const all = page.locator(".strip-all .review-screenshot-strip");
  assert.equal(await all.locator("header small").innerText(), "3 张已过保留期", "全删了也要说清这一轮原来有截图");
  assert.equal(await all.locator("header em").count(), 0, "不报一个 0");
  assert.equal(await all.locator(".review-screenshot-strip__rail").count(), 0, "不留一条空缩略图条");

  console.log("过期审查截图显示回归通过");
} finally {
  await browser?.close();
  await server.close();
}
