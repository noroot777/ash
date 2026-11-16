import assert from "node:assert/strict";
import { launchChrome, startWebServer } from "./dom-stage.mjs";
import { WAIT_TIMEOUT_MS } from "./wait-until.mjs";

const web = await startWebServer();
let browser;
try {
  browser = await launchChrome();
  const page = await browser.newPage();
  page.setDefaultTimeout(WAIT_TIMEOUT_MS);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${web.origin}/scripts/fixtures/task-drawers.html`);
  const current = (id) => page.locator(`[data-current-task="${id}"]`);
  const row = (id) => page.locator(`[data-subtask-id="${id}"]`);
  const pane = page.locator(".dispatched-pane");
  await pane.waitFor();
  assert.equal(await page.locator(".inspector-host__panel-title").textContent(), "子任务");
  assert.match(await page.locator(".dispatched-summary").textContent(), /2\/4/);
  assert.equal(await row("lead").count(), 0);
  assert.equal(await row("accepted").count(), 0);
  assert.equal(await row("leaf").count(), 0);
  await pane.locator('.dispatched-pips > button[aria-label="验收的子任务"]').hover();
  await row("accepted").waitFor();
  assert.equal(await row("accepted").evaluate((node) => node.classList.contains("is-hinted")), true);
  assert.equal(await row("accepted").locator("em, small, .workspace-status-dot").count(), 0);
  await page.locator(".task-detail-header").hover();
  await row("accepted").waitFor({ state: "detached" });
  await row("mid").locator(".dispatched-fold").click();
  await row("leaf").waitFor();
  await row("leaf").locator(".dispatched-row__title").click();
  await current("leaf").waitFor();
  assert.equal(await page.locator("aside.side-drawer").count(), 0);
  assert.match(page.url(), /task=leaf/);
  assert.equal(await row("leaf").locator('[aria-current="page"]').count(), 1);
  assert.match(await page.locator(".task-ancestry").innerText(), /父任务.*中间任务/s);
  await page.reload();
  await current("leaf").waitFor();
  await row("leaf").waitFor();
  await page.getByRole("button", { name: "父任务：父任务", exact: true }).click();
  await current("lead").waitFor();
  await page.goBack();
  await current("leaf").waitFor();
  await page.getByRole("button", { name: "切到files", exact: true }).click();
  await page.getByRole("button", { name: "父任务：父任务", exact: true }).click();
  await current("lead").waitFor();
  assert.equal(await page.locator(".inspector-host__panel-title").textContent(), "文件");
  await page.getByRole("button", { name: "切到dispatched", exact: true }).click();
  await pane.locator('.dispatched-pips > button[aria-label="提问的子任务"]').click();
  await current("kid-b").waitFor();
  await row("kid-b").waitFor();
  await page.getByRole("button", { name: "父任务：父任务", exact: true }).click();
  await current("lead").getByRole("button", { name: "打开子任务：运行的子任务" }).click();
  await current("kid-a").waitFor();

  await page.evaluate(() => window.__go("solo"));
  await current("solo").waitFor();
  await page.getByRole("button", { name: "隐藏 Inspector", exact: true }).click();
  await page.evaluate(() => window.__add({ id: "solo-child", title: "刚派出", dispatchedBy: "solo", status: "running", stage: null }));
  await pane.waitFor();
  assert.equal(await page.locator(".inspector-host__panel-title").textContent(), "子任务");
  await page.getByRole("button", { name: "切到info", exact: true }).click();
  await page.getByRole("button", { name: "隐藏 Inspector", exact: true }).click();
  await page.evaluate(() => window.__add({ id: "solo-child-2", title: "又一批", dispatchedBy: "solo", status: "queued", stage: null }));
  await pane.waitFor();
  for (const id of ["side-chat", "memos"]) {
    await page.getByRole("button", { name: `切到${id}`, exact: true }).click();
    await page.evaluate((suffix) => window.__add({ id: `preserve-${suffix}`, title: "不抢", dispatchedBy: "solo" }), id);
    assert.equal(await page.locator(".inspector-host__panel-title").textContent(), id === "memos" ? "备忘" : "侧聊");
  }
  await page.getByRole("button", { name: "切到info", exact: true }).click();
  await page.evaluate(() => window.__add({ id: "elsewhere", title: "别处派出", dispatchedBy: "lead" }));
  assert.equal(await page.locator(".inspector-host__panel-title").textContent(), "信息");

  await page.evaluate(() => window.__go("lead"));
  await pane.waitFor();
  for (const total of [7, 26]) {
    await page.evaluate((count) => {
      const existing = document.querySelectorAll(".dispatched-pips > button").length;
      for (let index = existing; index < count; index++) window.__add({ id: `bulk-${index}`, title: `完成 ${index}`, dispatchedBy: "lead" });
    }, total);
    await page.waitForFunction((count) => document.querySelectorAll(".dispatched-pips > button").length === count, total);
    const sizes = await pane.locator(".dispatched-pips > button").evaluateAll((nodes) => nodes.map((node) => [node.getBoundingClientRect().width, node.getBoundingClientRect().height]));
    assert.ok(sizes.every(([width, height]) => width === 14 && height === 24));
  }
  const midFold = row("mid").locator(".dispatched-fold");
  if (await midFold.getAttribute("aria-expanded") === "true") await midFold.click();
  await row("leaf").waitFor({ state: "detached" });
  await page.getByRole("button", { name: "切到info", exact: true }).click();
  await page.getByRole("button", { name: "切到dispatched", exact: true }).click();
  assert.equal(await midFold.getAttribute("aria-expanded"), "false", "切格回来保留用户折叠");
  await page.getByRole("button", { name: "切到info", exact: true }).click();
  await page.keyboard.press("Meta+k");
  const search = page.locator(".palette-input input");
  await search.fill("最下层任务");
  const hit = page.locator('[data-search-key="task:leaf"]');
  await hit.waitFor();
  assert.match(await hit.innerText(), /父任务 › 中间任务 › 最下层任务/);
  assert.match(await page.locator(".palette-preview h2").innerText(), /父任务 › 中间任务 › 最下层任务/);
  await search.press("Enter");
  await current("leaf").waitFor();
  await row("leaf").waitFor();
  assert.equal(await page.locator(".inspector-host__panel-title").textContent(), "子任务");

  await page.getByRole("button", { name: "切到subagents", exact: true }).click();
  const agent = page.locator(".native-work__agent .native-work__row").first();
  if (await agent.getAttribute("aria-expanded") !== "true") await agent.click();
  await page.getByRole("button", { name: /^查看执行：/ }).first().click();
  await page.locator("aside.side-drawer--subagent").waitFor();
  await page.getByRole("button", { name: "读审查报告", exact: true }).click();
  await page.locator('aside.side-drawer[aria-label="审查报告：第 1 轮"]').waitFor();
  assert.equal(await page.locator("aside.side-drawer").count(), 1);
  await page.evaluate(() => {
    window.__add({ id: "deep", title: "第四层", dispatchedBy: "leaf" });
    window.__add({ id: "deepest", title: "第五层", dispatchedBy: "deep" });
  });
  await row("leaf").locator(".dispatched-fold").waitFor();
  await page.evaluate(() => window.__go("deepest"));
  await current("deepest").waitFor();
  await page.getByRole("button", { name: "展开中间的父任务", exact: true }).click();
  await page.locator(".task-crumb-menu").getByRole("button", { name: "父任务：中间任务", exact: true }).click();
  await current("mid").waitFor();
  assert.deepEqual(errors, []);
  console.log("✓ 子任务整页导航、来路、历史、⌘K、自动落格、固定小点与剩余抽屉互斥");
} finally { await browser?.close(); await web.close(); }
