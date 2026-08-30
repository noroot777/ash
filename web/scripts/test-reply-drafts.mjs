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
  let uploadCount = 0;
  let releaseFirstUpload;
  let markFirstUploadStarted;
  let markFirstUploadFinished;
  const firstUploadRelease = new Promise((resolve) => { releaseFirstUpload = resolve; });
  const firstUploadStarted = new Promise((resolve) => { markFirstUploadStarted = resolve; });
  const firstUploadFinished = new Promise((resolve) => { markFirstUploadFinished = resolve; });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/uploads") {
      const requestNumber = ++uploadCount;
      const request = JSON.parse(route.request().postData() ?? "{}");
      const name = typeof request.name === "string" ? request.name : `upload-${requestNumber}.png`;
      if (requestNumber === 1) {
        markFirstUploadStarted();
        await firstUploadRelease;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: `upload-${requestNumber}`,
          path: `/tmp/${name}`,
          url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
          name,
          kind: "image",
        }),
      });
      if (requestNumber === 1) markFirstUploadFinished();
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
    name: "a-delayed.png",
    mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"),
  });
  await firstUploadStarted;

  await page.getByRole("button", { name: "任务 B" }).click();
  assert.equal(await input.inputValue(), "", "另一个任务应有独立的空草稿");
  assert.equal(await page.getByText("a-delayed.png", { exact: true }).count(), 0, "上传中的图片不能串到另一个任务");
  await input.fill("任务 B 的草稿");
  const secondChooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "上传附件" }).click();
  await (await secondChooser).setFiles({
    name: "task-b-image.png",
    mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"),
  });
  await page.getByText("task-b-image.png", { exact: true }).waitFor();

  await page.getByRole("button", { name: "任务 A" }).click();
  assert.equal(await input.inputValue(), "任务 A 的未发送内容", "切回任务后应恢复正文");
  const sendButton = page.getByRole("button", { name: "发送回复" });
  assert.equal(await sendButton.isDisabled(), true, "当前任务仍有图片上传时必须禁止发送");
  // 在途期间界面不是空白：卡片先占位说明「在传、传了多少」，正式缩略图要等传完才出现。
  assert.equal(await page.locator(".task-upload-chip.is-uploading").count(), 1, "上传期间必须有在途卡片顶着");
  assert.equal(await page.locator(".task-upload-chip img").count(), 0, "上传完成前不应提前显示缩略图");
  await input.press("Control+Enter");
  assert.equal(await input.inputValue(), "任务 A 的未发送内容", "上传中用快捷键也不能提前发送正文");

  releaseFirstUpload();
  await firstUploadFinished;
  // 名字在粘上去那一刻就有了（在途卡片），所以「传完了没」要看正式缩略图。
  await page.locator(".task-upload-chip img").waitFor();
  assert.equal(await sendButton.isEnabled(), true, "当前任务图片上传完成后才能恢复发送");
  assert.equal(await page.getByText("a-delayed.png", { exact: true }).count(), 1, "切回任务后应恢复延迟完成的图片");
  assert.equal(await page.getByText("task-b-image.png", { exact: true }).count(), 0, "任务 A 不能混入任务 B 的图片");

  await page.getByRole("button", { name: "任务 B" }).click();
  assert.equal(await input.inputValue(), "任务 B 的草稿", "每个任务应保留自己的正文");
  assert.equal(await page.getByText("task-b-image.png", { exact: true }).count(), 1, "后续上传也应留在当前任务");
  assert.equal(await page.getByText("a-delayed.png", { exact: true }).count(), 0, "任务 B 不能混入任务 A 的图片");

  await page.getByRole("button", { name: "任务 A" }).click();
  await sendButton.click();
  assert.equal(await input.inputValue(), "", "发送成功后应清掉当前任务正文");
  assert.equal(await page.getByText("a-delayed.png", { exact: true }).count(), 0, "发送成功后应清掉当前任务图片");

  await page.getByRole("button", { name: "任务 B" }).click();
  assert.equal(await input.inputValue(), "任务 B 的草稿", "发送一个任务不能清掉另一个任务的草稿");
  assert.equal(await page.getByText("task-b-image.png", { exact: true }).count(), 1, "发送一个任务不能清掉另一个任务的图片");

  console.log("task reply draft test passed");
} finally {
  await browser?.close();
  await server.close();
}
