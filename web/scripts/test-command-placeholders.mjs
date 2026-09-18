// 常用命令的两件新能力,各自钉住:
//   ① 命令正文是 Shell 编辑器(多行):默认一行高、跟着内容长、到上限就在框里滚、
//      拖底边能定高且记得住、双击恢复自适应;
//   ② 命令里带 `{{占位符}}` 时,点启动先弹框收值,取值随请求发出去;没占位符的照旧直接跑。
//
// 跑法：npm -w web run test:command-placeholders
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { chromeLaunchOptions } from "./chrome-path.mjs";
import { createServer } from "vite";

const LINE = 21;
const PADDING = 16;

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
  const page = await browser.newPage({ viewport: { width: 1100, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const url = `http://127.0.0.1:${address.port}/scripts/fixtures/command-placeholders.html`;
  await page.goto(url);

  const buildEditor = page.getByRole("textbox", { name: "构建的命令" });
  await buildEditor.waitFor();
  const buildBox = page.locator(".shell-editor").filter({ has: buildEditor });
  const heightOf = async (box) => (await box.locator(".cm-editor").boundingBox()).height;

  // ① 默认一行高:平时就一条命令,不该先占掉半屏。
  assert.equal(await heightOf(buildBox), LINE + PADDING, "单行命令的编辑器应当只有一行高");

  // 输入多行就自己长高(用户不必先拖)。
  const five = ["cd web", "npm ci", "npm run build", "cp -r dist ../out", "echo done"].join("\n");
  await buildEditor.fill(five);
  await page.waitForFunction(
    (expected) => document.querySelectorAll(".shell-editor .cm-editor")[3]?.getBoundingClientRect().height === expected,
    5 * LINE + PADDING,
  );

  // 长到上限就封顶,内容在框里滚 —— 一条命令不该把设置页顶成长卷。
  await buildEditor.fill(Array.from({ length: 40 }, (_, i) => `echo ${i}`).join("\n"));
  await page.waitForFunction(
    (expected) => document.querySelectorAll(".shell-editor .cm-editor")[3]?.getBoundingClientRect().height === expected,
    16 * LINE + PADDING,
  );
  assert.ok(
    await buildBox.locator(".cm-scroller").evaluate((node) => node.scrollHeight > node.clientHeight + 1),
    "超过上限后应当在编辑器里纵向滚动，而不是把内容截掉",
  );

  // ② 拖底边定高:拖完就钉住,刷新回来还是那么高;双击恢复自适应。
  await buildEditor.fill("echo one");
  await page.waitForFunction((expected) =>
    document.querySelectorAll(".shell-editor .cm-editor")[3]?.getBoundingClientRect().height === expected, LINE + PADDING);
  const foot = buildBox.locator(".shell-editor__foot");
  await foot.scrollIntoViewIfNeeded();
  const footBox = await foot.boundingBox();
  await page.mouse.move(footBox.x + footBox.width / 2, footBox.y + footBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(footBox.x + footBox.width / 2, footBox.y + footBox.height / 2 + 100, { steps: 5 });
  await page.mouse.up();
  const dragged = await heightOf(buildBox);
  assert.ok(dragged > LINE + PADDING + 80, `拖底边应当把编辑器拉高，实际 ${dragged}`);

  await page.reload();
  await page.getByRole("textbox", { name: "构建的命令" }).waitFor();
  const restored = await heightOf(page.locator(".shell-editor").filter({ has: page.getByRole("textbox", { name: "构建的命令" }) }));
  assert.equal(Math.round(restored), Math.round(dragged), "拖出来的高度应当记住（刷新后还是那么高）");

  const footAfter = page.locator(".shell-editor").filter({ has: page.getByRole("textbox", { name: "构建的命令" }) }).locator(".shell-editor__foot");
  await footAfter.dblclick();
  await page.waitForFunction((expected) =>
    document.querySelectorAll(".shell-editor .cm-editor")[3]?.getBoundingClientRect().height === expected, LINE + PADDING);

  // ③ 占位符在设置页就看得见,不用跑一遍才知道自己写没写对。
  const hints = page.locator(".project-commands__placeholders");
  assert.equal(await hints.count(), 1, "只有带占位符的那条命令显示提示");
  assert.match(await hints.first().innerText(), /分支/);

  // ④ 状态栏:多行命令只显示首行 + 共几行。
  const statusTrigger = page.getByRole("button", { name: "常用命令", exact: true });
  const pop = page.getByRole("dialog", { name: "常用命令" });
  // 执行完弹层不一定关（没有新会话就留在原处），所以只在它关着时才点开。
  const openPop = async () => { if (await pop.count() === 0) await statusTrigger.click(); await pop.waitFor(); };
  await openPop();
  const checkoutRow = pop.locator(".status-bar__row").filter({ hasText: "切分支" });
  assert.equal(await checkoutRow.locator("code").innerText(), "git checkout {{分支}} … 共 2 行");

  // ⑤ 带占位符 → 先弹框收值。必填没填不让执行。
  await checkoutRow.getByRole("button", { name: "启动 切分支" }).click();
  const dialog = page.getByRole("dialog", { name: /启动「切分支」/ });
  await dialog.waitFor();
  const confirm = dialog.getByRole("button", { name: "启动", exact: true });
  assert.equal(await confirm.isDisabled(), true, "必填占位符没填时不能执行");
  await dialog.locator("input").first().fill("release/1.2");
  assert.equal(
    await dialog.locator(".command-args__preview").innerText(),
    "git checkout release/1.2\ngit status",
    "预览应当显示这次真正会跑的命令",
  );
  await confirm.click();
  await page.waitForFunction(() => JSON.parse(document.getElementById("calls").textContent).length === 1);
  assert.deepEqual(JSON.parse(await page.getByTestId("calls").innerText()), [
    { path: "/api/projects/p-one/commands/checkout/start", body: { values: { 分支: "release/1.2" } } },
  ], "取值应当随启动请求发给服务端");

  // ⑥ 没占位符的命令不多问一句,点了就跑。
  await openPop();
  await pop.locator(".status-bar__row").filter({ hasText: "构建" }).getByRole("button", { name: "启动 构建" }).click();
  await page.waitForFunction(() => JSON.parse(document.getElementById("calls").textContent).length === 2);
  const calls = JSON.parse(await page.getByTestId("calls").innerText());
  assert.deepEqual(calls[1], { path: "/api/projects/p-one/commands/plain/start", body: { values: {} } });
  assert.equal(await page.getByRole("dialog", { name: /启动「构建」/ }).count(), 0, "没有占位符就不该弹收值框");

  // ⑦ 上次填过的值下次预填 —— 改端口/换分支这类命令,多数时候值是同一个。
  await openPop();
  await pop.locator(".status-bar__row").filter({ hasText: "切分支" }).getByRole("button", { name: "启动 切分支" }).click();
  await dialog.waitFor();
  assert.equal(await dialog.locator("input").first().inputValue(), "release/1.2", "应当预填上次用过的取值");
  await page.keyboard.press("Escape");

  assert.deepEqual(errors, [], "页面不应抛异常");
  console.log("command placeholders test passed");
} finally {
  await browser?.close();
  await server.close();
}
