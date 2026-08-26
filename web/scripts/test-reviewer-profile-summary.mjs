import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { chromeExecutablePath } from "./chrome-path.mjs";
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

  browser = await chromium.launch({ executablePath: await chromeExecutablePath(), headless: true });
  const page = await browser.newPage({ viewport: { width: 900, height: 360 } });
  await page.route("**/api/llm-providers", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: "[]",
  }));
  await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/reviewer-profile-summary.html`);

  const summary = page.locator(".reviewer-profile-summary");
  await summary.waitFor();
  assert.equal(await summary.getByText("codex@local", { exact: true }).count(), 1);
  assert.equal(await summary.getByText("gpt-5.6-sol", { exact: true }).count(), 1);
  assert.equal(await summary.getByText("ultra", { exact: true }).count(), 1);
  assert.match(await summary.textContent() ?? "", /codex@local·gpt-5\.6-sol·ultra/);
  assert.equal(await summary.evaluate((element) => getComputedStyle(element).whiteSpace), "nowrap");
  const partTops = await summary.locator(":scope > span, :scope > code").evaluateAll((elements) => (
    elements.map((element) => Math.round(element.getBoundingClientRect().top))
  ));
  assert(Math.max(...partTops) - Math.min(...partTops) <= 2, "智能体、模型与智能水平应保持在同一行");

  const card = await page.locator(".free-review-reviewer-list > button").boundingBox();
  assert(card && card.height < 64, "单行摘要不应把审查者条目撑得过高");
  console.log("reviewer profile summary test passed");
} finally {
  await browser?.close();
  await server.close();
}
