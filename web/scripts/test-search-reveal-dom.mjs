// ⌘K 打开一条正文 / 会话命中：会话直接落到命中的那一处，把关键词闪几下（search/searchReveal.ts）。
//
// 钉的是用户要的那几件事（2026-11-13）：
//   · 打开时会话还没读完就等它读完再落，不先落到别处再跳；
//   · 同一个词出现好几次时，落在跟 ⌘K 里看到的那段上下文对得上的那一处，不是第一处；
//   · 落下去之后首屏那次「落到最新一条」、后面来的新回复都不把人拽回底部；
//   · 词只在折好的执行过程里时，把那一块打开再落；
//   · 关键词真的被标出来（CSS Custom Highlight），过一会儿自己收掉；
//   · 任务已经开着时再从 ⌘K 打开它也照样落；等的那几秒里读者自己接手了（滚轮、方向键）就作罢，
//     会话还没读完时接手的也算；
//   · 命中的正文画在会话流外面（duet 的议题）也能落；会话里有 İ 时英文词照样不分大小写。
// 跑法：npm -w web run test:search-reveal-dom
import assert from "node:assert/strict";
import { launchChrome, startWebServer } from "./dom-stage.mjs";
import { WAIT_TIMEOUT_MS } from "./wait-until.mjs";

const web = await startWebServer();

let browser;
try {
  browser = await launchChrome();
  const page = await browser.newPage({ viewport: { width: 900, height: 640 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${web.origin}/scripts/fixtures/search-reveal.html`);
  await page.waitForFunction(() => !!window.fixture);

  const feed = page.getByTestId("feed");
  const fold = page.getByTestId("fold");
  // 某一条在会话视口里的位置：0 = 顶边，1 = 底边。
  const placeOf = (id) => feed.evaluate((node, id) => {
    const target = node.querySelector(`[data-item="${id}"] p`).getBoundingClientRect();
    const view = node.getBoundingClientRect();
    return (target.top - view.top) / node.clientHeight;
  }, id);
  const atBottom = () => feed.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight <= 2);
  const highlighted = (name) => page.evaluate((name) => CSS.highlights.has(name), name);
  const currentText = () => page.evaluate(() => {
    const highlight = CSS.highlights.get("search-reveal-current");
    return highlight ? [...highlight].map((range) => range.toString()).join("|") : null;
  });
  const waitLanded = (id) => page.waitForFunction((id) => {
    const node = document.querySelector('[data-testid="feed"]');
    const target = node?.querySelector(`[data-item="${id}"] p`)?.getBoundingClientRect();
    if (!node || !target) return false;
    const top = (target.top - node.getBoundingClientRect().top) / node.clientHeight;
    return top > 0 && top < 0.6;
  }, id, { timeout: WAIT_TIMEOUT_MS });

  // ── 1. 待办先挂上、会话后挂：还没读完时不动，读完了落到上下文对得上的那一处 ──────
  await page.evaluate(() => window.fixture.request("t1", "编辑器", "…每行前面加上对应角色的 icon——与右侧编辑器一致：调度者…"));
  await page.evaluate(() => window.fixture.mount("t1"));
  await feed.waitFor();
  await page.waitForFunction(() => {
    const node = document.querySelector('[data-testid="feed"]');
    return node && node.scrollHeight - node.scrollTop - node.clientHeight <= 2;
  }, null, { timeout: WAIT_TIMEOUT_MS });
  assert.equal(await highlighted("search-reveal-current"), false, "正文还没读完就不该先闪");

  await page.evaluate(() => window.fixture.ready(true));
  await waitLanded("middle");
  assert.equal(await currentText(), "编辑器", "落点那一处被标出来的就是这个词");
  assert.equal(await highlighted("search-reveal"), true, "别的出现处也一起标出来");
  const othersCount = await page.evaluate(() => CSS.highlights.get("search-reveal").size);
  assert.equal(othersCount, 2, "另外两处「编辑器」都标上（原始需求、尾部）");

  // 落下去之后来了新回复：不把人拽回底部。
  const before = await feed.evaluate((node) => node.scrollTop);
  await page.evaluate(() => window.fixture.append());
  await page.waitForFunction(() => document.querySelectorAll('[data-item^="new-"]').length === 1);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await feed.evaluate((node) => node.scrollTop), before, "新回复不该把读者从落点拽走");
  assert.equal(await atBottom(), false);

  // 过一会儿闪烁自己收掉。
  await page.waitForFunction(() => !CSS.highlights.has("search-reveal-current") && !CSS.highlights.has("search-reveal"), null, { timeout: WAIT_TIMEOUT_MS });

  // ── 2. 会话一挂上正文就是现成的（换任务时常见）：首屏那次落底不能盖过落点 ─────────
  await page.evaluate(() => window.fixture.request("t2", "编辑器", "原始需求：设置页里的执行模式编辑器要压成一行。"));
  await page.evaluate(() => window.fixture.mount("t2"));
  // 原始需求本来就在最顶上，刚挂上时位置也对 —— 先等标出来（落地那一刻才标），再看位置。
  await page.waitForFunction(() => CSS.highlights.has("search-reveal-current"), null, { timeout: WAIT_TIMEOUT_MS });
  await waitLanded("requirement");
  assert.equal(await currentText(), "编辑器");
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.ok((await placeOf("requirement")) < 0.6, "首屏落底不该在落点之后又把视口拽到底");

  // ── 3. 词只在折好的执行过程里：打开那一块再落 ─────────────────────────────
  assert.equal(await fold.evaluate((node) => node.open), false);
  await feed.evaluate((node) => { node.scrollTop = node.scrollHeight; });
  await page.evaluate(() => window.fixture.request("t2", "旁路通道", "排查了一下旁路通道的残留进程"));
  await page.waitForFunction(() => document.querySelector('[data-testid="fold"]')?.open, null, { timeout: WAIT_TIMEOUT_MS });
  await page.waitForFunction(() => {
    const node = document.querySelector('[data-testid="feed"]');
    const target = document.querySelector('[data-testid="fold"] p')?.getBoundingClientRect();
    if (!node || !target) return false;
    const top = (target.top - node.getBoundingClientRect().top) / node.clientHeight;
    return top > 0 && top < 0.6;
  }, null, { timeout: WAIT_TIMEOUT_MS });
  assert.equal(await currentText(), "旁路通道", "任务已经开着时再打开也照样落、照样标");

  // ── 4. 正文还没读完时读者自己滚了：待办当场作废，读完了也不再替他挪 ─────────────
  // 作废要在**读完之前**就生效（审查第 1 轮 #2：那时找词的那一侧还没挂上，滚轮没人听）。
  const frames = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const takeOver = async (taskId, move) => {
    await page.evaluate(() => window.fixture.mount(null));
    await page.evaluate(() => window.fixture.ready(false));
    await page.evaluate((taskId) => window.fixture.request(taskId, "编辑器", "原始需求：设置页里的执行模式编辑器要压成一行。"), taskId);
    // 新的一张待办当场收掉上一段还在亮灭的闪烁：后面「没标出来」才说明得了问题。
    assert.equal(await highlighted("search-reveal-current"), false, "发出新待办时上一次的闪烁就该收掉");
    await page.evaluate((taskId) => window.fixture.mount(taskId), taskId);
    await feed.waitFor();
    await page.waitForFunction(() => {
      const node = document.querySelector('[data-testid="feed"]');
      return node && node.scrollTop > 0 && node.scrollHeight - node.scrollTop - node.clientHeight <= 2;
    }, null, { timeout: WAIT_TIMEOUT_MS });
    assert.equal(await page.evaluate((taskId) => window.fixture.pending(taskId), taskId), true, "挂上会话时待办还在");
    await move();
    assert.equal(await page.evaluate((taskId) => window.fixture.pending(taskId), taskId), false, "读者一接手，待办当场作废");
    const held = await feed.evaluate((node) => node.scrollTop);
    await page.evaluate(() => window.fixture.ready(true));
    await frames();
    await frames();
    assert.equal(await feed.evaluate((node) => node.scrollTop), held, "读完了也不该把读者拽去原始需求");
    assert.equal(await highlighted("search-reveal-current"), false);
  };
  await takeOver("t3", async () => {
    const from = await feed.evaluate((node) => node.scrollTop);
    await feed.hover();
    await page.mouse.wheel(0, -200);
    // 滚轮事件是异步送到页面的：等视口真的往上挪了（滚轮事件一定先于这次滚动派发）再看待办。
    await page.waitForFunction((from) => document.querySelector('[data-testid="feed"]').scrollTop < from, from, { timeout: WAIT_TIMEOUT_MS });
  });
  // 方向键是同一个口子（贴底逻辑统一认的「读者接手」），不必另认一遍。
  await takeOver("t4", async () => {
    await page.evaluate(() => (document.activeElement instanceof HTMLElement) && document.activeElement.blur());
    await page.keyboard.press("ArrowUp");
  });

  // ── 5. 命中的正文画在会话流外面（duet 顶上的议题）：在那儿落，打开那一块，会话本身不动 ──
  await page.evaluate(() => window.fixture.mount("t5"));
  await page.waitForFunction(() => {
    const node = document.querySelector('[data-testid="feed"]');
    return node && node.scrollTop > 0 && node.scrollHeight - node.scrollTop - node.clientHeight <= 2;
  }, null, { timeout: WAIT_TIMEOUT_MS });
  assert.equal(await page.getByTestId("topic").evaluate((node) => node.open), false);
  await page.evaluate(() => window.fixture.request("t5", "议题专用词", "…讨论一下议题专用词该怎么落地。"));
  await page.waitForFunction(() => CSS.highlights.has("search-reveal-current"), null, { timeout: WAIT_TIMEOUT_MS });
  assert.equal(await page.getByTestId("topic").evaluate((node) => node.open), true, "议题那一块被打开");
  assert.equal(await currentText(), "议题专用词");
  assert.equal(
    await page.evaluate(() => [...CSS.highlights.get("search-reveal-current")][0].startContainer.parentElement.dataset.testid),
    "topic-full",
    "落在完整的议题上，不是摘要条里截断的那一份",
  );
  assert.equal(await atBottom(), true, "落点不在会话流里时，会话本身不动");

  // ── 6. 会话里有 İ（小写后长度会变）：别的英文词照样不分大小写 ─────────────────
  await page.evaluate(() => window.fixture.request("t5", "mixedcase", ""));
  await page.waitForFunction(() => {
    const highlight = CSS.highlights.get("search-reveal-current");
    return !!highlight && [...highlight][0].toString() === "MixedCase";
  }, null, { timeout: WAIT_TIMEOUT_MS });

  assert.deepEqual(errors, []);
  console.log("search reveal DOM regression passed");
} finally {
  await browser?.close();
  await web.close();
}
