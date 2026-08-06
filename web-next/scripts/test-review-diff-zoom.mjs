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
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/review-diff-zoom.html`);

  const zoomLayer = page.locator(".review-zoom-layer");
  const zoomButton = page.locator(".single-review-zoom");
  await zoomButton.waitFor();
  assert.equal(await zoomLayer.count(), 0, "默认不该是放大状态");

  await zoomButton.click();
  await zoomLayer.waitFor();

  // 铺满整个窗口：主区自成堆叠上下文，留在原地的层无论 z-index 多大都盖不住侧边栏，
  // 所以这一条同时钉住「portal 到 body」这个实现前提。
  const viewport = page.viewportSize();
  const box = await zoomLayer.boundingBox();
  assert.deepEqual(
    { x: box.x, y: box.y, width: box.width, height: box.height },
    { x: 0, y: 0, width: viewport.width, height: viewport.height },
    "放大层该盖住整个窗口",
  );
  const sidebar = await page.locator("#fixture-sidebar").boundingBox();
  const overSidebar = await page.evaluate(
    ([x, y]) => !!document.elementFromPoint(x, y)?.closest(".review-zoom-layer"),
    [sidebar.x + sidebar.width / 2, sidebar.y + sidebar.height / 2],
  );
  assert.ok(overSidebar, "放大层该压在侧边栏上面，而不是被主区的堆叠上下文困住");

  // 放大着的时候再开确认框：后开的层必须在最上面，且点它不能被放大层读成「点了外面」。
  await page.keyboard.press("c");
  const dialog = page.locator(".task-confirm-dialog");
  await dialog.waitFor();
  const dialogBox = await dialog.boundingBox();
  const topmost = await page.evaluate(
    ([x, y]) => document.elementFromPoint(x, y)?.closest(".task-confirm-dialog, .review-zoom-layer")?.className ?? "",
    [dialogBox.x + dialogBox.width / 2, dialogBox.y + 12],
  );
  assert.ok(topmost.includes("task-confirm-dialog"), `后开的确认框该在放大层上面，实测 ${topmost}`);
  assert.equal(await zoomLayer.count(), 1, "弹出确认框不该把放大层关掉");

  // 点确认框自己身上：它 portal 到 body 之后 DOM 上不在放大层里，不登记进那一摞层就会
  // 被读成「点了外面」，连人带放大层一起关掉。
  await dialog.locator("h2").click();
  assert.equal(await dialog.count(), 1, "点确认框自己不该把它关掉");
  assert.equal(await zoomLayer.count(), 1, "点确认框不该被放大层读成「点了外面」");

  // Esc 一次只退一层：先关确认框，放大层留着。
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
  assert.equal(await zoomLayer.count(), 1, "Esc 关确认框时放大层该留着");

  await page.keyboard.press("Escape");
  await zoomLayer.waitFor({ state: "detached" });
  assert.equal(await page.locator(".single-review-diff-layout").count(), 1, "退出放大后 diff 该回到原位");

  // 也能用按钮退出：只按 Esc 的用户和只用鼠标的用户都得有出口。
  await zoomButton.click();
  await zoomLayer.waitFor();
  await zoomLayer.locator(".single-review-zoom").click();
  await zoomLayer.waitFor({ state: "detached" });

  console.log("review diff zoom test passed");
} finally {
  await browser?.close();
  await server.close();
}
