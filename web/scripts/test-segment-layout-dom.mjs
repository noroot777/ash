// 画不出东西的通知,不许在正文后面多出一块占位的东西。
//
// 这一条单独成立一份测试,因为它只在**真实渲染结构**里才存在:子智能体的后台通知在正文
// 之后被切成自己的一段,那一段一个字都画不出来(渲染侧四个入口都先 filter 一道
// isVisibleExecutionEvent),可上一版照样给它开一个空 `<section>` 并吃掉 7px 间距 ——
// scrollHeight 涨 7px,底边一下移,停在离底 79px 正在读的人就被贴底逻辑拽到底(审查第 6
// 轮 F1)。
//
// 所以这里用真实的 AgentTurnBody、真实的 CSS、真实的 contentSegments,量的是
// 「正文顶层块数、总高、滚动位置」这三个数,而不是手工拼几个空 div。
//
// 量「顶层块数」而不是段数:正文现在整条消息只解析一次,执行步骤按节点偏移插进顶层块之间
// (见 markdownLayout),压根没有 `.task-agent-segment` 这一层了。画不出东西的步骤因此连
// 一个节点都不进 DOM —— 这个数就是那件事的直接读数。
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { chromeLaunchOptions } from "./chrome-path.mjs";
import { createServer } from "vite";

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
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/segment-layout.html`);
  await page.locator("#feed").waitFor();

  const feed = page.locator("#feed");
  const flush = () => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  const metrics = () => feed.evaluate((element) => ({
    top: Math.round(element.scrollTop),
    height: element.scrollHeight,
    distance: Math.round(element.scrollHeight - element.scrollTop - element.clientHeight),
    sections: element.querySelectorAll(".task-markdown > *").length,
    text: element.innerText,
  }));
  const press = async (testId) => { await page.getByTestId(testId).click(); await flush(); };
  /* 停在离底 gap 像素且**仍在跟随状态** —— 必须用真实的「向下滚」走过去。向上滚是
     「我要读历史」,会主动脱离跟随,那样停下来测到的是另一回事(不跟随当然不会被拽,
     断言会假通过)。 */
  const parkByWheel = async (gap) => {
    await feed.evaluate((element) => element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight - 300));
    await flush();
    await feed.hover();
    let guard = 0;
    while ((await metrics()).distance > gap && guard++ < 80) {
      await page.mouse.wheel(0, 20);
      await flush();
    }
    return metrics();
  };

  await flush();
  const first = await metrics();
  assert.ok(first.height > first.distance, "夹具假设有误:内容没撑出滚动条");
  assert.equal(first.distance, 0, "首屏没有落到最新一段");

  /* 平铺那条路径(这一回合还在飞)—— 见 turnDocument 的 live 分支。 */
  const quietChecks = async (state) => {
    // ① 正文之后来一条画不出来的通知:段数、总高、滚动位置,三个数一个都不许动。
    const parked = await parkByWheel(40);
    assert.ok(parked.distance > 2 && parked.distance <= 40, `[${state}] 没能停在离底一小段:${parked.distance}`);
    await press("hidden-notice");
    const quiet = await metrics();
    assert.equal(quiet.text, parked.text, `[${state}] 夹具假设有误:这条通知改变了屏幕上的字`);
    assert.equal(quiet.sections, parked.sections, `[${state}] 画不出东西的通知多出了一个顶层块`);
    assert.equal(quiet.height, parked.height, `[${state}] 屏幕没变化,scrollHeight 却涨了(空段的间距)`);
    assert.equal(quiet.top, parked.top, `[${state}] 屏幕没变化,阅读位置却被挪了`);

    // ② 连来三条也一样:不会攒出高度。
    await press("hidden-notice");
    await press("hidden-notice");
    const stillQuiet = await metrics();
    assert.equal(stillQuiet.height, parked.height, `[${state}] 多条通知攒出了高度`);
    assert.equal(stillQuiet.top, parked.top, `[${state}] 多条通知把人挪走了`);
  };

  await quietChecks("平铺");

  /* ③ 真工具调用是画得出来的:照旧切出自己的段、跟过去 —— 防的是为了修 ① 把真内容
     一起挡掉。 */
  await parkByWheel(40);
  const beforeTool = await metrics();
  await press("visible-tool");
  const afterTool = await metrics();
  assert.ok(afterTool.sections > beforeTool.sections, "真工具调用没有在正文里占到自己的位置");
  assert.equal(afterTool.distance, 0, "真工具调用来了,视口没跟过去");

  // ④ 正文续写同样要跟。
  await parkByWheel(40);
  await press("more-text");
  assert.equal((await metrics()).distance, 0, "正文在长,视口没跟过去");

  /* ⑤ 收口之后那条路径(AgentTurnBody 的过程块)。注意折叠块**关着的时候里面
     不占高度**,所以必须先点开 —— 展开的过程块里同样不许因为纯通知多出空段。 */
  await press("settle");
  assert.equal(await page.getByTestId("running-state").innerText(), "settled");
  const fold = page.locator(".task-turn-process > summary");
  await fold.waitFor();
  await fold.click();
  await flush();
  const opened = await metrics();
  assert.ok(opened.sections > 0, "夹具假设有误:过程块展开后正文里一个块都没有");
  await quietChecks("展开过程");

  assert.deepEqual(errors, [], "页面抛了异常");
  console.log("segment-layout DOM regression passed(平铺 + 展开过程 两种排布)");
} finally {
  if (browser) await browser.close();
  await server.close();
}
