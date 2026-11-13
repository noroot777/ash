// 过了保留期被删掉的审查截图：报告里引用它的地方、截图条上，都要如实说「已过保留期」——不是
// 裂图，也不是「图取不到 + 再试一次」（那句说的是临时故障，这张图不会回来）。登记晚于首次
// 渲染才到时也要跟着改过来；页面没读过那个任务的状态时按证据地址现取（审查第 1 轮 F2）。
// 这份副本会过时（审查第 2 轮）：清单取过之后才清扫、过期之后图又回来、旧清单迟到——都要跟着
// 服务端的事实走，新旧只认修订号。
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { launchChrome, viteCacheDir } from "./dom-stage.mjs";

const PIXELS = '<svg xmlns="http://www.w3.org/2000/svg" width="6" height="6"><rect width="6" height="6" fill="#4b7"/></svg>';
// 假服务端：每个任务一个「当前事实」（修订号 + 过期名单），图片在名单里就 410，否则吐字节；
// 清单接口按请求到达那一刻的事实回答，`hold` 里挂着的任务等测试放行才把那份（旧）回答发出去。
const world = {
  T9: { version: 5, expired: ["a.png", "c.png", "shots/b.png"] },
  T8: { version: 2, expired: ["late.png"], first: { version: 1, expired: [] } }, // 第一次取到的是清扫前的
  T7: { version: 1, expired: [] },
  T6: { version: 1, expired: ["r.png"] },
  T5: { version: 1, expired: [] },
};
const hold = {};
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
      vite.middlewares.use("/api/tasks", async (req, res) => {
        const url = new URL(req.url ?? "/", "http://fixture.invalid");
        const listed = /^\/([^/]+)\/free-workflow\/expired-screenshots$/.exec(url.pathname)?.[1];
        if (listed) {
          listRequests[listed] = (listRequests[listed] ?? 0) + 1;
          const task = world[listed];
          const facts = listRequests[listed] === 1 && task.first ? task.first : task;
          const body = JSON.stringify({ stateVersion: facts.version, rounds: [{ runId: `R${listed.slice(1)}`, round: 1, names: [...facts.expired] }] });
          if (hold[listed]) await hold[listed].promise;
          res.setHeader("content-type", "application/json");
          res.end(body);
          return;
        }
        const task = world[/^\/([^/]+)\//.exec(url.pathname)?.[1] ?? ""];
        const name = (url.searchParams.get("name") ?? "").replace(/\\/g, "/");
        if (task?.expired.includes(name)) {
          res.statusCode = 410;
          res.setHeader("content-type", "application/json");
          res.setHeader("cache-control", "no-store"); // 跟服务端同一个头：图回来之后不许拿缓存里的 410
          res.end('{"error":"已过保留期"}');
          return;
        }
        res.setHeader("content-type", "image/svg+xml");
        res.end(PIXELS);
      });
    },
  }],
});

const deferred = () => {
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  return { promise, release };
};
async function until(check, what) {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`等不到：${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
// T5 的第一趟清单（v1、空）先扣着，等整份状态 v3 报了过期再放行。
hold.T5 = deferred();

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

  // ── 清单取过（空的）之后才清扫：点开链接进灯箱，说「已过保留期」，不是裂图（审查第 2 轮第 1 条）──
  const link = page.locator(".link-report");
  await link.getByRole("link", { name: "查看截图" }).waitFor();
  await until(() => listRequests.T7 >= 1, "T7 的清单取过一次");
  assert.equal(listRequests.T7, 1);
  world.T7 = { version: 2, expired: ["x.png"] };
  await link.getByRole("link", { name: "查看截图" }).click();
  await page.locator(".image-preview-lightbox__gone").waitFor();
  assert.equal(await page.locator(".image-preview-lightbox img").count(), 0, "灯箱里不摆裂图");
  assert.equal(await page.locator(".image-preview-lightbox .image-zoom-controls").count(), 0, "没有图也就没有缩放");
  await page.keyboard.press("Escape");
  await link.locator(".task-markdown-image-missing-tag", { hasText: "已过保留期" }).waitFor();
  assert.equal(await link.getByRole("link", { name: "查看截图" }).count(), 0, "正文那条链接也跟着改口");

  // ── 过期之后图又回来了：关掉报告再打开，要把图画出来 ──
  const reopen = page.locator(".reopen-report");
  await reopen.locator(".task-markdown-image-missing-tag", { hasText: "已过保留期" }).waitFor();
  world.T6 = { version: 2, expired: [] };
  const requestsBefore = listRequests.T6;
  await page.evaluate(() => window.__toggleT6());
  await reopen.locator(".task-markdown").waitFor({ state: "detached" });
  await page.evaluate(() => window.__toggleT6());
  await until(() => listRequests.T6 > requestsBefore, "重新打开报告时重取 T6 的清单");
  await page.waitForFunction(() => {
    const img = document.querySelector('.reopen-report img[src*="r.png"]');
    return !!img && img.complete && img.naturalWidth > 0;
  });
  assert.equal(await reopen.locator(".task-markdown-image-missing").count(), 0, "回来了的图不能一直说过期");

  // ── 旧清单迟到：整份状态 v3 先报过期，更早发出的那趟 v1 空清单才到——不许盖掉（审查第 2 轮第 2 条）──
  const race = page.locator(".race-report");
  await until(() => listRequests.T5 >= 1, "T5 的第一趟清单已经发出、被扣着");
  world.T5 = { version: 3, expired: ["z.png"] };
  await page.evaluate(() => window.__recordT5());
  await race.locator(".task-markdown-image-missing-tag", { hasText: "已过保留期" }).waitFor();
  hold.T5.release();
  await page.waitForTimeout(500);
  assert.equal(await race.locator(".task-markdown-image-missing-tag", { hasText: "已过保留期" }).count(), 1, "迟到的旧清单不能撤掉过期提示");
  assert.equal(await race.locator('img[src*="z.png"]').count(), 0);

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
