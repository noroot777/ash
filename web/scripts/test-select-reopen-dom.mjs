// 公共下拉（components/Select.tsx）**每一次**打开都要把焦点交给浮层（带筛选的交给筛选框），
// 不只是第一次（第 1 轮审查 F3）：关掉、等退场放完、再用键盘打开，方向键照样能挑、照样能直接
// 打字筛选；退场还没放完就再打开也一样。
// 跑:npm -w web run test:select-reopen-dom
import assert from "node:assert/strict";
import { launchChrome, startWebServer } from "./dom-stage.mjs";
import { waitUntil } from "./wait-until.mjs";

const web = await startWebServer();
let browser;
try {
  browser = await launchChrome();
  const page = await browser.newPage({ viewport: { width: 800, height: 700 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${web.origin}/scripts/fixtures/select-reopen.html`);
  const trigger = (name) => page.getByRole("button", { name });
  await trigger("预览启动范围").waitFor();
  const focused = () => page.evaluate(() => document.activeElement?.className ?? "");
  const activeLabel = () => page.evaluate(() => {
    const panel = document.querySelector(".ui-dropdown-panel:not(.is-leaving)");
    const id = panel?.getAttribute("aria-activedescendant");
    return id ? document.getElementById(id)?.textContent ?? "" : "";
  });
  const panelGone = () => waitUntil(async () => (await page.locator(".ui-dropdown-panel").count()) === 0, "浮层退场放完");

  // 不带筛选的：键盘打开 → 焦点在浮层，下移一项。每一次都要这样。
  const plainRound = async (what) => {
    await trigger("预览启动范围").focus();
    await page.keyboard.press("ArrowDown");
    await waitUntil(async () => /ui-dropdown-panel/.test(await focused()), `${what}：焦点交给浮层`);
    assert.match(await activeLabel(), /只启动前端/, `${what}：从当前选中那一项起`);
    await page.keyboard.press("ArrowDown");
    assert.match(await activeLabel(), /只启动后端/, `${what}：方向键挑得动`);
    await page.keyboard.press("Escape");
    await waitUntil(async () => /ui-select-trigger/.test(await focused()), `${what}：关掉焦点回到触发键`);
  };
  await plainRound("第一次打开");
  await panelGone();
  await plainRound("退场放完再打开");
  // 退场还没放完（120ms 内）就再打开：浮层还在 DOM 里，同样要拿到焦点。
  await plainRound("退场中途再打开");
  await panelGone();

  // 带筛选的：再开时焦点在筛选框里，直接打字就筛。
  const filterRound = async (what) => {
    await trigger("模型").click();
    await waitUntil(async () => (await page.evaluate(() => document.activeElement?.tagName)) === "INPUT", `${what}：焦点交给筛选框`);
    await page.keyboard.type("11");
    await waitUntil(async () => (await page.locator(".ui-dropdown-panel .ui-dropdown-row").count()) === 1, `${what}：打字直接筛`);
    await page.keyboard.press("Escape");
  };
  await filterRound("第一次打开");
  await panelGone();
  await filterRound("退场放完再打开");
  assert.deepEqual(errors, [], "页面没有报错");
  console.log("select reopen dom ok: 每次打开焦点都交给浮层/筛选框，退场中途再开也一样");
} finally {
  await browser?.close();
  await web.close();
}
