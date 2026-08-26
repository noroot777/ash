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
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/task-review-rounds.html`);

  const rounds = page.locator(".review-inspector__targets button");
  await rounds.first().waitFor();

  // 单任务列的是轮次（团队那边列的是审查对象），一轮一条、不合并。
  assert.deepEqual(await rounds.locator("b").allInnerTexts(), ["第 1 轮", "第 2 轮", "第 3 轮"]);
  assert.deepEqual(await rounds.locator("small").allInnerTexts(), ["独立审查 · 完成", "就地验证", "就地验证"]);
  assert.deepEqual(await rounds.locator("em").allInnerTexts(), ["未通过", "进行中", "已通过"]);

  // 报告正文本来是整篇铺在侧栏里的（一轮就能撑到近 2000px 高），改抽屉之后列表里不该再有它。
  assert.equal(await page.getByText("第 1 轮的验证报告").count(), 0, "没点开就不该把报告铺在侧栏里");
  assert.equal(await page.locator(".review-shots").count(), 0, "没点开就不该把证据截图铺在侧栏里");

  // 只有「未通过 / 无结论」标红：进行中那轮还没有结论，先标红等于提前判它死刑。
  const failed = await rounds.evaluateAll((nodes) => nodes.map((node) => node.classList.contains("is-failed")));
  assert.deepEqual(failed, [true, false, false]);

  const drawer = page.locator(".review-evidence-drawer");
  assert.equal(await drawer.count(), 0, "进来时不该自动弹出验证内容");

  // 点一轮 → 左侧弹屉。
  await rounds.nth(0).click();
  await drawer.waitFor();
  await drawer.getByText("第 1 轮的验证报告").first().waitFor();
  assert.equal(await page.locator(".review-evidence-drawer > header b").innerText(), "第 1 轮验证");
  assert.equal(
    await page.locator(".review-evidence-drawer > header small").innerText(),
    "未通过 · 独立审查 · 完成",
  );

  // 抽屉贴在侧边栏左边缘，不盖住列表（等滑入动画落定再量）。
  await drawer.evaluate((node) => Promise.all(node.getAnimations().map((animation) => animation.finished)));
  const host = await page.locator(".inspector-host").boundingBox();
  const box = await drawer.boundingBox();
  assert.ok(Math.abs(box.x + box.width - host.x) <= 1, `抽屉右边缘该贴着侧边栏左边缘，实测 ${box.x + box.width} vs ${host.x}`);
  assert.ok(Math.abs(box.height - host.height) <= 1, "抽屉该和侧边栏一样高");
  assert.equal(box.width, host.width, "抽屉与侧边栏等宽");

  // 证据截图点开的大图 portal 到 body，DOM 上不在抽屉里：它必须登记进浮层那一摞，
  // 否则点大图会被抽屉读成「点了外面」、Esc 也会连抽屉一起关。
  const lightbox = page.locator(".image-preview-lightbox");
  await drawer.locator(".review-screenshot-strip img").first().click();
  await lightbox.waitFor();
  assert.equal(await drawer.count(), 1, "点开证据大图不该把抽屉一起关了");
  await page.keyboard.press("Escape");
  await lightbox.waitFor({ state: "detached" });
  assert.equal(await drawer.count(), 1, "Esc 关大图时抽屉该留着，一次只退一层");

  // 独立审查那轮有「打开审查任务」的出口；就地验证没有另一个任务，不该长这个按钮。
  await drawer.getByRole("button", { name: "打开审查任务" }).click();
  assert.deepEqual(await page.evaluate(() => window.__openedTasks), ["rev-1"]);

  // 点列表里另一条只换内容，不关抽屉。
  await rounds.nth(2).click();
  await drawer.getByText("第 3 轮的验证报告").first().waitFor();
  assert.equal(await drawer.count(), 1);
  assert.equal(await page.locator(".review-evidence-drawer > header b").innerText(), "第 3 轮验证");
  assert.equal(await drawer.getByRole("button", { name: "打开审查任务" }).count(), 0, "就地验证没有审查任务可打开");
  assert.equal(await drawer.locator(".review-screenshot-strip img").count(), 8, "多张证据截图都应保留在底部图片区");
  assert.equal(
    await drawer.locator(".review-screenshot-strip__rail").evaluate((node) => node.scrollWidth > node.clientWidth),
    true,
    "图片数量增加时只横向滚动，不能持续占用报告高度",
  );
  const drawerBoxAfterSwitch = await drawer.boundingBox();
  const footerBox = await drawer.locator(".review-evidence-drawer__footer").boundingBox();
  assert.ok(Math.abs(footerBox.y + footerBox.height - (drawerBoxAfterSwitch.y + drawerBoxAfterSwitch.height)) <= 1, "图片区应固定贴住抽屉底边");

  // 再点同一条收起来：点开是开关，不是单选。
  await rounds.nth(2).click();
  await drawer.waitFor({ state: "detached" });

  await rounds.nth(1).click();
  await drawer.waitFor();
  await drawer.getByText("验证报告尚未写入。").first().waitFor();
  assert.equal(await drawer.locator(".review-evidence-drawer__footer").count(), 0, "没有截图的轮次不应留下空白底栏");
  await page.keyboard.press("Escape");
  await drawer.waitFor({ state: "detached" });

  // 手机和右侧 drawer 模式没有足够的左侧空间；此时证据抽屉必须转为视口内覆盖，
  // 不能继续贴着 inspector 左边而只露出几十像素。
  await page.setViewportSize({ width: 390, height: 740 });
  await rounds.nth(2).click();
  await drawer.waitFor();
  await drawer.evaluate((node) => Promise.all(node.getAnimations().map((animation) => animation.finished)));
  const mobileBox = await drawer.boundingBox();
  assert.match(await drawer.getAttribute("class"), /is-overlay/, "窄屏应切换为视口内覆盖式抽屉");
  assert.ok(mobileBox.x >= 11, `窄屏抽屉左边缘必须留在视口内，实测 ${mobileBox.x}`);
  assert.ok(mobileBox.x + mobileBox.width <= 379, `窄屏抽屉右边缘必须留在视口内，实测 ${mobileBox.x + mobileBox.width}`);
  assert.ok(mobileBox.width >= 360, `390px 视口下报告应获得可读宽度，实测 ${mobileBox.width}`);
  assert.equal(await drawer.locator(".review-screenshot-strip img").count(), 8, "覆盖式抽屉仍须保留底部截图带");
  await drawer.getByRole("button", { name: "关闭审查内容" }).click();
  await drawer.waitFor({ state: "detached" });

  console.log("task review rounds test passed");
} finally {
  await browser?.close();
  await server.close();
}
