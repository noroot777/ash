// G 族和弦（G T / G S / G C / G Z）的按键回归：真按键、真捕获阶段，跟 Inspector 的
// `I …` 交叉着按。
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

  // 同一个前缀下的另一档：G S 进设置，且不能顺手把作用域也切了。
  await type(["g", "s"]);
  assert.match(await log.textContent(), /settings$/, "G S 应打开设置");
  await assertScope("project", "G S 不应顺带切模式");

  // 半截 G 之后，别的单键快捷键仍然照常：f 该切铺开就切铺开。（c 已升级为 G C 的
  // 第二键，不能再用它测这条。）
  await type(["g", "f"]);
  assert.match(await log.textContent(), /spread$/, "半截 G 之后的单键快捷键仍应生效");
  await assertScope("project", "g f 不应切模式");

  // 新档位：G C 常用命令弹层、G Z 终端抽屉 —— 都是开合切换，连按两轮必须发两次
  // （和弦触发后序列要复位，第二轮的 g 不能被上一轮吃掉）。
  await type(["g", "c"]);
  assert.match(await log.textContent(), /commands$/, "G C 应切换常用命令弹层");
  await type(["g", "c"]);
  assert.match(await log.textContent(), /commands commands$/, "再按一轮 G C 应再次触发（开合复位）");
  await type(["g", "z"]);
  assert.match(await log.textContent(), /terminal$/, "G Z 应切换终端抽屉");
  await type(["g", "z"]);
  assert.match(await log.textContent(), /terminal terminal$/, "再按一轮 G Z 应再次触发（开合复位）");

  // 无前缀的单键 c 仍是新建 —— G C 抢走的只是「g 之后的 c」。
  await type(["c"]);
  assert.match(await log.textContent(), /create$/, "无前缀的 c 仍应新建任务");

  // 聊天 / 助手 / 设置页把列表导航键关掉（enabled=false）。`G …` 一族的整个存在理由就是
  // 「在任何界面都按得到」，所以它必须穿过这道开关 —— 否则在聊天页按 G T 什么都不会发生。
  await toggleListNavigation("off");
  await type(["g", "t"]);
  await assertScope("tasks", "列表导航关掉后 G T 仍应切进任务模式");
  await type(["g", "t"]);
  await assertScope("project", "列表导航关掉后 G T 仍应能按同样两下退回来");
  await type(["g", "s"]);
  assert.match(await log.textContent(), /settings$/, "列表导航关掉后 G S 仍应打开设置");
  await type(["g", "c"]);
  assert.match(await log.textContent(), /commands$/, "列表导航关掉后 G C 仍应可用");
  await type(["g", "z"]);
  assert.match(await log.textContent(), /terminal$/, "列表导航关掉后 G Z 仍应可用");

  // 反过来，列表导航那几颗单键在那些界面上没有落点，一颗都不能响。
  const quiet = await log.textContent();
  await type(["c", "f", "j", "k", "r", "Escape", "Enter"]);
  assert.equal(await log.textContent(), quiet, "列表导航键在聊天 / 助手 / 设置页不应触发");
  // Inspector 的 `I …` 同理：那些界面上根本没有那块面板。
  await type(["i", "g"]);
  assert.equal(await log.textContent(), quiet, "列表导航关掉后 Inspector 快捷键不应触发");
  // 上一行那个 g 被 G 族当成了前缀，用一个无关键把它作废掉，后面的 t 才不会凑成一次切换。
  await type(["x", "t"]);
  await assertScope("project", "无关键之后的 t 不该接上早先的半截 g");

  await toggleListNavigation("on");

  // 输入框里 g t 是两个字符，不是快捷键。g c / g z 同理。
  const entry = page.getByTestId("text-entry");
  await entry.click();
  await entry.type("gt");
  assert.equal(await entry.inputValue(), "gt");
  await assertScope("project", "输入框里的 g t 不应切模式");
  const beforeEntry = await log.textContent();
  await entry.fill("");
  await entry.type("gcgz");
  assert.equal(await entry.inputValue(), "gcgz");
  assert.equal(await log.textContent(), beforeEntry, "输入框里的 g c / g z 不应触发弹层或终端");

  console.log("workspace shortcut tests passed");

  async function assertScope(expected, message) {
    await page.waitForFunction(
      (want) => document.querySelector('[data-testid="scope"]')?.textContent === want,
      expected,
      { timeout: 2_000 },
    ).catch(() => {});
    assert.equal(await scope.textContent(), expected, message);
  }

  // 切完必须**把焦点交还给页面**：焦点留在那颗按钮上时，后面按的 Enter 会当成点它，
  // 开关就在测试中途被偷偷拨回去了（这条断言因此假绿过一次）。
  async function toggleListNavigation(expected) {
    const toggle = page.getByTestId("toggle-enabled");
    await toggle.click();
    await toggle.evaluate((element) => element.blur());
    assert.equal(await page.getByTestId("enabled").textContent(), expected);
  }
} finally {
  await browser?.close();
  await server.close();
}
