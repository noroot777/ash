// 常用命令的几件事,各自钉住:
//   ① 命令正文是 Shell 编辑器(多行):默认一行高、跟着内容长、到上限就在框里滚、
//      拖底边能定高且记得住、双击恢复自适应;
//   ② 命令里带 `{{占位符}}` 时,点执行先弹框收值,取值随请求发出去;没占位符的照旧直接跑;
//   ③ 这颗 ▶ 只说当前项目的事:别的项目在跑不点亮它,连**切走后才落回来的旧会话事实**也不算
//      (第 2 轮逻辑审查:晚返回的跨项目结果会赖到新项目头上);
//   ④ 服务起着的时候,弹层头部那颗 ▶ 就地换成红框的停止;启动脚本自己退了、但它打印过的
//      端口还有人听(真·守护化)也算开着,**不要求配停止命令** —— 默认停法得自己立得住;
//      进程和端口两条线索都够不着时才靠「配了停止命令」推断,停过之后回到 ▶。
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
    (expected) => document.querySelectorAll(".shell-editor .cm-editor")[4]?.getBoundingClientRect().height === expected,
    5 * LINE + PADDING,
  );

  // 长到上限就封顶,内容在框里滚 —— 一条命令不该把设置页顶成长卷。
  await buildEditor.fill(Array.from({ length: 40 }, (_, i) => `echo ${i}`).join("\n"));
  await page.waitForFunction(
    (expected) => document.querySelectorAll(".shell-editor .cm-editor")[4]?.getBoundingClientRect().height === expected,
    16 * LINE + PADDING,
  );
  assert.ok(
    await buildBox.locator(".cm-scroller").evaluate((node) => node.scrollHeight > node.clientHeight + 1),
    "超过上限后应当在编辑器里纵向滚动，而不是把内容截掉",
  );

  // ② 拖底边定高:拖完就钉住,刷新回来还是那么高;双击恢复自适应。
  await buildEditor.fill("echo one");
  await page.waitForFunction((expected) =>
    document.querySelectorAll(".shell-editor .cm-editor")[4]?.getBoundingClientRect().height === expected, LINE + PADDING);
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
    document.querySelectorAll(".shell-editor .cm-editor")[4]?.getBoundingClientRect().height === expected, LINE + PADDING);

  // ③ 占位符在设置页就看得见,不用跑一遍才知道自己写没写对。
  const hints = page.locator(".project-commands__placeholders");
  assert.equal(await hints.count(), 1, "只有带占位符的那条命令显示提示");
  assert.match(await hints.first().innerText(), /分支/);

  // ④ 侧栏顶行那颗 ▶ 的弹层:多行命令只显示首行 + 共几行。
  const statusTrigger = page.getByRole("button", { name: /^常用命令（/ });
  const pop = page.getByRole("dialog", { name: "常用命令" });
  // 执行完弹层不一定关（没有新会话就留在原处），所以只在它关着时才点开。
  const openPop = async () => { if (await pop.count() === 0) await statusTrigger.click(); await pop.waitFor(); };
  await openPop();
  const checkoutRow = pop.locator(".cmd-pop__row").filter({ hasText: "切分支" });
  assert.equal(await checkoutRow.locator("code").innerText(), "git checkout {{分支}} … 共 2 行");

  // 别的项目在跑、本项目只开着交互 shell —— 这颗 ▶ 都不该点亮,也不该再有计数徽标
  // (用户 2026-09-19:其他项目在跑的不要在别的项目展示,按钮灰着、数字也不要)。
  assert.equal(await page.locator(".cmd-launcher.is-live").count(), 0, "别的项目在跑不该点亮这颗按钮");
  assert.equal(await page.locator(".cmd-launcher__count").count(), 0, "运行中的计数徽标已经退役");
  assert.doesNotMatch(await pop.innerText(), /其他项目|别家的 dev server/, "弹层里不该出现别的项目的现场");

  // 没跑过的命令不写「未启动」:默认态不是事件,旁边就摆着「执行」按钮(fixture 的
  // sessions 为空,弹层里每一条都是这个态,连头部 service 也是)。
  assert.equal(await pop.locator(".cmd-pop__row-state").count(), 0, "没跑过的命令不该显示状态文案");
  assert.doesNotMatch(await pop.innerText(), /未启动/, "弹层里不该再出现「未启动」");

  // ⑤ 带占位符 → 先弹框收值。必填没填不让执行。
  await checkoutRow.getByRole("button", { name: "执行 切分支" }).click();
  const dialog = page.getByRole("dialog", { name: /执行「切分支」/ });
  await dialog.waitFor();
  const confirm = dialog.getByRole("button", { name: "执行", exact: true });
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
  ], "取值应当随执行请求发给服务端");

  // ⑥ 没占位符的命令不多问一句,点了就跑。
  await openPop();
  await pop.locator(".cmd-pop__row").filter({ hasText: "构建" }).getByRole("button", { name: "执行 构建" }).click();
  await page.waitForFunction(() => JSON.parse(document.getElementById("calls").textContent).length === 2);
  const calls = JSON.parse(await page.getByTestId("calls").innerText());
  assert.deepEqual(calls[1], { path: "/api/projects/p-one/commands/plain/start", body: { values: {} } });
  assert.equal(await page.getByRole("dialog", { name: /执行「构建」/ }).count(), 0, "没有占位符就不该弹收值框");

  // ⑦ 上次填过的值下次预填 —— 改端口/换分支这类命令,多数时候值是同一个。
  await openPop();
  await pop.locator(".cmd-pop__row").filter({ hasText: "切分支" }).getByRole("button", { name: "执行 切分支" }).click();
  await dialog.waitFor();
  assert.equal(await dialog.locator("input").first().inputValue(), "release/1.2", "应当预填上次用过的取值");
  await page.keyboard.press("Escape");

  // ⑨ 服务起着的时候,头部那颗 ▶ **就地**换成红框的停止(用户 2026-10-26 点名)。
  const reopen = async () => {
    if (await pop.count()) await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector(".cmd-pop"));
    await statusTrigger.click();
    await pop.waitFor();
  };
  await page.evaluate(() => { window.__service = "live"; });
  await reopen();
  const stopButton = pop.getByRole("button", { name: "停止（跑停止命令）", exact: true });
  await stopButton.waitFor();
  assert.equal(
    await pop.getByRole("button", { name: "启动", exact: true }).count(),
    0,
    "起着的时候不该还摆着启动按钮 —— 要的是同一个位置换一颗",
  );
  const stopLook = await stopButton.evaluate((node) => {
    const style = getComputedStyle(node);
    return { color: style.color, shadow: style.boxShadow };
  });
  const channels = stopLook.color.match(/\d+/g).map(Number);
  assert.ok(
    channels[0] > channels[1] + 60 && channels[0] > channels[2] + 60,
    `停止按钮应当是红色的，实际 ${stopLook.color}`,
  );
  assert.match(stopLook.shadow, /inset/, "要的是红色线框（inset 描边），不是实心块");
  assert.match(await pop.locator(".cmd-pop__svc-state").innerText(), /运行中/);
  await stopButton.click();
  await page.waitForFunction(() => JSON.parse(document.getElementById("calls").textContent).length === 3);
  assert.equal(
    JSON.parse(await page.getByTestId("calls").innerText())[2].path,
    "/api/projects/p-one/commands/service/stop",
    "点停止就发 stop,默认停法(杀进程组)由服务端决定",
  );

  // ⑩ `docker compose up -d` 形状:启动脚本自己正常退了,服务活在 ash 的进程树之外。
  //    配了停止命令才敢这么推断,否则那条停止命令永远按不到。
  await page.evaluate(() => { window.__service = "detached"; });
  await reopen();
  await pop.getByRole("button", { name: "停止（跑停止命令）", exact: true }).waitFor();
  assert.match(
    await pop.locator(".cmd-pop__svc-state").innerText(),
    /已启动/,
    "退的是启动脚本,不是服务 —— 这里说「已退出」就把人骗了",
  );

  // ⑪ 停过之后回到 ▶:再点一次不会把停止脚本又跑一遍。
  await page.evaluate(() => { window.__service = "stopped"; });
  await reopen();
  await pop.getByRole("button", { name: "启动", exact: true }).waitFor();
  assert.equal(await pop.getByRole("button", { name: /^停止/ }).count(), 0);
  assert.match(await pop.locator(".cmd-pop__svc-state").innerText(), /已停止/);
  await page.evaluate(() => { delete window.__service; });
  await page.keyboard.press("Escape");

  // ⑫ **真·守护化**且没配停止命令:启动脚本早退了,但它打印过的端口还有人听 —— 这就是开着,
  //    ▶ 照样换成红框停止(用户 2026-10-26:「我不是说默认不填停止命令就是把启动起来的东西
  //    杀掉吗」。默认停法由服务端的进程组 + 端口兜底负责,前端不能反过来要求先配一条脚本)。
  await page.evaluate(() => { window.__service = "daemon"; });
  await page.getByRole("button", { name: "去掉停止命令" }).click();
  await page.waitForFunction(() =>
    JSON.parse(document.querySelector('[data-testid="config"]').textContent)?.service?.stopCommand === null);
  await reopen();
  await pop.getByRole("button", { name: "停止", exact: true }).waitFor();
  assert.equal(
    await pop.getByRole("button", { name: "启动", exact: true }).count(),
    0,
    "端口还有人听就是开着 —— 没配停止命令也不该摆回启动按钮",
  );
  assert.match(
    await pop.locator(".cmd-pop__svc-state").innerText(),
    /运行中（启动脚本已退出）/,
    "端口还有人听 = 在跑;「已启动」那档留给「只配了停止命令所以姑且认它开着」的推断",
  );
  await pop.getByRole("button", { name: "停止", exact: true }).click();
  await page.waitForFunction(() => JSON.parse(document.getElementById("calls").textContent).length === 4);
  assert.equal(
    JSON.parse(await page.getByTestId("calls").innerText())[3].path,
    "/api/projects/p-one/commands/service/stop",
    "没配停止命令时点停止照样发 stop,怎么杀是服务端的事",
  );

  // ⑬-前 同一套判据得管到**普通常用命令**那一行:它守护化之后(脚本退了、端口还有人听)
  //   要摆停止,不能一边头部说运行中、一边同形状的行显示「执行」。
  await page.evaluate(() => { window.__plainDaemon = true; });
  await reopen();
  await pop.getByRole("button", { name: "停止 构建", exact: true }).waitFor();
  assert.equal(
    await pop.getByRole("button", { name: "执行 构建", exact: true }).count(),
    0,
    "行按钮只认进程归属就会把守护化的服务说成已退出,再点一次起第二份",
  );
  assert.match(
    await pop.locator(".cmd-pop__row-state").last().innerText(),
    /运行中（启动脚本已退出）/,
  );
  await page.evaluate(() => { delete window.__plainDaemon; });

  // ⑬ 反面:启动脚本退了、端口上也没人、又没配停止命令 —— 没有任何线索说它还活着,
  //    这时认它开着就是猜。回到 ▶,并照实说退的是**启动脚本**。
  await page.evaluate(() => { window.__service = "detached"; });
  await reopen();
  await pop.getByRole("button", { name: "启动", exact: true }).waitFor();
  assert.equal(await pop.getByRole("button", { name: /^停止/ }).count(), 0);
  assert.match(await pop.locator(".cmd-pop__svc-state").innerText(), /启动脚本已退出/);
  await page.evaluate(() => { delete window.__service; });
  await page.keyboard.press("Escape");

  // ⑧ 切项目那一刻,上一个项目的会话事实可能还在飞(启停成功后的那次 refresh 尤其容易赶上)。
  //   它晚一步落回来,不能算到新项目头上 —— 否则「别的项目在跑」照样点亮了这颗 ▶,正是用户
  //   点名要去掉的那个误导。
  await page.keyboard.press("Escape");
  await page.evaluate(() => { window.__slowFact = true; });
  if (await pop.count()) await page.keyboard.press("Escape"); // 收值框关了,弹层还开着 —— 先合上
  await statusTrigger.click();           // 开弹层 = 对第一个项目发一次查询(这次慢 400ms)
  await pop.waitFor();
  await page.keyboard.press("Escape");   // 关掉弹层,但那次查询还在路上
  await page.getByRole("button", { name: "切项目" }).click();
  await page.waitForFunction(() => document.querySelector('[data-testid="config"]')?.textContent === '{"service":null,"commands":[]}');
  await page.waitForTimeout(800);        // 旧事实这会儿早落回来了
  assert.equal(
    await page.locator(".cmd-launcher.is-live").count(),
    0,
    "上一个项目晚返回的会话不该点亮新项目的 ▶",
  );

  assert.deepEqual(errors, [], "页面不应抛异常");
  console.log("command placeholders test passed");
} finally {
  await browser?.close();
  await server.close();
}
