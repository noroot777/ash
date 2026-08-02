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
  await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/inspector-attachments.html`);

  const links = page.getByRole("link", { name: /^打开附件 / });
  await links.first().waitFor();
  assert.equal(await links.count(), 2, "original requirement and follow-up should each expose an attachment link");
  assert.match(await links.nth(0).getAttribute("href"), /\/api\/uploads\/KxOxbl42hcRf-image\.png$/);
  assert.match(await links.nth(1).getAttribute("href"), /\/api\/uploads\/R4nd0mAbC123-follow-up\.jpg$/);
  assert.equal(await links.nth(0).getAttribute("target"), "_blank");
  assert.equal(await page.getByText("[用户附带的文件，请用 Read 工具查看以下本地文件]").count(), 0);
  assert.equal(await page.getByText("检查原始需求里的图片链接。").count(), 1);
  assert.equal(await page.getByText("检查追问里的图片链接。").count(), 1);

  console.log("inspector attachment links test passed");
} finally {
  await browser?.close();
  await server.close();
}
