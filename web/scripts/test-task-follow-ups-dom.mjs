// 「后续追问」那一节的单键 Q：真按键、真渲染、真滚动。
// 钉的是用户报过的那一下（2026-11-03「按 Q 弹不开后续追问」）：Q 得把全部追问弹开，
// 不能只是把焦点挪过去 —— 默认那一条本来就露着，光挪焦点画面上什么都不变。
// 跑法：npm -w web run test:task-follow-ups-dom
import assert from "node:assert/strict";
import { launchChrome, startWebServer } from "./dom-stage.mjs";

const web = await startWebServer();

let browser;
try {
  browser = await launchChrome();
  const page = await browser.newPage();
  await page.goto(`${web.origin}/scripts/fixtures/task-follow-ups.html`);

  const head = page.locator(".task-inspector-follow-ups-head");
  const items = page.locator(".task-inspector-follow-ups li pre");
  await head.waitFor();
  const firstLines = async () => (await items.allTextContents()).map((text) => text.split("\n")[0]);
  const headState = () => head.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const view = element.closest(".task-inspector-scroll").getBoundingClientRect();
    return {
      expanded: element.getAttribute("aria-expanded"),
      focused: document.activeElement === element,
      inView: box.top >= view.top && box.bottom <= view.bottom,
    };
  });
  const settle = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));

  // 默认只露最新一条。
  assert.deepEqual(await firstLines(), ["最新那条"], "默认只露最新一条");
  assert.equal((await headState()).expanded, "false");

  // 先把那一节翻到眼前之外：Q 要把它带回来，而且弹开。
  await page.locator(".task-inspector-scroll").evaluate((element) => { element.scrollTop = 0; });
  await page.keyboard.press("q");
  await settle();
  assert.deepEqual(await firstLines(), ["最新那条", "中间那条", "最早那条"], "Q 应弹开全部追问，新的在上");
  assert.deepEqual(await headState(), { expanded: "true", focused: true, inView: true }, "弹开后标题在眼前、焦点在它上面");

  // 弹开着、就在眼前：再按一下收回。
  await page.keyboard.press("q");
  await settle();
  assert.deepEqual(await firstLines(), ["最新那条"], "再按 Q 应收回到只露最新一条");
  assert.equal((await headState()).expanded, "false");

  // 弹开着、却被翻到了眼前之外：那一下是「带我回去」，不收。
  await page.keyboard.press("q");
  await settle();
  await page.locator(".task-inspector-scroll").evaluate((element) => { element.scrollTop = element.scrollHeight; });
  assert.equal((await headState()).inView, false, "夹具得真把标题翻出可视区");
  await page.keyboard.press("q");
  await settle();
  assert.deepEqual(await headState(), { expanded: "true", focused: true, inView: true }, "翻走之后按 Q 应带回标题、保持弹开");

  // 输入框里的 q 是字，不是快捷键。
  const entry = page.getByTestId("text-entry");
  await entry.click();
  await entry.type("q");
  assert.equal(await entry.inputValue(), "q");
  assert.equal((await headState()).expanded, "true", "输入框里打 q 不应收起后续追问");

  console.log("task follow-ups Q tests passed");
} finally {
  await browser?.close();
  await web.close();
}
