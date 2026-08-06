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
  await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/image-preview.html`);

  const thumbnails = page.locator("#inline img[role=button]");
  await thumbnails.first().waitFor();
  assert.equal(await thumbnails.count(), 2, "ImagePreviewGroup should register two previewable images");

  await thumbnails.first().click();
  const dialog = page.getByRole("dialog", { name: /图片预览/ });
  await dialog.waitFor();
  assert.equal(await page.getByText("1 / 2", { exact: true }).count(), 1, "opening the first image should show 1 / 2");
  assert.match(await dialog.locator("img").getAttribute("src"), /image-preview-one\.png$/);

  await page.getByRole("button", { name: "下一张图片" }).click();
  assert.equal(await page.getByText("2 / 2", { exact: true }).count(), 1, "next button should show 2 / 2");
  assert.match(await dialog.locator("img").getAttribute("src"), /image-preview-two\.png$/);

  await page.keyboard.press("ArrowLeft");
  assert.equal(await page.getByText("1 / 2", { exact: true }).count(), 1, "ArrowLeft should return to 1 / 2");
  assert.match(await dialog.locator("img").getAttribute("src"), /image-preview-one\.png$/);
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });

  // 指向图片的链接：点开必须是站内灯箱，绝不是新标签页（用户 2026-08-06 报的就是这个）。
  const links = page.locator("#links");
  const shot = links.getByRole("link", { name: "截图" });
  const attachment = links.getByRole("link", { name: "附件" });
  const report = links.getByRole("link", { name: "报告" });
  const remote = links.getByRole("link", { name: "站外图" });
  await shot.waitFor();
  assert.equal(await links.locator("a[aria-haspopup=dialog]").count(), 2, "只有截图和附件两个链接接管成图片预览");
  assert.equal(await shot.getAttribute("target"), null, "图片链接不再另开标签页");
  assert.match(
    await shot.getAttribute("href"),
    /\/api\/tasks\/tsk1234\/review\/file\?round=1&name=image-preview-two\.png$/,
  );
  assert.match(await attachment.getAttribute("href"), /\/api\/uploads\/AbCdEfGh1234-image-preview-one\.png$/);
  assert.equal(await report.getAttribute("aria-haspopup"), null, "报告 .md 仍走站内报告弹层，不是图片预览");
  assert.equal(await remote.getAttribute("aria-haspopup"), null, "站外图不接管");
  assert.equal(await remote.getAttribute("target"), "_blank", "站外图保持新标签页打开");

  await shot.click();
  await dialog.waitFor();
  assert.equal(await page.getByText("1 / 3", { exact: true }).count(), 1, "链接图和内嵌图编在同一组里");
  assert.match(await dialog.locator("img").getAttribute("src"), /review\/file\?round=1&name=image-preview-two\.png$/);

  await page.keyboard.press("ArrowRight");
  assert.equal(await page.getByText("2 / 3", { exact: true }).count(), 1, "翻到同一条消息里的内嵌图");
  assert.match(await dialog.locator("img").getAttribute("src"), /\/image-preview-one\.png$/);

  await page.keyboard.press("ArrowRight");
  assert.equal(await page.getByText("3 / 3", { exact: true }).count(), 1, "再翻到附件链接那张");
  assert.match(await dialog.locator("img").getAttribute("src"), /\/api\/uploads\/AbCdEfGh1234-image-preview-one\.png$/);

  console.log("image preview group test passed");
} finally {
  await browser?.close();
  await server.close();
}
