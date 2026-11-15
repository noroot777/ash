// 派活单（task-detail/DispatchPlanCard.tsx + QuestionSlot.tsx）在真浏览器里：停在回复框那一格、全页一处输入；
// 去掉一条、改交给谁、切「同时」以后派出去的就是卡上那个样子；失败了卡上的改动不丢；写了字那颗键变「发回去改」
// 且交出去的是答复；全去掉时派不出去；那一轮没结束点不动；点标题在左抽屉里读全文；
// 「派出去的活交给谁」在回复框胶囊点开那一层里，设了以后胶囊上看得见、卡上没指明的几行跟着它；窄屏不横向溢出。
// 跑法：npm -w web run test:dispatch-plan-dom
import assert from "node:assert/strict";
import { launchChrome, startWebServer } from "./dom-stage.mjs";
import { WAIT_TIMEOUT_MS } from "./wait-until.mjs";

const PROFILES = [
  { id: "claude-main", name: "claude@local", type: "claude", isDefault: true },
  { id: "codex-main", name: "codex@local", type: "codex", isDefault: true },
];
const web = await startWebServer();
let browser;
const failures = [];
try {
  browser = await launchChrome();
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  page.setDefaultTimeout(WAIT_TIMEOUT_MS);
  page.on("pageerror", (error) => failures.push(error.message));
  await page.route("**/api/**", (route) => route.fulfill({
    status: 200, contentType: "application/json",
    body: new URL(route.request().url()).pathname.endsWith("/agents") ? JSON.stringify(PROFILES) : "[]",
  }));
  await page.goto(`${web.origin}/scripts/fixtures/dispatch-plan.html`);

  const card = page.locator(".question-card.dispatch-plan");
  const send = card.locator(".question-card-send");
  const note = card.getByRole("textbox", { name: "补一句要求，或者说哪里不对" });
  const replyBox = page.getByRole("textbox", { name: "回复任务" });
  const rows = card.locator(".dispatch-plan-row");
  const chip = (n) => card.getByRole("group", { name: new RegExp(`^第 ${n} 条「`) });
  const handed = async () => JSON.parse(await page.getByLabel("交出去的东西").innerText());
  const reset = async () => { await page.reload(); await card.waitFor(); };

  // 卡停在回复框那一格，展开时平常那个框不出现：全页一处输入、一颗发送键。
  await card.waitFor();
  assert.equal(await page.locator(".task-reply-shell > .question-dock > .dispatch-plan").count(), 1);
  assert.equal(await replyBox.isVisible(), false);
  assert.equal(await page.locator("textarea:visible").count(), 1, "全页只有一处打字的地方");
  assert.equal(await card.locator(".dispatch-plan-title").innerText(), "派出这 3 个任务");
  assert.equal(await rows.count(), 3);
  assert.equal(await send.innerText(), "派出去");
  // 读屏念得出每一行交给谁：没指明的跟这里（claude），第 2 条单子上写了 codex。
  await page.waitForFunction(() => document.querySelector('[aria-label^="第 1 条「服务端接口」交给 claude@local"]'));
  assert.equal(await chip(2).getAttribute("aria-label"), "第 2 条「前端卡片」交给 codex@local");
  assert.equal(await card.locator(".dispatch-plan-text small").first().innerText(), "先做，后两条依赖它");
  assert.equal(await card.getByRole("button", { name: "一个接一个" }).getAttribute("aria-pressed"), "true");

  // 点标题：左抽屉里读完整说明（它盖住中间那一栏），从抽屉上关。
  await card.getByRole("button", { name: "第 1 条：服务端接口，读完整说明" }).click();
  const reading = page.getByRole("dialog", { name: "完整说明：服务端接口" }).or(page.getByLabel("完整说明：服务端接口"));
  await reading.first().waitFor();
  assert.match(await reading.first().innerText(), /加一条摆单端点，落暂停/);
  await page.getByRole("button", { name: "关上完整说明" }).click();
  await reading.first().waitFor({ state: "detached" });

  // 叉指到才出；键盘落到它上面也看得见。按掉第 3 条：剩两条，卡头跟着改，焦点落到下一颗叉上。
  const drop3 = card.getByRole("button", { name: "第 3 条「回归测试」不派" });
  await drop3.focus();
  // 有一段淡入：等它走完再读。
  await drop3.evaluate((el) => new Promise((resolve) => {
    const check = () => getComputedStyle(el).opacity === "1" ? resolve() : requestAnimationFrame(check);
    check();
  }));
  await page.keyboard.press("Enter");
  assert.equal(await card.locator(".dispatch-plan-title").innerText(), "派出这 2 个任务");
  assert.equal(await rows.count(), 2);
  await page.waitForFunction(() => document.activeElement?.matches(".dispatch-plan-drop"));
  assert.equal(await card.getByRole("button", { name: "还原 1 条" }).isVisible(), true);

  // 第 1 条改交给 codex；切成「同时」。
  await chip(1).getByRole("button", { name: /^智能体：/ }).click();
  await page.getByRole("option", { name: /@codex/ }).click();
  await page.keyboard.press("Escape");
  assert.match(await chip(1).getAttribute("aria-label"), /交给 codex/);
  await card.getByRole("button", { name: "同时" }).click();
  assert.equal(await card.getByRole("button", { name: "同时" }).getAttribute("aria-pressed"), "true");

  // 派出失败：说得出来，卡上的改动都还在。
  await page.getByLabel("模拟派出失败").check();
  await send.click();
  await card.getByRole("alert").waitFor();
  assert.match(await card.getByRole("alert").innerText(), /派出失败/);
  assert.equal(await rows.count(), 2);
  assert.match(await chip(1).getAttribute("aria-label"), /交给 codex/);
  await page.getByLabel("模拟派出失败").uncheck();

  // 派出去：交给 ash 的就是卡上此刻的样子。
  await send.click();
  await card.waitFor({ state: "detached" });
  const launch = await handed();
  assert.equal(launch.kind, "launch");
  assert.equal(launch.planId, "plan-1");
  assert.equal(launch.order, "parallel");
  assert.deepEqual(launch.items.map((item) => [item.index, item.target.agentType]), [[0, "codex"], [1, "codex"]]);
  assert.equal(launch.items[1].target.executorId, "codex-main");
  assert.equal(await replyBox.isVisible(), true, "派完卡收回，平常的回复框回来");

  // 写了字：那颗键变「发回去改」，交出去的是一句答复，不是派出。
  await reset();
  await note.fill("第 2 条拆成两条");
  assert.equal(await send.innerText(), "发回去改");
  await note.press(process.platform === "darwin" ? "Meta+Enter" : "Control+Enter");
  await card.waitFor({ state: "detached" });
  assert.deepEqual(await handed(), { kind: "answer", answer: "第 2 条拆成两条" });

  // 全去掉了：派不出去；写一句就能发回去。还原回来照常。
  await reset();
  for (const name of ["第 1 条「服务端接口」不派", "第 1 条「前端卡片」不派", "第 1 条「回归测试」不派"]) {
    await card.getByRole("button", { name }).click();
  }
  assert.equal(await rows.count(), 0);
  assert.equal(await send.isDisabled(), true, "一条不剩时派不出去");
  await note.fill("都不要了，换个思路");
  assert.equal(await send.isDisabled(), false);
  assert.equal(await send.innerText(), "发回去改");
  await note.fill("");
  await card.getByRole("button", { name: "还原 3 条" }).click();
  assert.equal(await rows.count(), 3);

  // 摆单那一轮还没结束：什么都点不动，最后一行写着什么时候能派。
  await page.getByRole("button", { name: "切换摆单状态" }).click();
  assert.equal(await send.isDisabled(), true);
  assert.equal(await note.getAttribute("placeholder"), "这一轮结束后即可派出");
  assert.equal(await card.getByRole("button", { name: "同时" }).isDisabled(), true);
  await page.getByRole("button", { name: "切换摆单状态" }).click();
  assert.equal(await send.isDisabled(), false);

  // 收起：只剩一行，平常的回复框出现在它下面。
  await card.getByRole("button", { name: "收起派活单，先看上文" }).click();
  assert.equal(await card.locator(".question-card-peek").innerText(), "派出这 3 个任务");
  assert.equal(await replyBox.isVisible(), true);

  // 「派出去的活交给谁」：回复框胶囊点开智能体那一段，列表下面那一行；默认「同这里」。
  const standing = page.getByRole("group", { name: "这个任务以后由谁来跑" });
  await standing.getByRole("button", { name: /^智能体：/ }).click();
  const defaults = page.getByRole("group", { name: "派出去的活交给谁" });
  await defaults.waitFor();
  assert.equal(await defaults.getByRole("button", { name: "派出去的活交给谁：同这里" }).getAttribute("aria-pressed"), "true");
  await defaults.getByRole("group").getByRole("button", { name: /^智能体：/ }).click();
  await page.locator(".agent-model-picker").last().getByRole("option", { name: /@codex/ }).click();
  await page.waitForFunction(() => document.querySelector('[aria-label="交出去的东西"]')?.textContent?.includes('"target"'));
  const picked = await handed();
  assert.equal(picked.target.agentType, "codex");
  // 浮层一层层退下：Esc 一次只关最上面那层。
  for (let i = 0; i < 4 && await page.locator(".agent-model-picker").count(); i += 1) await page.keyboard.press("Escape");
  assert.equal(await page.locator(".agent-model-picker").count(), 0);
  // 胶囊上看得见，不点开也知道派出去的活不交给这里。
  assert.match(await standing.getByLabel("派出去的活交给 codex@local").innerText(), /^派活\s+codex@local$/);
  // 卡上没指明的那几行跟着它走。
  await card.locator(".question-card-peek").click();
  await page.waitForFunction(() => document.querySelector('[aria-label^="第 1 条「服务端接口」交给 codex@local"]'));
  assert.equal(await chip(3).getAttribute("aria-label"), "第 3 条「回归测试」交给 codex@local");

  // 改回「同这里」：胶囊上那一段没了。
  await card.getByRole("button", { name: "收起派活单，先看上文" }).click();
  await standing.getByRole("button", { name: /^智能体：/ }).click();
  await page.getByRole("button", { name: "派出去的活交给谁：同这里" }).click();
  await page.waitForFunction(() => document.querySelector('[aria-label="交出去的东西"]')?.textContent === '{"kind":"target","target":null}');
  await page.keyboard.press("Escape");
  assert.equal(await standing.getByLabel(/^派出去的活交给 /).count(), 0);

  // 窄屏：卡和整页都不横向溢出，行尾的胶囊换到下一行。
  await page.setViewportSize({ width: 360, height: 780 });
  await reset();
  const overflow = await page.evaluate(() => {
    const el = document.querySelector(".dispatch-plan");
    return { page: document.documentElement.scrollWidth - document.documentElement.clientWidth, card: el.scrollWidth - el.clientWidth };
  });
  assert.deepEqual(overflow, { page: 0, card: 0 }, "窄屏不横向溢出");

  assert.deepEqual(failures, []);
  console.log("✓ dispatch plan card dom");
} finally {
  await browser?.close();
  await web.close();
}
