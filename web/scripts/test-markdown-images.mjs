// 「agent 说的那张图，用户看不看得到」的 DOM 回归。
//
// 这一份盯的是用户 2026-10-21 报的那一幕：结论和审查报告里的图**永远是一个裂开的图标**。
// 根因不是渲染坏了，是这两种正文都没有「文档根」——`![](shot.png)` 在浏览器眼里是相对
// 当前页面的地址，必然 404。所以断言分两头：
//   ① 解得出来的，`<img>` 必须指向真能吐出字节的站内接口（证据接口 / uploads 拷贝）；
//   ② 解不出来的，**一个 `<img>` 都不许留**——裂图标只会被读成「这功能坏了」。
// 外加一条去重：同一张图既画进正文又挂成附件卡片，等于在同一屏里把它说两遍。
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
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/markdown-images.html`);

  // ── ① 审查报告：截图跟 report.md 同目录，这是审查 prompt 交代的写法 ──────────
  const report = page.locator(".report-fixture");
  await report.locator(".task-markdown").first().waitFor();
  const reportImages = report.locator(".task-markdown img");
  assert.equal(await reportImages.count(), 1, "同目录那张要画出来，子目录那张服务端取不到就别画");
  const evidence = await reportImages.first().getAttribute("src");
  assert.match(
    evidence ?? "",
    /\/api\/tasks\/T1\/free-workflow\/review-file\?run=R1&round=1&name=shot\.png$/,
    "报告里的相对路径必须解到证据接口，不是解到网页自己的地址",
  );

  // ── ② 对话结论：相对路径 + 绝对路径，都靠服务端那份 uploads 拷贝落地 ────────
  const conclusion = page.locator(".conclusion-fixture");
  const inline = conclusion.locator(".task-markdown img");
  assert.equal(await inline.count(), 2, "正文里提到的两张图都该画在 agent 放它的位置上");
  const sources = await inline.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("src")));
  assert.deepEqual(
    sources,
    [
      "/api/uploads/aaaaaaaaaaaa-wake-input-desktop.png",
      "/api/uploads/bbbbbbbbbbbb-wake-input-mobile.png",
    ],
    "相对路径和绝对路径都要配到各自那份拷贝，且不许配串",
  );

  // 同一张图不能说两遍：画进正文的那两张要从附件卡片里撤掉，正文没提的那张照旧留着。
  const cards = conclusion.locator(".task-message-attachments img");
  assert.equal(await cards.count(), 1, "正文里已经画出来的图不该再挂一张卡片");
  assert.equal(
    await cards.first().getAttribute("src"),
    "/api/uploads/cccccccccccc-tool-screenshot.png",
    "正文没提到的附件（工具结果截图之类）仍要铺成卡片",
  );

  // ── ③ 只有一张图：领走之后那一段空了，不许留一个占着间距的空 section ──────
  const single = page.locator(".single-fixture");
  assert.equal(await single.locator(".task-markdown img").count(), 1, "唯一那张图要画在正文里");
  assert.equal(await single.locator(".task-message-attachments").count(), 0, "卡片排整个空了就别出");
  assert.equal(
    await single.locator(".task-agent-segment").count(),
    1,
    "附件被正文领走后那一段什么都画不出来，不该再占一个 section",
  );

  // ── ④ 配不上来源的本机路径：什么都不画 ───────────────────────────────────
  const orphan = page.locator(".orphan-fixture");
  await orphan.locator(".task-markdown").first().waitFor();
  assert.equal(
    await orphan.locator("img").count(),
    0,
    "解释不了的本机路径要静默收掉，绝不留裂开的图标",
  );
  assert.match(
    await orphan.locator(".task-markdown").innerText(),
    /当时的截图/,
    "收掉的只是那张图，正文一个字都不能少",
  );

  console.log("Markdown 图片解析回归通过");
} finally {
  await browser?.close();
  await server.close();
}
