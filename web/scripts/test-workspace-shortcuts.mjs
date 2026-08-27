// T T 切「任务模式」的按键回归：真按键、真捕获阶段，跟 Inspector 的 `I …` 交叉着按。
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

  // 连按两下就进任务模式，再连按两下退回来 —— 同一个按法进出，没有单向的门。
  await type(["t", "t"]);
  await assertScope("tasks", "T T 应切进任务模式");
  await type(["t", "t"]);
  await assertScope("project", "再按一次 T T 应退回单项目态");
  assert.equal(await log.textContent(), "task-mode task-mode");

  // 中间插了别的键就作废：t j t 不算一次，紧跟着的那下 t 才补成新的一对。
  await type(["t", "j", "t"]);
  await assertScope("project", "t j t 不构成 T T");
  await type(["t"]);
  await assertScope("tasks", "作废之后重新连按两下仍应生效");
  await type(["t", "t"]);
  await assertScope("project", "复位到单项目态");

  // 交叉连打：`t i f t` 里那两个 t 中间隔着一整条 Inspector 序列，不能被算成一对。
  await type(["t", "i", "f", "t"]);
  await assertScope("project", "跨 Inspector 序列的两个 t 不能串成 T T");
  assert.match(await log.textContent(), /inspector:f$/, "Inspector 的 I F 仍应照常触发");

  // 反过来 Inspector 的前缀也不该被 T T 吃掉：t 之后紧跟 i f 照样开得出面板。
  await type(["i", "f"]);
  assert.match(await log.textContent(), /inspector:f inspector:f$/, "T T 的前缀不应吞掉后续的 I F");

  // 第一下 t 被吞掉之后，别的单键快捷键仍然照常：c 该新建就新建。
  await type(["t", "c"]);
  assert.match(await log.textContent(), /create$/, "半截 T T 之后的单键快捷键仍应生效");
  await assertScope("project", "t c 不应切模式");

  // 输入框里 t t 是两个字符，不是快捷键。
  const entry = page.getByTestId("text-entry");
  await entry.click();
  await entry.type("tt");
  assert.equal(await entry.inputValue(), "tt");
  await assertScope("project", "输入框里的 t t 不应切模式");

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
