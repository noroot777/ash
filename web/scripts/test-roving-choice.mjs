// 按钮当单选 / 分页用的那些组,**键盘走不走得动**(src/lib/useRovingChoice.ts)。
//
// 为什么要有这一条:这些组原本是 `<select>` 和 `<input type=radio>`,方向键换选、整组
// 一个 Tab 停靠点都是浏览器白送的;改成一排按钮之后全得自己补,而**没补的那一处从
// 界面上看不出来** —— 长相一模一样,只有用键盘的人按下去没反应。改成共用一份契约之
// 前,全应用有五份各自手写的拷贝,认的键各不相同(有的不认 Home/End,有的不认上下)。
//
// 所以这里不测某一个页面,测的是**契约本身在结构差得最远的几处都还成立**:
//   ① 整组只有一个 Tab 停靠点,就是选中的那一颗;一个都没选中时停在第一颗(否则整组
//      会被 Tab 跳过去,键盘用户根本进不来);
//   ② 方向键换选,焦点跟着走,到头回绕;Home / End 到两端;四个方向键都认(竖排的组
//      只认左右键 = 走不动);
//   ③ 禁用的那一档跳过去,不是停在上面;
//   ④ 组的 role 挂在别的组件上、整组在 portal 里,照样成立(候选是顺着 DOM 现找的);
//   ⑤ 组里混着的**外来按钮**(动作,不是这一组的取值)不被方向键接管;
//   ⑥ 页面上每一颗候选都找得到自己那个组 —— 这一条是 ④ 的反面,挂错层的话候选集会
//      空掉,表现就是「这一处的键盘不动」。
//
// 跑法:npm -w web run test:roving-choice
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
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  const failures = [];
  page.on("pageerror", (error) => failures.push(String(error)));
  await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/roving-choice.html`);
  await page.locator('[data-testid="pill"]').waitFor();

  /** 一组的现状:每颗候选的取值、选中位、Tab 停靠点、焦点在不在它身上。 */
  const groupState = (label) => page.$$eval(
    `[aria-label="${label}"] [data-choice-value]`,
    (nodes) => nodes.map((node) => ({
      value: node.dataset.choiceValue,
      picked: (node.getAttribute("aria-selected") ?? node.getAttribute("aria-checked")) === "true",
      stop: node.tabIndex === 0,
      focused: node === document.activeElement,
      disabled: node.disabled === true,
    })),
  );
  const text = (id) => page.locator(`[data-testid="${id}"]`).innerText();
  const focusedValue = () => page.evaluate(() => document.activeElement?.dataset?.choiceValue ?? null);
  const focusValue = async (label, value) =>
    page.locator(`[aria-label="${label}"] [data-choice-value="${value}"]`).focus();
  const stops = (state) => state.filter((item) => item.stop).map((item) => item.value);
  const picked = (state) => state.filter((item) => item.picked).map((item) => item.value);

  // ── ① 停靠点 ────────────────────────────────────────────────────────────
  const pill = await groupState("工作方式");
  assert.deepEqual(stops(pill), ["free"], "选中的那一颗才是整组的 Tab 停靠点");
  assert.deepEqual(picked(pill), ["free"], "选中位只该落在当前值上");

  // 一个都没选中(新建供应商时的协议二选一):停在第一颗,否则整组被 Tab 跳过去。
  const protocolFresh = await groupState("协议");
  assert.deepEqual(picked(protocolFresh), [], "新建时协议不预选");
  assert.deepEqual(stops(protocolFresh), ["anthropic"], "一个都没选中时 Tab 停在第一颗");

  // ── ② 方向键换选、焦点跟着走、到头回绕、Home/End ──────────────────────
  await focusValue("工作方式", "free");
  await page.keyboard.press("ArrowRight");
  assert.equal(await text("pill"), "preset", "右键换到下一档");
  assert.equal(await focusedValue(), "preset", "焦点跟着换过去(不跟着走 = 再按一下还在原地)");
  assert.deepEqual(stops(await groupState("工作方式")), ["preset"], "停靠点跟着选中位移动");
  await page.keyboard.press("ArrowRight");
  assert.equal(await text("pill"), "free", "到末尾回绕到第一颗");

  // 竖排的组认上下键,也认 Home/End —— 这一条曾经是 Inspector 图标条自己手写的那份
  // 实现独有的本事,别处没有。
  await focusValue("已打开的 Inspector 面板", "panel-0");
  await page.keyboard.press("ArrowDown");
  assert.equal(await text("rail"), "panel-1", "竖排图标条:下键换到下一个面板");
  await page.keyboard.press("End");
  assert.equal(await text("rail"), "panel-3", "End 到最后一个");
  assert.equal(await focusedValue(), "panel-3");
  await page.keyboard.press("ArrowDown");
  assert.equal(await text("rail"), "panel-0", "下键在末尾回绕");
  await page.keyboard.press("ArrowUp");
  assert.equal(await text("rail"), "panel-3", "上键在开头回绕");
  await page.keyboard.press("Home");
  assert.equal(await text("rail"), "panel-0", "Home 到第一个");
  // 图标条下面还坐着一颗「切换 Inspector 面板」的「+」:它是动作,不在这一组里。
  assert.equal(
    await page.locator('.inspector-host__add').getAttribute("data-choice-value"),
    null,
    "组外那颗「+」不该带上候选标记",
  );

  // 协议那一组是 role=radio,横着摆 —— 上下键同样要认(用户不会先量一下组的朝向)。
  await focusValue("协议", "anthropic");
  await page.keyboard.press("ArrowDown");
  assert.deepEqual(picked(await groupState("协议")), ["openai"], "radio 组认下键");
  await page.keyboard.press("ArrowLeft");
  assert.deepEqual(picked(await groupState("协议")), ["anthropic"], "左键换回上一档");

  // ── ④ 组的 role 在别的组件上(可横向滚那层) + 「全部」那一档是 undefined ──
  const logTabs = await groupState("服务日志");
  assert.equal(logTabs.length, 4, "服务日志条 = 全部 + 三个服务");
  assert.deepEqual(stops(logTabs), ["__all__"], "默认停在「全部」上");
  await focusValue("服务日志", "__all__");
  await page.keyboard.press("ArrowRight");
  assert.equal(await text("service"), "svc-web", "右键换到第一个服务");
  await page.keyboard.press("ArrowLeft");
  assert.equal(await text("service"), "全部", "左键换回「全部」,而且回的是 undefined 不是哨兵字串");
  await page.keyboard.press("ArrowLeft");
  assert.equal(await text("service"), "svc-worker", "在「全部」上再左键,回绕到最后一个服务");

  // ── ③ 禁用的那一档跳过去 + ⑤ 整组在 portal 里 ──────────────────────────
  await page.locator(".studio-submit-mode").click();
  const launch = await groupState("启动方式");
  assert.deepEqual(
    launch.filter((item) => item.disabled).map((item) => item.value),
    ["queue"],
    "台子上「创建并排队」是禁用的(团队任务不支持排队)",
  );
  await focusValue("启动方式", "run");
  await page.keyboard.press("ArrowRight");
  assert.equal(await text("launch"), "create", "禁用的那一档跳过去,不是停在上面");
  assert.equal(await focusedValue(), "create");
  await page.keyboard.press("ArrowLeft");
  assert.equal(await text("launch"), "run", "往回也跳过禁用那一档");
  await page.keyboard.press("Escape");

  // ── ⑤ 组里混着的外来按钮不被接管 ───────────────────────────────────────
  await focusValue("任务模式", "single");
  await page.keyboard.press("ArrowLeft");
  assert.equal(await focusedValue(), "duet", "回绕到最后一个**取值**,不是末尾那颗「开聊」");
  await page.keyboard.press("ArrowRight");
  assert.equal(await focusedValue(), "single", "正向同样跳过它");
  assert.ok(
    !(await text("log")).includes("mode:chat"),
    "方向键一次都不该替用户按下「开聊」",
  );

  // ── ⑥ 每一颗候选都找得到自己那个组 ─────────────────────────────────────
  const orphans = await page.$$eval(
    "[data-choice-value]",
    (nodes) => nodes
      .filter((node) => !node.closest('[role="radiogroup"],[role="tablist"]'))
      .map((node) => `${node.getAttribute("aria-label") ?? node.textContent?.trim() ?? ""}=${node.dataset.choiceValue}`),
  );
  assert.deepEqual(orphans, [], "候选必须待在带 role 的组容器里,否则那一处的键盘静悄悄地不动");

  assert.deepEqual(failures, [], "页面上不该有未捕获异常");
  console.log("test-roving-choice ok");
} finally {
  await browser?.close();
  await server.close();
}
