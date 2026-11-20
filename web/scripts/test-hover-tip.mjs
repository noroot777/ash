import assert from "node:assert/strict";
import { launchChrome, startWebServer } from "./dom-stage.mjs";

const web = await startWebServer();
let browser;
try {
  browser = await launchChrome();
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  for (const width of [1254, 600, 320]) {
    await page.setViewportSize({ width, height: 627 });
    await page.goto(`${web.origin}/scripts/fixtures/hover-tip.html`);
    const archive = page.getByRole("menuitem", { name: "归档任务" });
    await archive.hover();
    const tip = page.getByRole("tooltip");
    await tip.waitFor();
    const metrics = await tip.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width,
        height: rect.height, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth };
    });
    assert.ok(metrics.left >= 7 && metrics.right <= width - 7, JSON.stringify({ width, ...metrics }));
    assert.ok(metrics.top >= 7 && metrics.bottom <= 620, JSON.stringify(metrics));
    assert.ok(metrics.width <= 280 && metrics.height > 45, "长提示换行，背景包住全部文字");
    assert.ok(metrics.scrollWidth <= metrics.clientWidth + 1, "连续长任务名不溢出背景");
    await archive.click({ force: true });
    assert.equal(await page.locator("main").getAttribute("data-selected"), "0", "禁用的菜单项不会执行");
    await page.getByRole("menuitem", { name: "刷新", exact: true }).hover();
    await page.getByRole("menuitem", { name: "刷新", exact: true }).focus();
    await tip.waitFor({ state: "detached" });
    await page.getByRole("menuitem", { name: "删除任务", exact: true }).focus();
    await page.keyboard.press("Shift+Tab");
    await tip.waitFor();
    await page.setViewportSize({ width: 300, height: 500 });
    await page.waitForFunction(() => {
      const rect = document.querySelector('[role="tooltip"]')?.getBoundingClientRect();
      return rect && rect.left >= 7 && rect.right <= 293 && rect.top >= 7 && rect.bottom <= 493;
    });
    await page.setViewportSize({ width, height: 627 });
    await page.getByRole("menuitem", { name: "刷新", exact: true }).focus();
    for (const placement of ["below", "above", "left"]) {
      const edge = page.getByRole("button", { name: placement, exact: true });
      await edge.hover();
      await tip.waitFor();
      const bounds = await tip.boundingBox();
      assert.ok(bounds && bounds.x >= 7 && bounds.y >= 7 && bounds.x + bounds.width <= width - 7
        && bounds.y + bounds.height <= 620, `${placement}: ${JSON.stringify(bounds)}`);
      await page.getByRole("menuitem", { name: "刷新", exact: true }).hover();
      await tip.waitFor({ state: "detached" });
    }
  }
  assert.deepEqual(errors, []);
  console.log("✓ 长归档原因在桌面和窄屏完整换行；三个方向的提示保持在视口内，鼠标与键盘入口可用");
} finally {
  try { await browser?.close(); }
  finally { await web.close(); }
}
