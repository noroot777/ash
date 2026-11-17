import assert from "node:assert/strict";
import { launchChrome, startWebServer } from "./dom-stage.mjs";

const web = await startWebServer();
let browser;
try {
  browser = await launchChrome();
  const page = await browser.newPage();
  await page.goto(`${web.origin}/scripts/fixtures/dispatch-tree.html`);
  const row = (id) => page.locator(`.workspace-task-tree [data-task-id="${id}"]`);
  const wrap = (id) => page.locator(".workspace-task-row-wrap", { has: page.locator(`[data-task-id="${id}"]`) });
  await row("lead").waitFor();
  for (const id of ["kid-run", "kid-ask", "kid-mid", "grand", "old-grand"]) assert.equal(await row(id).count(), 0);
  assert.equal(await wrap("lead").locator(".workspace-team-caret").count(), 0);
  assert.equal(await wrap("lead").locator(".workspace-status-dot--wait").count(), 0, "圆点只说它自己（验收过）：名下在问你不改它的圆点");
  assert.equal(await row("lead").locator(".workspace-dispatch-count").textContent(), "3");
  assert.equal(await row("lead").locator(".workspace-dispatch-count.is-warn").count(), 1);
  assert.match(await row("lead").innerText(), /子项等答复/);
  await page.evaluate(() => window.__select("grand"));
  await page.waitForFunction(() => document.querySelector('[data-task-id="lead"]')?.getAttribute("aria-selected") === "true");
  await row("lead").click();
  assert.equal(await row("grand").count(), 0);
  assert.equal(await page.evaluate(() => localStorage.getItem("ash:task-tree:dispatch-open")), null);
  await page.evaluate(() => window.__scope("tasks"));
  await page.locator(".workspace-task-project-group").waitFor();
  const more = page.locator(".workspace-task-project-group .workspace-task-more:not(.workspace-task-more--collapse)");
  if (await more.count()) await more.first().click();
  for (const id of ["kid-run", "kid-ask", "kid-mid", "grand", "old-grand"]) assert.equal(await row(id).count(), 0, "任务模式的更多任务也不漏出子任务");
  await page.evaluate(() => window.__scope("project"));
  for (const filter of ["todo", "run"]) {
    await page.evaluate((value) => window.__filter(value), filter);
    await row("lead").waitFor();
    assert.equal(await row("kid-run").count(), 0);
  }
  await page.evaluate(() => { window.__filter("all"); window.__patch("kid-mid", { archived: true }); window.__patch("grand", { status: "failed", stage: null }); });
  await row("lead").waitFor();
  assert.equal(await row("grand").count(), 0);
  assert.equal(await row("old-lead").count(), 1);
  assert.equal(await row("old-lead").locator(".workspace-dispatch-count").textContent(), "0");
  await page.evaluate(() => window.__patch("lead", { archived: true }));
  await row("kid-run").waitFor();
  await row("grand").waitFor();
  await row("orphan").waitFor();
  await wrap("team").getByRole("button", { name: /展开.*执行者/ }).click();
  await row("worker").waitFor();
  await page.reload();
  await row("lead").waitFor();
  assert.equal(await row("kid-run").count(), 0);
  console.log("✓ 侧栏只画祖先：记号、短语、计数、筛选、选中与团队执行者");
} finally { await browser?.close(); await web.close(); }
