// 底部坞的「开着的终端」搬到状态栏之后要钉住的几件事:
//   ① 抽屉收着也看得见开着的那几个终端,且它们就摆在「终端」按钮右边;
//   ② 只是看一眼 ≠ 开一个 —— 没展开过抽屉就绝不新建 shell 会话;
//   ③ 点一个 tab 就展开到它,展开后顶部、底部两份 tab 都能切换同一批终端;
//   ④ 「终端」后面写着快捷键 G Z;
//   ⑤ shell 的 ✕ 结束会话(DELETE),命令日志的 ✕ 只是收起;
//   ⑥ 切项目:上一个项目的 tab 立刻消失,新项目最多为自己建**一个** shell(第 1 轮逻辑审查
//      实锤过:旧 tab 被当成「新项目要建 shell」,切一次建了两个);
//   ⑦ 切走之后才返回的「打开这条命令日志」不算数 —— 它属于上一个项目(第 2 轮逻辑审查实锤过:
//      当前项目的抽屉被它展开,并在当前项目上凭空建了一个 shell)。
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
  const tabs = bar.locator(".status-bar__tab");
  const calls = async () => JSON.parse(await page.getByTestId("calls").textContent());

  // ① 收着也看得见:server 上那两条会话原样列在状态栏上。
  await tabs.first().waitFor();
  assert.equal(await tabs.count(), 2, "server 上开着的两个终端都应当列在状态栏");
  assert.deepEqual(await tabs.locator("b").allInnerTexts(), ["网页前端", "测试项目"]);
  assert.equal(await page.locator(".project-terminal").count(), 0, "这会儿抽屉还没展开");

  // 位置:就在「终端」按钮右边(用户点名的那个位置),不是别处。
  const buttonBox = await terminalButton.boundingBox();
  const stripBox = await bar.locator(".status-bar__tabs").boundingBox();
  assert.ok(stripBox.x >= buttonBox.x + buttonBox.width - 1, "开着的终端应当摆在「终端」按钮右边");
  assert.ok(
    Math.abs((stripBox.y + stripBox.height / 2) - (buttonBox.y + buttonBox.height / 2)) < 4,
    "它和「终端」按钮在同一行上",
  );

  // ② 只是看一眼,不该平白起一个 shell。
  assert.deepEqual(await calls(), [], "没展开过抽屉就不该新建会话");

  // ④ 快捷键提示写在按钮上,不只藏在 aria-label 里。
  assert.match(await terminalButton.innerText(), /终端\s*G Z/, "「终端」后面应当写着快捷键");

  // ③ 点底部 tab = 展开到它；抽屉顶栏同步显示同一批 tab。
  await tabs.filter({ hasText: "网页前端" }).locator(".status-bar__tab-open").click();
  await page.locator(".project-terminal").waitFor();
  const panelTabs = page.locator(".project-terminal__tabs .status-bar__tab");
  assert.equal(await panelTabs.count(), 2, "抽屉顶栏应镜像显示开着的终端");
  assert.equal(await tabs.filter({ hasText: "网页前端" }).evaluate((node) => node.classList.contains("is-active")), true);
  assert.equal(await page.locator(".project-terminal__bar > code").innerText(), "/workspace/p-one");

  // 从顶部切到另一个终端:上下两份选中态一起走。
  await panelTabs.filter({ hasText: "测试项目" }).locator(".status-bar__tab-open").click();
  assert.equal(await tabs.filter({ hasText: "测试项目" }).evaluate((node) => node.classList.contains("is-active")), true);
  assert.equal(await tabs.filter({ hasText: "网页前端" }).evaluate((node) => node.classList.contains("is-active")), false);
  assert.equal(await panelTabs.filter({ hasText: "测试项目" }).evaluate((node) => node.classList.contains("is-active")), true);

  const collapse = page.getByRole("button", { name: "收起终端（shell 与服务继续跑）" });
  assert.equal(await collapse.locator("svg").count(), 0, "收起按钮不应再显示成关闭用的叉号");

  // 展开着的抽屉里有现场(xterm 已经挂上)。
  await page.locator(".project-terminal__viewport:not([hidden]) .xterm").waitFor();

  // ⑤ 命令日志的 ✕ 只是收起,服务照跑 —— 不发 DELETE。
  await tabs.filter({ hasText: "网页前端" }).getByRole("button", { name: /^收起 网页前端/ }).click();
  await page.waitForFunction(() => document.querySelectorAll("footer.status-bar .status-bar__tab").length === 1);
  assert.deepEqual(await calls(), [], "收起命令日志不该结束会话");

  // shell 的 ✕ = 结束会话,tab 和抽屉一起收。
  await tabs.filter({ hasText: "测试项目" }).getByRole("button", { name: /^关闭 测试项目/ }).click();
  await page.waitForFunction(() => document.querySelectorAll("footer.status-bar .status-bar__tab").length === 0);
  assert.deepEqual(await calls(), ["delete:s-shell"], "关闭交互 shell 应当结束 server 上的会话");
  assert.equal(await page.locator(".project-terminal").count(), 0, "最后一个终端关掉后抽屉收起");

  // ＋ 新建:状态栏上就能开一个新终端,并且展开抽屉。
  await page.getByRole("button", { name: "新建 CLI" }).click();
  await page.locator(".project-terminal").waitFor();
  await page.waitForFunction(() => JSON.parse(document.querySelector("#calls").textContent).includes("create:p-one"));
  assert.equal(await tabs.count(), 1, "新建后状态栏上有这一个终端");

  // 「终端」按钮照旧是开合抽屉的那颗。
  await terminalButton.click();
  assert.equal(await page.locator(".project-terminal").count(), 0, "再点「终端」收起抽屉");
  assert.equal(await tabs.count(), 1, "收起只是不看了，终端还开着");

  // ⑥ 抽屉开着切项目:旧项目的 tab 一帧都不许交给新项目 —— 它会被当成「这个项目要建 shell」,
  //   平白多起一个(而且是在别人的项目上)。新项目自己需要的那一个照常建。
  const beforeReopen = await calls();
  await terminalButton.click();
  await page.locator(".project-terminal").waitFor();
  await page.waitForTimeout(500);
  // 收起再展开只是把现场摆回来:这个 tab 已经有会话了(自己建的,id 记在 sessionId 上),
  // 抽屉重挂载时不许再建一个。
  assert.deepEqual(await calls(), beforeReopen, `重新展开不该再建 shell，实际 ${JSON.stringify(await calls())}`);
  const before = await calls();
  await page.getByRole("button", { name: "切项目" }).click();
  await page.waitForFunction(() => document.querySelector(".status-bar__project span:last-child")?.textContent === "第二个项目");
  await page.waitForFunction(() => JSON.parse(document.querySelector("#calls").textContent).some((entry) => entry === "create:p-two"));
  await page.waitForTimeout(400); // 给「多建一个」留出暴露的时间,不然断言太早
  const afterSwitch = await calls();
  assert.deepEqual(
    afterSwitch.filter((entry) => entry === "create:p-two"),
    ["create:p-two"],
    `切到第二个项目最多建一个 shell，实际 ${JSON.stringify(afterSwitch)}`,
  );
  assert.deepEqual(
    afterSwitch.filter((entry) => entry.startsWith("create:p-one")),
    before.filter((entry) => entry.startsWith("create:p-one")),
    "切项目不该回头在上一个项目上再建 shell",
  );
  assert.equal(await tabs.count(), 1, "第二个项目只有它自己那一个终端");
  assert.doesNotMatch(await bar.locator(".status-bar__tabs").innerText(), /网页前端/, "上一个项目的现场不该跟过来");

  // 上面几条查的是落定之后;这条查**过程**——渲染给第二个项目的每一帧里都不许出现第一个
  // 项目的 tab。漏过去一帧就够抽屉照着它在新项目上建一个 shell(第 1 轮逻辑审查的现场)。
  const renders = await page.evaluate(() => window.__renders ?? []);
  const leaked = renders.filter((frame) => frame.project === "p-two" && frame.tabs.some((cwd) => cwd.includes("p-one")));
  assert.deepEqual(leaked, [], "第二个项目的渲染里混进了第一个项目的终端");

  // 切回去:第一个项目的会话还活着,按 server 的事实原样恢复(刚才新建的那个 shell +
  // 还在跑的命令日志),一个新会话都不用建。
  const beforeBack = await calls();
  await page.getByRole("button", { name: "切项目" }).click();
  await page.waitForFunction(() => document.querySelector(".status-bar__project span:last-child")?.textContent === "测试项目");
  await page.waitForTimeout(600); // 多建一个的话,这段时间足够它冒出来
  assert.deepEqual(await calls(), beforeBack, `切回已有活 shell 的项目不该再建会话，实际 ${JSON.stringify(await calls())}`);
  assert.equal(await tabs.count(), 2, "恢复的是 server 上那两条现场，不多不少");
  assert.match(await bar.locator(".status-bar__tabs").innerText(), /网页前端/, "还在跑的命令日志跟着现场回来");

  // ⑦ 在 A 点了「执行」,请求还没回来就切到了 B:那条 .then 捕获的仍是 A 的 openSession,照样
  //   会调进来。放它进来的话,展开的是**B** 的抽屉,而 tab 写进的是 A 的现场 —— B 看见「抽屉
  //   开着却没有 shell」,就在这个用户根本没碰过终端的项目上凭空起一个(第 2 轮逻辑审查)。
  //   先把 B 的现场清空,这样「有没有平白建一个」才看得见。
  await page.getByRole("button", { name: "切项目" }).click();
  await page.waitForFunction(() => document.querySelector(".status-bar__project span:last-child")?.textContent === "第二个项目");
  await tabs.first().waitFor();
  await tabs.getByRole("button", { name: /^关闭 第二个项目/ }).click();
  await page.waitForFunction(() => document.querySelectorAll("footer.status-bar .status-bar__tab").length === 0);
  await page.getByRole("button", { name: "切项目" }).click();
  await page.waitForFunction(() => document.querySelector(".status-bar__project span:last-child")?.textContent === "测试项目");
  await page.waitForFunction(() => document.querySelectorAll("footer.status-bar .status-bar__tab").length === 2);
  await page.getByRole("button", { name: "发起命令" }).click(); // 捕获此刻(项目 A)的那只回调
  await page.getByRole("button", { name: "切项目" }).click();
  await page.waitForFunction(() => document.querySelector(".status-bar__project span:last-child")?.textContent === "第二个项目");
  const beforeLate = await calls();
  await page.getByRole("button", { name: "命令结果晚返回" }).click();
  await page.waitForTimeout(600); // 抽屉要是被它展开了,引导 effect 这段时间足够建出一个 shell
  assert.deepEqual(await calls(), beforeLate, `别的项目晚返回的命令结果不该在当前项目建会话，实际 ${JSON.stringify(await calls())}`);
  assert.equal(await page.locator(".project-terminal").count(), 0, "没人碰过这个项目的终端，抽屉不该自己展开");
  assert.equal(await tabs.count(), 0, "上一个项目的命令日志不该挂到当前项目上");
  const notices = JSON.parse(await page.getByTestId("notices").textContent());
  assert.ok(
    notices.some((text) => text.includes("网页前端")),
    `日志没在这儿打开要说一声，实际 ${JSON.stringify(notices)}`,
  );

  assert.deepEqual(errors, [], "页面不应抛异常");
  console.log("terminal dock test passed");
} finally {
  await browser?.close();
  await server.close();
}
