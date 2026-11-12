// 设置页执行器表行尾的「更多」菜单、它打开的「额外 CLI 参数」浮层都是 fixed + portal 到 body：
// 设置内容一滚、窗口一缩，按钮挪了它们必须跟着走，不能留在原来的坐标上（第 1 轮审查）。
// 跑:npm -w web run test:settings-popover-follow
import assert from "node:assert/strict";
import { launchChrome, startWebServer } from "./dom-stage.mjs";
import { waitUntil } from "./wait-until.mjs";

const web = await startWebServer();
let browser;
try {
  browser = await launchChrome();
  const page = await browser.newPage({ viewport: { width: 900, height: 800 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${web.origin}/scripts/fixtures/settings-popover-follow.html`);
  const more = page.getByRole("button", { name: "codex 的更多操作" });
  await more.waitFor();
  // 量浮层写在 style 上的坐标，不量 getBoundingClientRect：进场动画的 transform 会把后者带偏。
  const gap = async (selector) => page.evaluate((css) => {
    const box = document.querySelector(css);
    const anchor = document.querySelector(".profile-row-more")?.getBoundingClientRect();
    if (!(box instanceof HTMLElement) || !box.style.top || !anchor) return null;
    return { top: Math.round(parseFloat(box.style.top) - anchor.bottom), right: Math.round(anchor.right - (parseFloat(box.style.left) + box.offsetWidth)) };
  }, selector);
  const follows = async (selector, what) => {
    await waitUntil(async () => (await gap(selector)) !== null, `${what}挂上`);
    const before = await gap(selector);
    await page.locator("[data-scroller]").evaluate((node) => { node.scrollTop = 120; });
    await waitUntil(async () => JSON.stringify(await gap(selector)) === JSON.stringify(before), `${what}滚动之后仍贴着按钮`);
    await page.setViewportSize({ width: 760, height: 800 });
    await waitUntil(async () => JSON.stringify(await gap(selector)) === JSON.stringify(before), `${what}窗口缩放之后仍贴着按钮`);
    await page.locator("[data-scroller]").evaluate((node) => { node.scrollTop = 0; });
    await page.setViewportSize({ width: 900, height: 800 });
  };

  await more.click();
  await follows(".profile-row-menu:not(.is-leaving)", "更多菜单");
  await page.getByRole("menuitem", { name: /额外 CLI 参数/ }).click();
  await follows(".agent-profile-args-popover", "参数浮层");
  assert.deepEqual(errors, [], "页面没有报错");
  console.log("settings popover follow ok: 更多菜单与参数浮层随滚动、缩放贴着按钮");
} finally {
  await browser?.close();
  await web.close();
}
