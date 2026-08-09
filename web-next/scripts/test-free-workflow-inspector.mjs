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
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/free-workflow-inspector.html`);

  await page.getByText("Codex 审查").waitFor();
  await page.locator(".free-review-history summary").click();
  assert.equal(await page.getByRole("heading", { name: "审查结论" }).count(), 1, "报告应按 Markdown 正文渲染");
  assert.equal(await page.locator(".free-review-history article > pre").count(), 0, "报告不再退化成原始 pre 文本");

  const shots = page.locator(".free-review-screenshots");
  assert.equal(await shots.locator("a").count(), 0, "自由审查截图不应再是新页面链接");
  assert.equal(await shots.locator("img[role=button]").count(), 2, "自由审查截图应接入统一图片预览");

  const pageCount = page.context().pages().length;
  await shots.locator("img[role=button]").first().click();
  const lightbox = page.getByRole("dialog", { name: /图片预览/ });
  await lightbox.waitFor();
  assert.equal(page.context().pages().length, pageCount, "点截图必须留在当前页面");
  assert.equal(await page.getByText("1 / 2", { exact: true }).count(), 1);
  assert.match(await lightbox.locator("img").getAttribute("src"), /free-workflow\/review-file\?run=run-abc&round=1&name=shot-one\.png$/);

  console.log("free workflow inspector preview test passed");
} finally {
  await browser?.close();
  await server.close();
}
