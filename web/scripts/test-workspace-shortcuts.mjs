// G T 切「任务模式」的按键回归：真按键、真捕获阶段，跟 Inspector 的 `I …` 交叉着按。
// 跑法：npm -w web run test:workspace-shortcuts
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
  await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/workspace-shortcuts.html`);

  const scope = page.getByTestId("scope");
  const log = page.getByTestId("log");
  const type = async (keys) => {
    for (const key of keys) await page.keyboard.press(key);
  };

  await scope.waitFor();
  assert.equal(await scope.textContent(), "project");

  // G 接 T 进任务模式，同一个按法再来一次退回来 —— 没有单向的门。
  await type(["g", "t"]);
  await assertScope("tasks", "G T 应切进任务模式");
  await type(["g", "t"]);
  await assertScope("project", "再按一次 G T 应退回单项目态");
  assert.equal(await log.textContent(), "task-mode task-mode");

  // 中间插了别的键就作废：g j t 不算一次，得从头再按一遍。
  await type(["g", "j", "t"]);
  await assertScope("project", "g j t 不构成 G T");
  await type(["g", "t"]);
  await assertScope("tasks", "作废之后重新按 G T 仍应生效");
  await type(["g", "t"]);
  await assertScope("project", "复位到单项目态");

  // 这次改动最容易砸的一处：g 同时是 Inspector `I G` 的第二键。任务模式的和弦不能
  // 把它抢走，否则那一档面板再也开不出来。
  await type(["i", "g"]);
  assert.match(await log.textContent(), /inspector:g$/, "I G 必须照常触发，不能被 G T 的前缀吞掉");
  await assertScope("project", "I G 不应顺带切模式");

  // 交叉连打：`g i f t` 里那个 g 和那个 t 中间隔着一整条 Inspector 序列，不能串成一对。
  await type(["g", "i", "f", "t"]);
  await assertScope("project", "跨 Inspector 序列的 g 与 t 不能串成 G T");
  assert.match(await log.textContent(), /inspector:f$/, "Inspector 的 I F 仍应照常触发");

  // 半截 G 之后，别的单键快捷键仍然照常：c 该新建就新建。
  await type(["g", "c"]);
  assert.match(await log.textContent(), /create$/, "半截 G T 之后的单键快捷键仍应生效");
  await assertScope("project", "g c 不应切模式");

  // 输入框里 g t 是两个字符，不是快捷键。
  const entry = page.getByTestId("text-entry");
  await entry.click();
  await entry.type("gt");
  assert.equal(await entry.inputValue(), "gt");
  await assertScope("project", "输入框里的 g t 不应切模式");

  console.log("workspace shortcut tests passed");

  async function assertScope(expected, message) {
    await page.waitForFunction(
      (want) => document.querySelector('[data-testid="scope"]')?.textContent === want,
      expected,
      { timeout: 2_000 },
    ).catch(() => {});
    assert.equal(await scope.textContent(), expected, message);
  }
} finally {
  await browser?.close();
  await server.close();
}
