import assert from "node:assert/strict";

const until = async predicate => {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.fail("condition did not converge");
};
const capture = async (page, name) => {
  if (process.env.ASH_BROWSER_EVIDENCE_DIR) {
    await page.screenshot({ path: `${process.env.ASH_BROWSER_EVIDENCE_DIR}/${name}.png`, fullPage: true });
  }
};
const emit = (page, event = { type: "task.acceptGate", taskId: "gate-task" }) =>
  page.evaluate(event => window.emitGateEvent(event), event);

export async function testAcceptGateRecovery({ open, run, basis }) {
  for (const field of ["acceptGateRunning", "monitorRunning"]) {
    const task = { id: "gate-task", projectId: "proj-1", title: field, status: "paused", stage: "verified",
      mode: "single", workflowMode: "free", updatedAt: "2026-10-24T00:00:00Z",
      backgroundRevision: 0, acceptGateRunning: false, monitorRunning: false };
    const { page, store } = await open({ query: "?dots=1", events: true, tasks: [task] });
    const dot = page.locator("[data-task-id='gate-task'] [aria-label]");
    await dot.waitFor();
    await page.waitForTimeout(150);
    for (const running of [true, false]) {
      store.taskPlan = { delay: 700 };
      const reads = store.taskReads;
      const response = page.waitForResponse(response => response.url().endsWith("/api/tasks"));
      await emit(page, { type: "task.monitors", taskId: task.id });
      await until(() => store.taskReads > reads);
      const fresh = { ...store.tasks[0], [field]: running, backgroundRevision: running ? 1 : 2 };
      store.tasks = [fresh];
      await emit(page, { type: "task.updated", task: fresh });
      await page.waitForFunction(running => document.querySelector("[data-task-id='gate-task'] [aria-label]")
        ?.classList.contains("workspace-status-dot--working") === running, running);
      await response;
      await page.waitForTimeout(100);
      assert.equal((await dot.getAttribute("class")).includes("--working"), running);
      await emit(page, { type: "task.updated", task: { ...task, [field]: !running, backgroundRevision: running ? 0 : 1 } });
      await page.waitForTimeout(50);
      assert.equal((await dot.getAttribute("class")).includes("--working"), running);
      await capture(page, `${field}-${running ? "start" : "stop"}-after-old-snapshot`);
    }
    await page.close();
  }

  for (const query of ["?wait=1&expected=1", ""]) {
    const running = run({ status: "running", exitCode: null, finishedAt: null });
    const { page, store } = await open({ query, events: true, gate: { command: running.command, running, latest: running } });
    const surface = page.locator(query ? ".accept-gate-wait" : ".accept-gate-card");
    await surface.filter({ hasText: /在跑/ }).waitFor();
    await page.waitForTimeout(100);
    store.status = 500;
    store.gate = { command: running.command, running: null, latest: run() };
    await emit(page);
    await surface.getByRole("alert").waitFor();
    assert.match(await surface.innerText(), /状态待核对/);
    assert.doesNotMatch(await surface.getAttribute("class"), /is-running|is-passed/);
    const refresh = surface.getByRole("button", { name: query ? "刷新状态" : "刷新", exact: true });
    assert.equal(await refresh.isVisible(), true);
    if (query) {
      const elapsed = await surface.locator(".wait-bar__when").innerText();
      await page.waitForTimeout(1200);
      assert.equal(await surface.locator(".wait-bar__when").innerText(), elapsed);
      await page.setViewportSize({ width: 340, height: 820 });
      assert.equal(await refresh.isVisible(), true);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    }
    await capture(page, query ? "wait-stale-with-refresh" : "acceptance-stale-with-refresh");
    const reads = store.reads;
    store.status = 0;
    if (query) await surface.waitFor({ state: "hidden", timeout: 6000 });
    else await surface.filter({ hasText: "验收前置命令已通过" }).waitFor({ timeout: 6000 });
    assert.ok(store.reads > reads, "a failed terminal read recovers without another SSE event or reconnect");
    assert.equal(store.canceled + store.handoffs + store.patches.length, 0);
    await capture(page, query ? "wait-recovered" : "acceptance-recovered");
    await page.close();
  }

  {
    const passed = run();
    const { page, store } = await open({ query: "?stage=accepted", events: true,
      gate: { command: passed.command, running: null, latest: passed, basis: basis("passed", passed) } });
    const card = page.locator(".accept-gate-card");
    await card.filter({ hasText: "本次验收就是拿它放的行" }).waitFor();
    store.status = 500;
    await card.getByRole("button", { name: "刷新", exact: true }).click();
    await card.getByRole("alert").waitFor();
    assert.doesNotMatch(await card.getAttribute("class"), /is-passed/);
    store.status = 0;
    await card.getByRole("button", { name: "刷新", exact: true }).click();
    await card.filter({ hasText: "本次验收就是拿它放的行" }).waitFor();
    assert.equal(await card.getByRole("alert").count(), 0);
    await page.close();
  }

  for (const status of ["passed", "failed"]) {
    for (const role of ["admin", "member"]) {
      const previous = run({ status, logTail: `history-${status}` });
      const { page, store } = await open({ role, gate: { command: null, running: null, latest: previous } });
      const card = page.locator(".accept-gate-card");
      await card.filter({ hasText: "历史记录" }).waitFor();
      assert.match(await card.innerText(), /下次验收不会跑它/);
      assert.ok((await card.innerText()).includes(previous.command));
      assert.match(await card.innerText(), new RegExp(`history-${status}`));
      assert.equal(await card.getByRole("button", { name: "看完整日志" }).count(), 1);
      for (const name of ["重跑一次", "这次跳过它，直接合并", "交给智能体去修"]) {
        assert.equal(await card.getByRole("button", { name }).count(), 0);
      }
      await capture(page, `withdrawn-${role}-${status}`);
      if (role === "admin") {
        await card.getByRole("button", { name: "设一条" }).click();
        await card.locator("input").fill("npm run replacement");
        await card.getByRole("button", { name: "保存" }).click();
        await until(() => store.patches.length === 1);
        assert.deepEqual(store.patches, [{ acceptGateCommand: "npm run replacement" }]);
      } else assert.equal(await card.getByRole("button", { name: "设一条" }).count(), 0);
      await page.close();
    }
  }

  for (const action of ["切任务", "卸载提示"]) {
    const running = run({ status: "running" });
    const { page, store } = await open({ query: "?wait=1&switch=1", events: true,
      gate: { command: running.command, running, latest: running } });
    await page.locator(".accept-gate-wait").waitFor();
    store.status = 500;
    await emit(page);
    await page.getByRole("alert").waitFor();
    store.status = 0;
    store.gate = { command: running.command, running: null, latest: run() };
    await page.getByRole("button", { name: action, exact: true }).click();
    await page.locator(".accept-gate-wait").waitFor({ state: "hidden" });
    const oldReads = store.requestIds.filter(taskId => taskId === "gate-task").length;
    await page.waitForTimeout(1400);
    assert.equal(store.requestIds.filter(taskId => taskId === "gate-task").length, oldReads);
    if (action === "切任务") assert.ok(store.requestIds.includes("other-task"));
    await page.close();
  }

  {
    const running = run({ status: "running" });
    const states = [];
    const { page, store } = await open({ query: "?wait=1&switch=1", events: true, states,
      gate: { command: running.command, running, latest: running } });
    const bar = page.locator(".accept-gate-wait");
    await bar.filter({ hasText: "验收前置命令在跑" }).waitFor();
    await page.waitForTimeout(100);
    const reads = store.reads;
    states[reads] = { delay: 700, body: store.gate };
    await emit(page);
    await until(() => store.reads > reads);
    await bar.filter({ hasText: "状态待核对" }).waitFor();
    store.gate = { command: running.command, running: null, latest: run() };
    await page.getByRole("button", { name: "切任务", exact: true }).click();
    await bar.waitFor({ state: "hidden" });
    await page.waitForTimeout(900);
    assert.equal(await bar.count(), 0, "late response for the previous task must remain invalid");
    await page.close();
  }

  {
    const running = run({ status: "running" });
    const { page, store } = await open({ query: "?wait=1", events: true,
      gate: { command: running.command, running, latest: running } });
    await page.locator(".accept-gate-wait").waitFor();
    await page.clock.install();
    store.status = 500;
    await emit(page);
    await page.getByRole("alert").waitFor();
    const reads = store.reads;
    for (const delay of [1000, 2000, 4000, 8000, 10000]) {
      const previous = store.reads;
      await page.clock.runFor(delay + 50);
      await until(() => store.reads > previous);
      await page.waitForTimeout(50);
    }
    assert.equal(store.reads, reads + 5);
    await page.clock.runFor(30000);
    assert.equal(store.reads, reads + 5, "persistent failure stops after five automatic retries");
    assert.match(await page.locator(".accept-gate-wait").innerText(), /状态待核对/);
    store.status = 0;
    store.gate = { command: running.command, running: null, latest: run() };
    await page.getByRole("button", { name: "刷新状态", exact: true }).click();
    await page.locator(".accept-gate-wait").waitFor({ state: "hidden" });
    await page.close();
  }
  console.log("accept gate recovery: stale projections, bounded retry, task lifetime, readonly receipt and withdrawn history passed");
}
