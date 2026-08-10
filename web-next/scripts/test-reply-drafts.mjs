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
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/uploads") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: "upload-1",
          path: "/tmp/draft-image.png",
          url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
          name: "draft-image.png",
          kind: "image",
        }),
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  });
  await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/reply-drafts.html`);

  const input = page.getByRole("textbox", { name: "回复任务" });
  await input.fill("任务 A 的未发送内容");
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "上传附件" }).click();
  await (await chooser).setFiles({
    name: "draft-image.png",
    mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"),
  });
  await page.getByText("draft-image.png", { exact: true }).waitFor();

  await page.getByRole("button", { name: "任务 B" }).click();
  assert.equal(await input.inputValue(), "", "另一个任务应有独立的空草稿");
  assert.equal(await page.getByText("draft-image.png", { exact: true }).count(), 0, "图片不能串到另一个任务");
  await input.fill("任务 B 的草稿");
  const secondChooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "上传附件" }).click();
  await (await secondChooser).setFiles({
    name: "task-b-image.png",
    mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"),
  });
  await page.getByText("draft-image.png", { exact: true }).waitFor();

  await page.getByRole("button", { name: "任务 A" }).click();
  assert.equal(await input.inputValue(), "任务 A 的未发送内容", "切回任务后应恢复正文");
  assert.equal(await page.getByText("draft-image.png", { exact: true }).count(), 1, "切回任务后应恢复图片");

  await page.getByRole("button", { name: "任务 B" }).click();
  assert.equal(await input.inputValue(), "任务 B 的草稿", "每个任务应保留自己的正文");
  assert.equal(await page.getByText("draft-image.png", { exact: true }).count(), 1, "后续上传也应留在当前任务");

  await page.getByRole("button", { name: "任务 A" }).click();
  await page.getByRole("button", { name: "发送回复" }).click();
  assert.equal(await input.inputValue(), "", "发送成功后应清掉当前任务正文");
  assert.equal(await page.getByText("draft-image.png", { exact: true }).count(), 0, "发送成功后应清掉当前任务图片");

  await page.getByRole("button", { name: "任务 B" }).click();
  assert.equal(await input.inputValue(), "任务 B 的草稿", "发送一个任务不能清掉另一个任务的草稿");
  assert.equal(await page.getByText("draft-image.png", { exact: true }).count(), 1, "发送一个任务不能清掉另一个任务的图片");

  console.log("task reply draft test passed");
} finally {
  await browser?.close();
  await server.close();
}
