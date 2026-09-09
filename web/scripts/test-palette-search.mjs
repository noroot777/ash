// ⌘K 搜索面板的交互回归：选中项跟着键盘走进视线、鼠标划过不改选中、单击选中双击打开、
// 排序档换了请求也跟着换。夹具在 fixtures/palette-search.tsx。
// 跑：npm -w web run test:palette-search
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";
import { chromeLaunchOptions } from "./chrome-path.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const server = await createServer({
  root,
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0, strictPort: false },
});

let browser;
try {
  await server.listen();
  const address = server.httpServer?.address();
  assert(address && typeof address === "object", "Vite test server did not expose a port");

  browser = await chromium.launch(await chromeLaunchOptions());
  const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
  await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/palette-search.html`);

  const results = page.locator(".palette-results");
  const selected = page.locator('.palette-results [aria-selected="true"]');
  const selectedIndex = () => selected.getAttribute("data-palette-index");
  // 选中行是否整个落在结果列的可视区里。差 1px 都算跑出去了 —— 用户看不到就是看不到。
  const selectedVisible = () => selected.evaluate((node) => {
    const list = node.closest(".palette-results");
    const row = node.getBoundingClientRect();
    const box = list.getBoundingClientRect();
    return row.top >= box.top - 1 && row.bottom <= box.bottom + 1;
  });

  await page.locator(".palette-input input").fill("链接");
  await page.locator('.palette-results [data-palette-index="0"]').waitFor();
  // 「链接」谁的命令名都不沾，于是列表里 31 行全是搜索命中（30 条任务 + 1 条随手记），
  // 索引从 0 开始。列表远比视口高 —— 按方向键一定会走出可视区，这正是这条用例要挡的现象。
  await page.waitForFunction(() => document.querySelectorAll(".palette-results [data-palette-index]").length === 31);
  assert.ok(
    await results.evaluate((node) => node.scrollHeight > node.clientHeight + 200),
    "结果列必须长到能滚动，否则「选中项滚出视线」这件事根本复现不了",
  );

  // ── 1. 键盘往下走，选中项始终在视线内 ────────────────────────────────
  for (let step = 1; step <= 30; step += 1) {
    await page.keyboard.press("ArrowDown");
    assert.equal(await selectedIndex(), String(step), "每按一下就该往下挪一行");
    assert.ok(await selectedVisible(), `按到第 ${step} 行时它跑出了可视区`);
  }
  const scrolledDown = await results.evaluate((node) => node.scrollTop);
  assert.ok(scrolledDown > 0, "列表应该已经跟着滚下去了");

  // 往回走同理：向上滚才能把它带回来。
  for (let step = 29; step >= 0; step -= 1) {
    await page.keyboard.press("ArrowUp");
    assert.equal(await selectedIndex(), String(step));
    assert.ok(await selectedVisible(), `退回第 ${step} 行时它跑出了可视区`);
  }
  // 退回第一行时列表也跟着滚回顶部。差的那几十像素是「任务」这个分节标题的高度：
  // block:"nearest" 只保证选中行整个可见，不会为了露出标题多滚一截。
  assert.ok(await results.evaluate((node) => node.scrollTop) < 60, "一路退回第一行时列表也该回到顶部");

  // ── 2. 鼠标划过不改选中 ──────────────────────────────────────────────
  const rowAt = (index) => page.locator(`.palette-results [data-palette-index="${index}"]`);
  await rowAt(3).hover();
  assert.equal(await selectedIndex(), "0", "指针经过某一行不代表用户在挑它，选中态不该跟着鼠标跑");

  // ── 3. 搜索结果：单击只选中，双击才打开 ──────────────────────────────
  // 相关度档里同档位按更新时间倒序，所以第 4 行（索引 3）是标题档里第 4 新的 hit-16。
  const firstHit = 3;
  assert.equal(await rowAt(firstHit).locator(".truncate").first().innerText(), "链接命中 16");
  await rowAt(firstHit).click();
  assert.equal(await selectedIndex(), String(firstHit), "单击选中它");
  assert.equal(await page.locator("#opened").getAttribute("data-opened"), "", "单击不该打开任务");
  // 焦点留在输入框：点完还能接着按方向键。
  assert.equal(await page.evaluate(() => document.activeElement?.tagName), "INPUT");
  await page.keyboard.press("ArrowDown");
  assert.equal(await selectedIndex(), String(firstHit + 1), "点完之后方向键接着从选中那行往下走");

  await rowAt(firstHit).dblclick();
  assert.equal(
    await page.locator("#opened").getAttribute("data-opened"),
    "hit-16",
    "双击才打开任务，且打开的是被双击的那条",
  );

  // ── 4. 排序档：换档要真的换请求，列表跟着换第一条 ──────────────────────
  const requests = () => page.evaluate(() => window.__searchRequests.slice());
  const labels = () => page.locator(".palette-results .palette-label").allInnerTexts();
  assert.deepEqual(await requests(), ["relevance"], "默认按相关度搜");
  // 相关度档：任务在随手记之前，任务内部标题档在前（会话档那 10 条更新更近，仍被压到
  // 后面），档内按更新时间倒序。两类各挂一个分节标题。
  assert.equal(await rowAt(0).locator(".truncate").first().innerText(), "链接命中 19");
  assert.equal(await rowAt(30).locator(".truncate").first().innerText(), "随手记里的链接");
  assert.deepEqual(await labels(), ["任务", "随手记"]);

  await page.locator(".palette-sort").click();
  await page.waitForFunction(() => window.__searchRequests.includes("recent"));
  assert.equal(await page.locator(".palette-sort").innerText(), "排序 · 最近更新");
  // 最近更新档：整份列表一条时间轴 —— 最新的随手记排第一，任务和随手记混排，于是
  // 「任务 / 随手记」两个分区标题也没了。
  await page.waitForFunction(() =>
    document.querySelector('[data-palette-index="0"]')?.innerText.includes("随手记里的链接"));
  assert.equal(await rowAt(1).locator(".truncate").first().innerText(), "链接命中 29");
  assert.deepEqual(await labels(), ["按更新时间"]);
  assert.equal(await selectedIndex(), "0", "换档后列表整个重排，选中回到第一行");
  assert.equal(await page.evaluate(() => document.activeElement?.tagName), "INPUT", "点开关不该把焦点从输入框拿走");

  console.log("palette search tests passed");
} finally {
  await browser?.close();
  await server.close();
}
