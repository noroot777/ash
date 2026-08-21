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

  const originalLink = page.getByRole("link", { name: "image.png" });
  const followUpLink = page.getByRole("link", { name: "follow-up.jpg" });
  const fileLink = page.getByRole("link", { name: "spec.pdf" });
  await originalLink.waitFor();
  assert.match(await originalLink.getAttribute("href"), /\/api\/uploads\/KxOxbl42hcRf-image\.png$/);
  assert.match(await followUpLink.getAttribute("href"), /\/api\/uploads\/R4nd0mAbC123-follow-up\.jpg$/);
  assert.match(await fileLink.getAttribute("href"), /\/api\/uploads\/D0cumentAb12-spec\.pdf$/);
  assert.equal(await fileLink.getAttribute("target"), "_blank");
  assert.equal(await page.locator(".task-message-attachments").count(), 0, "inspector attachments should not render cards");
  assert.equal(await page.getByText("[用户附带的文件，请用 Read 工具查看以下本地文件]").count(), 0);
  assert.equal(await page.getByText("检查原始需求里的图片链接。").count(), 1);
  assert.equal(await page.getByText("检查追问里的图片链接。").count(), 1);

  await originalLink.click();
  const dialog = page.getByRole("dialog", { name: /图片预览/ });
  await dialog.waitFor();
  assert.equal(await page.getByText("1 / 2", { exact: true }).count(), 1);
  assert.match(await dialog.locator("img").getAttribute("src"), /KxOxbl42hcRf-image\.png$/);
  assert.equal(await page.getByRole("button", { name: "上一张图片" }).count(), 1);
  assert.equal(await page.getByRole("button", { name: "下一张图片" }).count(), 1);

  await page.keyboard.press("ArrowRight");
  assert.equal(await page.getByText("2 / 2", { exact: true }).count(), 1);
  assert.match(await dialog.locator("img").getAttribute("src"), /R4nd0mAbC123-follow-up\.jpg$/);

  await page.keyboard.press("ArrowLeft");
  assert.equal(await page.getByText("1 / 2", { exact: true }).count(), 1);
  assert.match(await dialog.locator("img").getAttribute("src"), /KxOxbl42hcRf-image\.png$/);

  console.log("inspector attachment preview links test passed");
} finally {
  await browser?.close();
  await server.close();
}
