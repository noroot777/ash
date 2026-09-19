// 底部坞的「开着的终端」搬到状态栏之后要钉住的几件事:
//   ① 抽屉收着也看得见开着的那几个终端,且它们就摆在「终端」按钮右边;
//   ② 只是看一眼 ≠ 开一个 —— 没展开过抽屉就绝不新建 shell 会话;
//   ③ 点一个 tab 就展开到它,tab 条不在抽屉里再来一份;
//   ④ 「终端」后面写着快捷键 G Z;
//   ⑤ shell 的 ✕ 结束会话(DELETE),命令日志的 ✕ 只是收起。
//
// 跑法：npm -w web run test:terminal-dock
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
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/terminal-dock.html`);

  const bar = page.locator(".status-bar");
  await bar.waitFor();
  const terminalButton = page.getByRole("button", { name: "终端（G Z）" });
  const tabs = page.locator(".status-bar__tab");
  const calls = async () => JSON.parse(await page.getByTestId("calls").textContent());

  // ① 收着也看得见:server 上那两条会话原样列在状态栏上。
  await tabs.first().waitFor();
  assert.equal(await tabs.count(), 2, "server 上开着的两个终端都应当列在状态栏");
  assert.deepEqual(await tabs.locator("b").allInnerTexts(), ["网页前端", "测试项目"]);
  assert.equal(await page.locator(".project-terminal").count(), 0, "这会儿抽屉还没展开");

  // 位置:就在「终端」按钮右边(用户点名的那个位置),不是别处。
  const buttonBox = await terminalButton.boundingBox();
  const stripBox = await page.locator(".status-bar__tabs").boundingBox();
  assert.ok(stripBox.x >= buttonBox.x + buttonBox.width - 1, "开着的终端应当摆在「终端」按钮右边");
  assert.ok(
    Math.abs((stripBox.y + stripBox.height / 2) - (buttonBox.y + buttonBox.height / 2)) < 4,
    "它和「终端」按钮在同一行上",
  );

  // ② 只是看一眼,不该平白起一个 shell。
  assert.deepEqual(await calls(), [], "没展开过抽屉就不该新建会话");

  // ④ 快捷键提示写在按钮上,不只藏在 aria-label 里。
  assert.match(await terminalButton.innerText(), /终端\s*G Z/, "「终端」后面应当写着快捷键");

  // ③ 点 tab = 展开到它;抽屉里不再有第二份 tab 条。
  await tabs.filter({ hasText: "网页前端" }).locator(".status-bar__tab-open").click();
  await page.locator(".project-terminal").waitFor();
  assert.equal(await page.locator(".project-terminal__tabs").count(), 0, "tab 条只在状态栏上有一份");
  assert.equal(await tabs.filter({ hasText: "网页前端" }).evaluate((node) => node.classList.contains("is-active")), true);
  assert.equal(await page.locator(".project-terminal__bar > code").innerText(), "/workspace/p-one");

  // 切到另一个终端:选中跟着走。
  await tabs.filter({ hasText: "测试项目" }).locator(".status-bar__tab-open").click();
  assert.equal(await tabs.filter({ hasText: "测试项目" }).evaluate((node) => node.classList.contains("is-active")), true);
  assert.equal(await tabs.filter({ hasText: "网页前端" }).evaluate((node) => node.classList.contains("is-active")), false);

  // 展开着的抽屉里有现场(xterm 已经挂上)。
  await page.locator(".project-terminal__viewport:not([hidden]) .xterm").waitFor();

  // ⑤ 命令日志的 ✕ 只是收起,服务照跑 —— 不发 DELETE。
  await tabs.filter({ hasText: "网页前端" }).getByRole("button", { name: /^收起 网页前端/ }).click();
  await page.waitForFunction(() => document.querySelectorAll(".status-bar__tab").length === 1);
  assert.deepEqual(await calls(), [], "收起命令日志不该结束会话");

  // shell 的 ✕ = 结束会话,tab 和抽屉一起收。
  await tabs.filter({ hasText: "测试项目" }).getByRole("button", { name: /^关闭 测试项目/ }).click();
  await page.waitForFunction(() => document.querySelectorAll(".status-bar__tab").length === 0);
  assert.deepEqual(await calls(), ["delete:s-shell"], "关闭交互 shell 应当结束 server 上的会话");
  assert.equal(await page.locator(".project-terminal").count(), 0, "最后一个终端关掉后抽屉收起");

  // ＋ 新建:状态栏上就能开一个新终端,并且展开抽屉。
  await page.getByRole("button", { name: "新建 CLI" }).click();
  await page.locator(".project-terminal").waitFor();
  await page.waitForFunction(() => JSON.parse(document.querySelector("#calls").textContent).includes("create"));
  assert.equal(await tabs.count(), 1, "新建后状态栏上有这一个终端");

  // 「终端」按钮照旧是开合抽屉的那颗。
  await terminalButton.click();
  assert.equal(await page.locator(".project-terminal").count(), 0, "再点「终端」收起抽屉");
  assert.equal(await tabs.count(), 1, "收起只是不看了，终端还开着");

  assert.deepEqual(errors, [], "页面不应抛异常");
  console.log("terminal dock test passed");
} finally {
  await browser?.close();
  await server.close();
}
