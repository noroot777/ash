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
  const localOpenRequests = [];
  const taskFileOpenRequests = [];
  await page.route("**/api/open-local?*", async (route) => {
    localOpenRequests.push(new URL(route.request().url()).searchParams.get("path"));
    await route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: "已打开" });
  });
  await page.route("**/api/tasks/demo/file/open", async (route) => {
    taskFileOpenRequests.push(JSON.parse(route.request().postData() ?? "{}"));
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });
  await page.route("**/api/tasks/tsk1234/free-workflow/review-file?*", async (route) => {
    const name = new URL(route.request().url()).searchParams.get("name");
    if (name === "report.md") {
      await route.fulfill({ status: 200, contentType: "text/markdown; charset=utf-8", body: "# 自由审查报告\n\n报告已在应用内打开。" });
      return;
    }
    await route.continue();
  });
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
  const shot = links.getByRole("link", { name: "截图", exact: true });
  const attachment = links.getByRole("link", { name: "附件", exact: true });
  const served = links.getByRole("link", { name: "证据接口图", exact: true });
  const report = links.getByRole("link", { name: "报告", exact: true });
  const freeReport = links.getByRole("link", { name: "自由报告", exact: true });
  const freeShot = links.getByRole("link", { name: "自由截图", exact: true });
  const freeServed = links.getByRole("link", { name: "自由证据接口图", exact: true });
  const localDemo = links.getByRole("link", { name: "本地 Demo", exact: true });
  const localFile = links.getByRole("link", { name: "普通本地文件", exact: true });
  const remote = links.getByRole("link", { name: "站外图", exact: true });
  await shot.waitFor();
  assert.equal(await links.locator("a[aria-haspopup=dialog]").count(), 5, "所有站内取得到的图片都接管成统一预览");
  assert.equal(await shot.getAttribute("target"), null, "图片链接不再另开标签页");
  assert.match(
    await shot.getAttribute("href"),
    /\/api\/tasks\/tsk1234\/review\/file\?round=1&name=image-preview-two\.png$/,
  );
  assert.match(await attachment.getAttribute("href"), /\/api\/uploads\/AbCdEfGh1234-image-preview-one\.png$/);
  // 文件名藏在 ?name= 里的证据接口 URL（从证据面板复制图片地址再贴回来就是这个形状）。
  assert.equal(await served.getAttribute("aria-haspopup"), "dialog", "证据接口 URL 也认得出是图片");
  assert.equal(await report.getAttribute("aria-haspopup"), null, "报告 .md 仍走站内报告弹层，不是图片预览");
  assert.equal(await freeReport.getAttribute("target"), null, "自由审查报告不再另开页面");
  assert.match(
    await freeReport.getAttribute("href"),
    /\/api\/tasks\/tsk1234\/free-workflow\/review-file\?run=run-abc&round=1&name=report\.md$/,
  );
  assert.equal(await freeShot.getAttribute("aria-haspopup"), "dialog", "自由审查目录里的图片也使用统一灯箱");
  assert.equal(await freeServed.getAttribute("aria-haspopup"), "dialog", "自由审查接口 URL 也认得出是图片");
  const localDemoHref = new URL(await localDemo.getAttribute("href"));
  assert.equal(localDemoHref.pathname, "/api/open-local", "绝对本地路径的可见链接必须指向真实打开端点");
  assert.equal(localDemoHref.searchParams.get("path"), "/Users/fjh/code/ash/.worktrees/demo/docs/baseline/index.html");
  assert.equal(await localDemo.getAttribute("target"), null, "本地路径由当前页面调用打开端点，不新开错误空页");
  assert.equal(new URL(await localFile.getAttribute("href")).pathname, "/api/open-local");
  assert.equal(await remote.getAttribute("aria-haspopup"), null, "站外图不接管");
  assert.equal(await remote.getAttribute("target"), "_blank", "站外图保持新标签页打开");

  const pageUrl = page.url();
  const pageCountBeforeLocalOpen = page.context().pages().length;
  const taskFileRequest = page.waitForRequest("**/api/tasks/demo/file/open");
  await localDemo.click();
  await taskFileRequest;
  assert.deepEqual(taskFileOpenRequests, [{ path: "docs/baseline/index.html", appId: null }], "worktree 链接优先走任务文件接口");
  assert.deepEqual(localOpenRequests, [], "任务文件接口成功时不再碰版本可能落后的通用端点");
  assert.equal(page.url(), pageUrl, "打开本地文件不能把当前对话页导航走");
  assert.equal(page.context().pages().length, pageCountBeforeLocalOpen, "打开本地文件不能先弹一个错误标签页");

  const genericOpenRequest = page.waitForRequest("**/api/open-local?*");
  await localFile.click();
  await genericOpenRequest;
  assert.deepEqual(localOpenRequests, ["/Users/fjh/Documents/demo.html"], "非 worktree 本地路径仍走通用端点");

  await shot.click();
  await dialog.waitFor();
  assert.equal(await page.getByText("1 / 6", { exact: true }).count(), 1, "链接图和内嵌图编在同一组里");
  assert.match(await dialog.locator("img").getAttribute("src"), /review\/file\?round=1&name=image-preview-two\.png$/);

  await page.keyboard.press("ArrowRight");
  assert.equal(await page.getByText("2 / 6", { exact: true }).count(), 1, "翻到同一条消息里的内嵌图");
  assert.match(await dialog.locator("img").getAttribute("src"), /\/image-preview-one\.png$/);

  await page.keyboard.press("ArrowRight");
  assert.equal(await page.getByText("3 / 6", { exact: true }).count(), 1, "再翻到附件链接那张");
  assert.match(await dialog.locator("img").getAttribute("src"), /\/api\/uploads\/AbCdEfGh1234-image-preview-one\.png$/);

  await page.keyboard.press("ArrowRight");
  assert.equal(await page.getByText("4 / 6", { exact: true }).count(), 1, "接着是常规证据接口那张");
  assert.match(await dialog.locator("img").getAttribute("src"), /review\/file\?round=2&name=image-preview-one\.png$/);

  await page.keyboard.press("ArrowRight");
  assert.equal(await page.getByText("5 / 6", { exact: true }).count(), 1, "自由审查目录图片也在同一组");
  assert.match(await dialog.locator("img").getAttribute("src"), /free-workflow\/review-file\?run=run-abc&round=1&name=image-preview-two\.png$/);

  await page.keyboard.press("ArrowRight");
  assert.equal(await page.getByText("6 / 6", { exact: true }).count(), 1, "最后是自由审查接口图");
  assert.match(await dialog.locator("img").getAttribute("src"), /free-workflow\/review-file\?run=run-abc&round=1&name=image-preview-one\.png$/);
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });

  const pageCount = page.context().pages().length;
  await freeReport.click();
  const reportDialog = page.getByRole("dialog", { name: "report.md" });
  await reportDialog.waitFor();
  assert.equal(page.context().pages().length, pageCount, "自由审查报告必须留在当前页面内打开");
  assert.equal(await reportDialog.getByRole("heading", { name: "自由审查报告" }).count(), 1, "Markdown 报告应按正文渲染");
  assert.equal(await reportDialog.getByText("报告已在应用内打开。").count(), 1);

  console.log("image preview group test passed");
} finally {
  await browser?.close();
  await server.close();
}
