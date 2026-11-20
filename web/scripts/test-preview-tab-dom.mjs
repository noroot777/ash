import assert from "node:assert/strict";
import { launchChrome, startWebServer } from "./dom-stage.mjs";

// 预览指正长在右侧面板「预览指正」那一格里，不再替换中间那一栏（真实接线：PreviewPane + usePreviewTab）。
// 钉这几条：
// ① 打开之后那一格是宽格、自带头带，会话和回复框原样在、打得进字；
// ② 嵌着的页面在面板里，放大才铺满窗口，还原回到面板、页面不重载；
// ③ 切去别的格、收起右侧面板再回来：还是原来那一份页面（不重载、页里没提交的输入还在）；
// ④ 会话里点开审查报告：从左边推出，会话和回复框不被盖住、照样点得到——窗口一路缩窄也一样：
//    主区够宽并排，窄了报告改排到头部下面、会话上面；
// ⑤ 关掉回到那一格的空态，面板回到普通宽度，会话一直在。
// 设 SHOT=<目录> 可以顺带截图自查版式。

const web = await startWebServer();

let browser;
try {
  browser = await launchChrome();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let iframeLoads = 0;
  await page.route("**/api/**", async (route) => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    const reply = (body) => route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
    if (path === "/api/events") return route.fulfill({ status: 204 });
    if (path.includes("/preview/open/")) {
      iframeLoads++;
      return route.fulfill({ contentType: "text/html", body: '<html><body><h1>被预览的页面</h1><input id="draft" aria-label="页内输入"></body></html>' });
    }
    if (path.endsWith("/preview") && url.searchParams.has("launch")) {
      return reply({ kind: "workflow", reason: "", directory: "/task/worktree", steps: [], configured: null, candidates: [], truncated: false });
    }
    if (path.endsWith("/preview")) {
      return reply({ running: true, starting: false, hasLog: false, proxied: true, gen: "generation", startedAt: "session",
        services: [{ id: "web", name: "Web", status: "ready", url: "http://example.test", command: "npm run dev" }] });
    }
    if (path.endsWith("/review/file")) return route.fulfill({ contentType: "text/markdown; charset=utf-8", body: "# 第 1 轮审查报告\n\n报告正文。" });
    if (path.endsWith("/annotation-review-status")) return reply({ canReopen: false, reason: "", previewKind: "workflow" });
    return reply([]);
  });
  await page.goto(`${web.origin}/scripts/fixtures/preview-tab.html`);

  const button = (name) => page.getByRole("button", { name, exact: true });
  const inspector = page.locator(".inspector-host");
  const workspace = page.locator(".preview-workspace");
  const iframe = page.locator('iframe[title="任务页面预览"]');
  const conversation = page.getByTestId("conversation");
  const reply = page.getByRole("textbox", { name: "回复框" });
  const previewTab = page.locator(".inspector-rail__tab[aria-controls$='-panel-preview']");
  const settled = () => page.waitForTimeout(250); // 面板宽度有 160ms 的过渡

  await inspector.waitFor();
  await previewTab.click();
  await button("打开预览指正").waitFor();
  assert.equal(await inspector.locator(".inspector-host__panel-head").count(), 1, "没打开时是一格普通的空态");
  await settled();
  const narrowWidth = (await inspector.boundingBox()).width;

  // ① 打开：预览指正在那一格里，会话和回复框留着。
  await button("打开预览指正").click();
  await workspace.waitFor();
  assert.equal(await inspector.locator(".preview-workspace").count(), 1, "预览指正该长在右侧面板里");
  assert.equal(await page.locator("#fixture-main .preview-workspace").count(), 0, "不该替换中间那一栏");
  assert.ok(await conversation.isVisible(), "会话该一直留着");
  await reply.fill("边看页面边说");
  assert.equal(await reply.inputValue(), "边看页面边说", "回复框照样能用");
  await page.waitForFunction((width) => document.querySelector(".inspector-host").getBoundingClientRect().width > width + 100, narrowWidth);
  await settled();
  const wideBox = await inspector.boundingBox();
  const layoutBox = await page.locator(".inspector-layout").boundingBox();
  assert.ok(Math.abs(wideBox.width / layoutBox.width - 0.5) < 0.05, `打开着是宽格，跟会话大约五五开：${wideBox.width} / ${layoutBox.width}`);
  assert.equal(await inspector.locator(".inspector-host__panel-head").count(), 0, "工作区自带头带，宿主不再叠一条标题");
  assert.equal(await page.locator(".preview-workspace.is-expanded").count(), 0, "打开时不铺满窗口");

  // ② 页面嵌在面板里；放大铺满窗口，还原回来，页面不重载。
  await iframe.waitFor();
  const frameBox = await iframe.boundingBox();
  assert.ok(frameBox.x >= wideBox.x - 1 && frameBox.x + frameBox.width <= wideBox.x + wideBox.width + 1, "嵌着的页面在面板里");
  if (process.env.SHOT) await page.screenshot({ path: `${process.env.SHOT}/preview-tab-open.png` });
  const loads = iframeLoads;
  await button("放大预览").click();
  assert.deepEqual(await workspace.boundingBox(), { x: 0, y: 0, width: 1400, height: 900 }, "放大铺满窗口");
  await button("还原预览").click();
  const restored = await workspace.boundingBox();
  assert.ok(restored.x >= wideBox.x - 1 && restored.width < 1000, "还原回到面板里");
  assert.ok(await conversation.isVisible(), "还原之后会话还在");
  assert.equal(iframeLoads, loads, "放大、还原不重载页面");

  // ③ 切去别的格、收起面板再回来：同一份页面，页里没提交的输入还在。
  const frame = () => page.frames().find((candidate) => candidate.url().includes("/preview/open/"));
  const pageDraft = () => frame().evaluate(() => document.getElementById("draft").value);
  await frame().evaluate(() => { document.getElementById("draft").value = "尚未提交的页面内容"; });
  await page.locator(".inspector-rail__tab[aria-controls$='-panel-info']").click();
  await inspector.getByText("任务信息").waitFor();
  assert.equal(await iframe.isVisible(), false, "切走之后预览藏起来");
  await previewTab.click();
  await iframe.waitFor();
  assert.equal(iframeLoads, loads, "切格往返不重载页面");
  assert.equal(await pageDraft(), "尚未提交的页面内容", "切格往返，页面里没提交的输入还在");
  await button("开合右侧面板").click();
  await inspector.waitFor({ state: "hidden" });
  assert.ok(await reply.isVisible(), "收起右侧面板，回复框照旧");
  await button("开合右侧面板").click();
  await iframe.waitFor();
  assert.equal(iframeLoads, loads, "收起、展开右侧面板不重载页面");
  assert.equal(await pageDraft(), "尚未提交的页面内容", "收起、展开右侧面板，页面里的输入还在");

  // ④ 会话里点开审查报告：左边推出，会话和回复框让到右边、照样点得到。
  await page.getByRole("link", { name: "第 1 轮报告", exact: true }).click();
  const report = page.getByRole("complementary", { name: "审查报告：report.md" });
  await report.getByRole("heading", { name: "第 1 轮审查报告" }).waitFor();
  await settled();
  const hitsSelf = (locator) => locator.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
  });
  assert.ok(await hitsSelf(reply), "报告开着，回复框没被抽屉或遮罩盖住");
  assert.ok(await hitsSelf(conversation), "报告开着，会话没被盖住");
  const reportBox = await report.boundingBox(), replyBox = await reply.boundingBox();
  assert.ok(replyBox.x >= reportBox.x + reportBox.width - 1, "会话一栏让到报告右边");
  await reply.fill("读着报告接着说");
  assert.equal(await reply.inputValue(), "读着报告接着说");
  assert.equal(await workspace.count(), 1, "报告开着时预览指正照旧在右边");
  // 量的是主区不是窗口：右边开着宽格，921px 的窗口里主区已经窄到要上下摆。窄到右侧面板自己改成
  // 盖在内容上（≤720px）那一档，缩过去之前先把面板收起来——那是面板的形态，不是报告盖的。
  const header = page.locator(".task-detail-header");
  for (const width of [921, 920, 900, 760, 640, 420]) {
    if (width <= 720 && await inspector.isVisible()) { // 缩过去之后面板就把这颗键也盖住了，先收
      await button("开合右侧面板").click();
      await inspector.waitFor({ state: "hidden" });
    }
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(350); // 并排→上下时让出来的那一段有 260ms 的过渡
    assert.ok(await hitsSelf(reply), `${width}px：报告开着，回复框没被盖住`);
    assert.ok(await hitsSelf(conversation), `${width}px：报告开着，会话没被盖住`);
    await reply.fill(`${width}px 读着报告说`);
    assert.equal(await reply.inputValue(), `${width}px 读着报告说`);
    const mainWidth = (await page.locator(".task-detail").boundingBox()).width;
    const box = await report.boundingBox(), talk = await conversation.boundingBox();
    if (mainWidth >= 560) {
      assert.ok(talk.x >= box.x + box.width - 1, `${width}px：主区 ${mainWidth}px 够宽，并排`);
    } else {
      const head = await header.boundingBox();
      assert.ok(box.y >= head.y + head.height - 1 && talk.y >= box.y + box.height - 1, `${width}px：主区 ${mainWidth}px 太窄，报告排在头部下面、会话上面`);
      assert.ok(box.height > 200 && box.width >= mainWidth - 1, `${width}px：上下摆时报告占满主区宽、有正经的高度`);
    }
    assert.ok(await report.getByRole("heading", { name: "第 1 轮审查报告" }).isVisible(), `${width}px：报告照样看得见`);
  }
  if (process.env.SHOT) await page.screenshot({ path: `${process.env.SHOT}/preview-tab-report-narrow.png` });
  await page.setViewportSize({ width: 1400, height: 900 });
  await button("开合右侧面板").click();
  await iframe.waitFor();
  assert.equal(iframeLoads, loads, "缩窄、收起面板再放宽，预览页面不重载");
  await page.waitForTimeout(350);
  const wideAgain = await report.boundingBox();
  assert.ok((await conversation.boundingBox()).x >= wideAgain.x + wideAgain.width - 1, "放宽回来又并排");
  await reply.fill("读着报告接着说");
  await report.getByRole("button", { name: "关闭审查报告" }).click();
  await report.waitFor({ state: "detached" });

  // ⑤ 关掉：回到空态、普通宽度，会话一直在。
  await button("关闭预览指正").click();
  await button("打开预览指正").waitFor();
  assert.equal(await workspace.count(), 0);
  await page.waitForFunction((width) => Math.round(document.querySelector(".inspector-host").getBoundingClientRect().width) === Math.round(width), narrowWidth);
  assert.ok(await conversation.isVisible(), "关掉之后会话照旧");
  assert.equal(await reply.inputValue(), "读着报告接着说", "开关预览指正不动回复框里的字");

  assert.deepEqual(errors, []);
  console.log("preview tab test passed");
} finally {
  await browser?.close();
  await web.close();
}
