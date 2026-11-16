import assert from "node:assert/strict";
import { launchChrome, startWebServer } from "./dom-stage.mjs";
import { settlePage, WAIT_TIMEOUT_MS } from "./wait-until.mjs";

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
  await page.evaluate(() => window.__add({ id: "accepted-leaf", title: "验收孙任务", dispatchedBy: "accepted" }));
  await pane.locator('.dispatched-pips > button[aria-label="验收的子任务"]').click();
  await current("accepted").waitFor();
  await row("accepted").locator(".dispatched-fold").waitFor();
  await page.evaluate(() => window.__go("accepted-leaf"));
  await current("accepted-leaf").waitFor();
  await row("accepted-leaf").waitFor();
  await page.getByRole("button", { name: "切到info", exact: true }).click();
  await page.getByRole("button", { name: "切到dispatched", exact: true }).click();
  await row("accepted-leaf").waitFor();
  assert.equal(await page.evaluate(() => sessionStorage.getItem("ash:subtasks:folds:lead")), null, "选中路径的自动展开不写入偏好");
  await page.getByRole("button", { name: "父任务：父任务", exact: true }).click();
  await current("lead").waitFor();
  await row("accepted").waitFor({ state: "detached" });
  await pane.locator(".dispatched-accepted").first().click();
  await row("accepted").waitFor();
  await pane.locator('.dispatched-pips > button[aria-label="验收的子任务"]').click();
  await current("accepted").waitFor();
  await page.getByRole("button", { name: "父任务：父任务", exact: true }).click();
  await current("lead").waitFor();
  await row("accepted").waitFor();
  assert.equal(await pane.locator(".dispatched-accepted").first().getAttribute("aria-expanded"), "true", "用户手动展开仍然保留");
  await pane.locator(".dispatched-accepted").first().click();
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
  await page.getByRole("button", { name: "切到files", exact: true }).click();
  await page.evaluate(() => window.__patch("kid-a", { status: "queued" }));
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("ash:inspector:task:kid-a")).policyKey.includes(":queued:"));
  assert.equal(await page.locator(".inspector-host__panel-title").textContent(), "信息", "状态换挡沿用原来的默认格，不强切子任务");
  await page.getByRole("button", { name: "切到dispatched", exact: true }).click();
  await page.getByRole("button", { name: "关闭子任务", exact: true }).click();
  await page.evaluate(() => window.__patch("kid-a", { status: "paused" }));
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("ash:inspector:task:kid-a")).policyKey.includes(":paused:"));
  assert.ok(await page.evaluate(() => JSON.parse(localStorage.getItem("ash:inspector:task:kid-a")).dismissed.includes("dispatched")), "状态变化不撤销手动摘除");
  await page.getByRole("button", { name: "切到info", exact: true }).click();
  await page.getByRole("button", { name: "隐藏 Inspector", exact: true }).click();
  await page.evaluate(() => window.__patch("kid-a", { status: "done", stage: "awaiting_acceptance" }));
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("ash:inspector:task:kid-a")).policyKey.includes(":done:review"));
  assert.equal(await page.locator(".inspector-host").count(), 0, "待验收换挡不强开用户关掉的面板");
  await page.getByRole("button", { name: "显示 Inspector", exact: true }).click();
  assert.equal(await page.locator(".inspector-host__panel-title").textContent(), "审议");

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

  const narrowPage = await browser.newPage({ viewport: { width: 400, height: 860 } });
  narrowPage.setDefaultTimeout(WAIT_TIMEOUT_MS);
  narrowPage.on("pageerror", (error) => errors.push(error.message));
  await narrowPage.goto(`${web.origin}/scripts/fixtures/task-drawers.html`);
  await narrowPage.locator('[data-current-task="lead"]').waitFor();
  assert.equal(await narrowPage.locator(".inspector-host").count(), 0, "窄屏进入父任务不盖住会话");
  await narrowPage.getByRole("button", { name: "显示 Inspector", exact: true }).click();
  await narrowPage.locator('[data-subtask-id="kid-b"] .dispatched-row__title').click();
  await narrowPage.locator('[data-current-task="kid-b"]').waitFor();
  assert.equal(await narrowPage.locator(".inspector-host").count(), 0, "窄屏点进子任务后会话直接可见");
  assert.equal(await narrowPage.getByRole("textbox", { name: "回话给提问的子任务", exact: true }).isVisible(), true);
  await narrowPage.reload();
  await narrowPage.locator('[data-current-task="kid-b"]').waitFor();
  assert.equal(await narrowPage.locator(".inspector-host").count(), 0, "窄屏刷新仍不盖住会话");
  await narrowPage.keyboard.press("Meta+k");
  const narrowSearch = narrowPage.locator(".palette-input input");
  await narrowSearch.fill("验收的子任务");
  await narrowPage.locator('[data-search-key="task:accepted"]').waitFor();
  await narrowSearch.press("Enter");
  await narrowPage.locator('[data-current-task="accepted"]').waitFor();
  assert.equal(await narrowPage.locator(".inspector-host").count(), 0, "窄屏搜索进入也不盖住会话");
  await narrowPage.getByRole("button", { name: "显示 Inspector", exact: true }).click();
  await narrowPage.locator('[data-subtask-id="accepted"]').waitFor();
  await narrowPage.getByRole("button", { name: "收起 Inspector", exact: true }).click();
  await narrowPage.evaluate(() => window.__add({ id: "narrow-arrival", title: "窄屏刚派出", dispatchedBy: "accepted", status: "running", stage: null }));
  await narrowPage.locator(".dispatched-pane").waitFor();
  assert.equal(await narrowPage.locator(".inspector-host__panel-title").textContent(), "子任务", "窄屏仅新派出时自动展开");
  await narrowPage.getByRole("button", { name: "收起 Inspector", exact: true }).click();
  await narrowPage.evaluate(() => window.__patch("accepted", { status: "paused", stage: null }));
  await narrowPage.waitForFunction(() => JSON.parse(localStorage.getItem("ash:inspector:task:accepted")).policyKey.includes(":paused:"));
  assert.equal(await narrowPage.locator(".inspector-host").count(), 0, "窄屏状态变化不重新盖层");
  for (const id of ["side-chat", "memos"]) {
    await narrowPage.getByRole("button", { name: `切到${id}`, exact: true }).click();
    await narrowPage.getByRole("button", { name: "收起 Inspector", exact: true }).click();
    await narrowPage.evaluate((suffix) => window.__add({ id: `narrow-preserve-${suffix}`, title: "窄屏不抢", dispatchedBy: "accepted" }), id);
    await narrowPage.waitForFunction((count) => JSON.parse(localStorage.getItem("ash:inspector:task:accepted")).focusKey === String(count), id === "side-chat" ? 2 : 3);
    assert.equal(await narrowPage.locator(".inspector-host").count(), 0, "侧聊和备忘不因新派出弹出盖层");
  }

  for (const width of [1600, 400]) {
    const cold = await browser.newPage({ viewport: { width, height: 900 } });
    cold.setDefaultTimeout(WAIT_TIMEOUT_MS);
    cold.on("pageerror", (error) => errors.push(error.message));
    await cold.goto(`${web.origin}/scripts/fixtures/task-drawers.html?partial=1&task=lead`);
    await cold.locator('[data-current-task="lead"]').waitFor();
    if (width > 720) await cold.getByRole("button", { name: "切到files", exact: true }).click();
    else assert.equal(await cold.locator(".inspector-host").count(), 0);
    await cold.evaluate(() => window.__hydrate());
    await cold.waitForFunction(() => window.__tasks().length === 7);
    if (width > 720) {
      assert.equal(await cold.locator(".inspector-host__panel-title").textContent(), "文件", "冷启动历史名单补全不抢用户当前格");
      await cold.getByRole("button", { name: "隐藏 Inspector", exact: true }).click();
    } else assert.equal(await cold.locator(".inspector-host").count(), 0, "窄屏历史名单补全不盖层");
    await cold.evaluate(() => window.__add({ id: "old-catch-up", title: "历史追平", dispatchedBy: "lead", createdAt: "2026-01-01T00:00:00.000Z" }));
    await cold.waitForFunction(() => window.__tasks().length === 8);
    assert.equal(await cold.locator(".inspector-host").count(), 0, "重连追平不强开");
    await cold.evaluate(() => window.__add({ id: "archived-backfill", title: "归档回填", dispatchedBy: "lead", archived: true }));
    await cold.waitForFunction(() => window.__tasks().length === 9);
    await cold.evaluate(() => window.__patch("archived-backfill", { archived: false }));
    await cold.waitForFunction(() => window.__tasks().find((item) => item.id === "archived-backfill")?.archived === false);
    assert.equal(await cold.locator(".inspector-host").count(), 0, "进入后才出现的归档项取消归档也不触发");
    assert.equal(await cold.evaluate(() => JSON.parse(localStorage.getItem("ash:inspector:task:lead")).focusKey), "0");
    await cold.evaluate(() => window.__add({ id: "real-new-batch", title: "真正的新批次", dispatchedBy: "lead", status: "running", stage: null }));
    await cold.locator(".dispatched-pane").waitFor();
    assert.equal(await cold.locator(".inspector-host__panel-title").textContent(), "子任务", "名单补全后真正派出仍强开并落格");
    await cold.getByRole("button", { name: width > 720 ? "隐藏 Inspector" : "收起 Inspector", exact: true }).click();
    await cold.reload();
    await cold.locator('[data-current-task="lead"]').waitFor();
    await cold.evaluate(() => window.__hydrate());
    await cold.waitForFunction(() => window.__tasks().length === 7);
    await cold.waitForFunction(() => JSON.parse(localStorage.getItem("ash:inspector:task:lead")).activeTab === "dispatched");
    assert.equal(await cold.locator(".inspector-host").count(), width > 720 ? 1 : 0, "刷新属于新进入，桌面默认打开子任务，窄屏不盖层");
    assert.equal(await cold.evaluate(() => JSON.parse(localStorage.getItem("ash:inspector:task:lead")).focusKey), "0", "进入默认格不重放上次新派出");
    await cold.close();
  }
  for (const width of [1600, 400]) {
    for (const taskId of ["lead", "leaf", "solo"]) {
      const cold = await browser.newPage({ viewport: { width, height: 900 } });
      cold.setDefaultTimeout(WAIT_TIMEOUT_MS);
      cold.on("pageerror", (error) => errors.push(error.message));
      const key = `ash:inspector:task:${taskId}`;
      await cold.goto(`${web.origin}/scripts/fixtures/task-drawers.html?partial=1&task=${taskId}`);
      await cold.locator(`[data-current-task="${taskId}"]`).waitFor();
      await cold.evaluate(() => window.__hydrate(false));
      await cold.waitForFunction(() => window.__tasks().length === 7);
      await settlePage(cold);
      assert.equal(await cold.evaluate((key) => JSON.parse(localStorage.getItem(key)).activeTab, key), taskId === "leaf" ? "info" : "review", "分批列表到达不提前消费进入判定");
      if (width <= 720) assert.equal(await cold.locator(".inspector-host").count(), 0);
      await cold.evaluate(() => window.__ready());
      const expectedTab = taskId === "solo" ? "review" : "dispatched";
      await cold.waitForFunction(({ key, tab }) => JSON.parse(localStorage.getItem(key)).activeTab === tab, { key, tab: expectedTab });
      if (width > 720 && taskId !== "solo") await cold.locator(".dispatched-pane").waitFor();
      else if (width <= 720) assert.equal(await cold.locator(".inspector-host").count(), 0, "延后进入判定也不弹窄屏盖层");
      await cold.evaluate((key) => {
        const saved = JSON.parse(localStorage.getItem(key));
        localStorage.setItem(key, JSON.stringify({ ...saved, visible: false, activeTab: "files", openTabs: saved.openTabs.filter((id) => id !== "dispatched"), dismissed: ["dispatched"] }));
      }, key);
      await cold.reload();
      await cold.locator(`[data-current-task="${taskId}"]`).waitFor();
      await cold.evaluate(() => window.__hydrate());
      await cold.locator('[data-tasks-ready="true"]').waitFor();
      if (taskId === "solo") {
        await settlePage(cold);
        assert.equal(await cold.locator(".inspector-host").count(), 0, "无子任务仍尊重关闭状态");
      } else {
        await cold.waitForFunction((key) => {
          const saved = JSON.parse(localStorage.getItem(key));
          return saved.activeTab === "dispatched" && saved.visible && !saved.dismissed.includes("dispatched");
        }, key);
        assert.equal(await cold.locator(".inspector-host").count(), width > 720 ? 1 : 0, "刷新后的进入判定恢复被关闭和摘掉的子任务格");
        if (width <= 720) await cold.getByRole("button", { name: "显示 Inspector", exact: true }).click();
        if (taskId === "leaf") await cold.locator('[data-subtask-id="leaf"] [aria-current="page"]').waitFor();
      }
      if (await cold.locator(".inspector-host").count()) await cold.locator('.inspector-rail__tab[aria-label^="文件"]').click();
      else await cold.getByRole("button", { name: "切到files", exact: true }).click();
      await cold.evaluate(() => window.__hydrate());
      await settlePage(cold);
      assert.equal(await cold.locator(".inspector-host__panel-title").textContent(), "文件", "列表重取不重复应用进入落格");
      await cold.close();
    }
    for (const action of ["rail", "close-tab", "hide", "side-chat", "memos"]) {
      const cold = await browser.newPage({ viewport: { width, height: 900 } });
      cold.setDefaultTimeout(WAIT_TIMEOUT_MS);
      cold.on("pageerror", (error) => errors.push(error.message));
      await cold.goto(`${web.origin}/scripts/fixtures/task-drawers.html?partial=1&task=lead`);
      await cold.locator('[data-current-task="lead"]').waitFor();
      if (width <= 720) await cold.getByRole("button", { name: "显示 Inspector", exact: true }).click();
      if (action === "rail") await cold.locator('.inspector-rail__tab[aria-label^="文件"]').click();
      else if (action === "close-tab") await cold.getByRole("button", { name: width > 720 ? "关闭审议" : "收起 Inspector", exact: true }).click();
      else if (action === "hide") await cold.getByRole("button", { name: width > 720 ? "隐藏 Inspector" : "收起 Inspector", exact: true }).click();
      else {
        await cold.locator(`.inspector-rail__tab[aria-label^="${action === "side-chat" ? "侧聊" : "备忘"}"]`).click();
        await cold.getByRole("button", { name: width > 720 ? "隐藏 Inspector" : "收起 Inspector", exact: true }).click();
        await cold.reload();
        await cold.locator('[data-current-task="lead"]').waitFor();
      }
      await settlePage(cold);
      const before = await cold.evaluate(() => JSON.parse(localStorage.getItem("ash:inspector:task:lead")));
      const visible = await cold.locator(".inspector-host").count();
      await cold.evaluate(() => window.__hydrate());
      await cold.locator('[data-tasks-ready="true"]').waitFor();
      await settlePage(cold);
      const after = await cold.evaluate(() => JSON.parse(localStorage.getItem("ash:inspector:task:lead")));
      assert.equal(after.activeTab, before.activeTab, `${action}：等待列表时的选择及侧聊/备忘偏好优先`);
      assert.equal(await cold.locator(".inspector-host").count(), visible, `${action}：就绪不能撤销手动关闭`);
      await cold.close();
    }
  }
  assert.deepEqual(errors, []);
  console.log("✓ 子任务导航与面板策略：冷启动等权威列表后默认落格，手动选择优先，窄屏不盖层；历史回填不冒充新派出");
} finally { await browser?.close(); await web.close(); }
