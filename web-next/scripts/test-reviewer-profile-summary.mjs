import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const chromeCandidates = [
  process.env.CHROME_BIN,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  chromium.executablePath(),
].filter(Boolean);

async function executablePath() {
  for (const candidate of chromeCandidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next local Chrome/Chromium candidate.
    }
  }
  throw new Error("找不到可执行的 Chrome/Chromium；可通过 CHROME_BIN 指定路径");
}

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

  browser = await chromium.launch({ executablePath: await executablePath(), headless: true });
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
  assert.match(await summary.textContent() ?? "", /模型gpt-5\.6-sol智能水平ultra/);

  const card = await page.locator(".free-review-reviewer-list > button").boundingBox();
  assert(card && card.height < 78, "模型与智能水平不应把审查者条目撑得过高");
  console.log("reviewer profile summary test passed");
} finally {
  await browser?.close();
  await server.close();
}
