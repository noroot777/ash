import assert from "node:assert/strict";
import { launchChrome, startWebServer } from "./dom-stage.mjs";

// 预览指正长在右侧面板「预览指正」那一格里，不再替换中间那一栏（真实接线：PreviewPane + usePreviewTab）。
// 钉这几条：
// ① 打开之后那一格是宽格、自带头带，会话和回复框原样在、打得进字；
// ② 嵌着的页面在面板里，放大才铺满窗口，还原回到面板、页面不重载；
// ③ 切去别的格再切回来，预览指正还开着；
// ④ 关掉回到那一格的空态，面板回到普通宽度，会话一直在。
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
      return route.fulfill({ contentType: "text/html", body: "<html><body><h1>被预览的页面</h1></body></html>" });
    }
    if (path.endsWith("/preview") && url.searchParams.has("launch")) {
      return reply({ kind: "workflow", reason: "", directory: "/task/worktree", steps: [], configured: null, candidates: [], truncated: false });
    }
    if (path.endsWith("/preview")) {
      return reply({ running: true, starting: false, hasLog: false, proxied: true, gen: "generation", startedAt: "session",
        services: [{ id: "web", name: "Web", status: "ready", url: "http://example.test", command: "npm run dev" }] });
    }
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

  // ③ 切去别的格再回来，预览指正还开着。
  await page.locator(".inspector-rail__tab[aria-controls$='-panel-info']").click();
  await inspector.getByText("任务信息").waitFor();
  await previewTab.click();
  await workspace.waitFor();

  // ④ 关掉：回到空态、普通宽度，会话一直在。
  await button("关闭预览指正").click();
  await button("打开预览指正").waitFor();
  assert.equal(await workspace.count(), 0);
  await page.waitForFunction((width) => Math.round(document.querySelector(".inspector-host").getBoundingClientRect().width) === Math.round(width), narrowWidth);
  assert.ok(await conversation.isVisible(), "关掉之后会话照旧");
  assert.equal(await reply.inputValue(), "边看页面边说", "开关预览指正不动回复框里的字");

  assert.deepEqual(errors, []);
  console.log("preview tab test passed");
} finally {
  await browser?.close();
  await web.close();
}
