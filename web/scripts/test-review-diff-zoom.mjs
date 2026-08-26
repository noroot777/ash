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
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/review-diff-zoom.html`);

  const zoomLayer = page.locator(".review-zoom-layer");
  const zoomButton = page.locator("#fixture-main .single-review-zoom");
  const inspector = page.locator("#fixture-inspector");
  await zoomButton.waitFor();
  assert.equal(await zoomLayer.count(), 0, "默认不该是放大状态");

  await zoomButton.click();
  await zoomLayer.waitFor();

  // 铺满窗口，但右边让开 inspector 那一列：放大是把 diff 铺开来看，旁边的审查记录得留着。
  // fixture 抄了 `.workspace-shell` 右边那 8px 内边距，inspector 因此差一点没贴到窗口右缘——
  // 让位的判据必须容得下这一点，否则真实页面里一条 inspector 都找不到（放大又会盖回去）。
  const viewport = page.viewportSize();
  const inspectorBox = await inspector.boundingBox();
  assert.ok(
    viewport.width - (inspectorBox.x + inspectorBox.width) >= 8,
    "fixture 该保留右侧内边距，inspector 不能正好贴死窗口右缘",
  );
  const box = await zoomLayer.boundingBox();
  assert.deepEqual(
    { x: box.x, y: box.y, width: box.width, height: box.height },
    { x: 0, y: 0, width: inspectorBox.x, height: viewport.height },
    "放大层该占满 inspector 左边的整块窗口",
  );

  // 左边的任务栏必须被盖住。主区自成堆叠上下文，留在原地的层无论 z-index 多大都盖不住它，
  // 所以这一条钉住「portal 到 body」这个实现前提。
  const rail = await page.locator("#fixture-rail").boundingBox();
  const overRail = await page.evaluate(
    ([x, y]) => !!document.elementFromPoint(x, y)?.closest(".review-zoom-layer"),
    [rail.x + rail.width / 2, rail.y + rail.height / 2],
  );
  assert.ok(overRail, "放大层该压住左边的任务栏，而不是被主区的堆叠上下文困住");

  // inspector 反过来必须点得到：它在主区那个堆叠上下文里，portal 之后单靠 z-index 一定会
  // 被盖掉，只能靠让出宽度。
  const overInspector = await page.evaluate(
    ([x, y]) => !!document.elementFromPoint(x, y)?.closest("#fixture-inspector"),
    [inspectorBox.x + inspectorBox.width / 2, inspectorBox.y + 20],
  );
  assert.ok(overInspector, "inspector 不该被放大层盖住");

  // 拖宽 inspector，放大层跟着让位（ResizeObserver）。
  const widened = Math.round(inspectorBox.x + inspectorBox.width - 420);
  await inspector.evaluate((node) => node.style.setProperty("--inspector-width", "420px"));
  await page.waitForFunction(
    (expected) => Math.round(document.querySelector(".review-zoom-layer").getBoundingClientRect().width) === expected,
    widened,
    { timeout: 2000 },
  );
  await inspector.evaluate((node) => node.style.setProperty("--inspector-width", "300px"));

  // 在 inspector 里点验收：放大态下这是真点得到的「外面」，不能把放大收掉；弹出来的确认框
  // 又必须压在放大层上面。
  await inspector.locator("button").click();
  const dialog = page.locator(".task-confirm-dialog");
  await dialog.waitFor();
  assert.equal(await zoomLayer.count(), 1, "点 inspector 不该把放大层关掉");
  const dialogBox = await dialog.boundingBox();
  const topmost = await page.evaluate(
    ([x, y]) => document.elementFromPoint(x, y)?.closest(".task-confirm-dialog, .review-zoom-layer")?.className ?? "",
    [dialogBox.x + dialogBox.width / 2, dialogBox.y + 12],
  );
  assert.ok(topmost.includes("task-confirm-dialog"), `后开的确认框该在放大层上面，实测 ${topmost}`);

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
  assert.equal(
    await page.locator("#fixture-main .single-review-diff-layout").count(),
    1,
    "退出放大后 diff 该回到原位",
  );

  // 也能用按钮退出：只按 Esc 的用户和只用鼠标的用户都得有出口。
  await zoomButton.click();
  await zoomLayer.waitFor();
  await zoomLayer.locator(".single-review-zoom").click();
  await zoomLayer.waitFor({ state: "detached" });

  // 长在执行者抽屉（z-index 95）里的那份 diff：放大层得抬到抽屉上面，否则按钮看着像坏了；
  // 让开的仍是窗口右缘那条 inspector，而不是抽屉里嵌的那条。
  await page.locator("#fixture-drawer .single-review-zoom").click();
  await zoomLayer.waitFor();
  const drawerZoom = await zoomLayer.evaluate((node) => ({
    z: Number(window.getComputedStyle(node).zIndex),
    width: node.getBoundingClientRect().width,
  }));
  assert.ok(drawerZoom.z > 95, `抽屉里放大该抬到抽屉之上，实测 z-index ${drawerZoom.z}`);
  assert.equal(drawerZoom.width, inspectorBox.x, "抽屉里放大让开的仍该是窗口右缘那条 inspector");
  const overDrawer = await page.evaluate(
    ([x, y]) => !!document.elementFromPoint(x, y)?.closest(".review-zoom-layer"),
    [200, 400],
  );
  assert.ok(overDrawer, "放大层该压住抽屉本身");
  await page.keyboard.press("Escape");
  await zoomLayer.waitFor({ state: "detached" });

  console.log("review diff zoom test passed");
} finally {
  await browser?.close();
  await server.close();
}
