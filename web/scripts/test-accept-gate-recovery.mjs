import assert from "node:assert/strict";
import { WAIT_TIMEOUT_MS, fetchLog, fetchesSettled, outlastPageTimers, resizeViewport, settlePage, waitUntil } from "./wait-until.mjs";
import { deskSettled, freezeAutoRetry, gateRow, mainButton, openConfirm, stateOf } from "./accept-gate-stage.mjs";

/** useAcceptGate 退避重试曲线的封顶那一档。 */
const GATE_RETRY_CAP_MS = 10_000;

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
    // 挂载那一发和连上之后的对账都落完，下面扣住的才是 task.monitors 触发的那一发。
    await fetchesSettled(page, 1, "挂载与连上对账的任务列表读取都已落地");
    for (const running of [true, false]) {
      const release = Promise.withResolvers();
      store.taskPlan = { hold: release.promise };
      const reads = store.taskReads;
      await emit(page, { type: "task.monitors", taskId: task.id });
      await waitUntil(() => store.taskReads > reads, "task.monitors 触发的任务列表重读到达桩");
      const fresh = { ...store.tasks[0], [field]: running, backgroundRevision: running ? 1 : 2 };
      store.tasks = [fresh];
      await emit(page, { type: "task.updated", task: fresh });
      await page.waitForFunction(running => document.querySelector("[data-task-id='gate-task'] [aria-label]")
        ?.classList.contains("workspace-status-dot--breathe") === running, running);
      // 扣住的那份旧快照此刻才放回去，并等页面把它读完。
      release.resolve();
      await fetchesSettled(page, 0, "迟到的旧任务快照已被页面消费完");
      assert.equal((await dot.getAttribute("class")).includes("--breathe"), running);
      // SSE 事件在 emit 那次 evaluate 里同步派发，冲刷一轮渲染就能读。
      await emit(page, { type: "task.updated", task: { ...task, [field]: !running, backgroundRevision: running ? 0 : 1 } });
      await settlePage(page);
      assert.equal((await dot.getAttribute("class")).includes("--breathe"), running);
      await capture(page, `${field}-${running ? "start" : "stop"}-after-old-snapshot`);
    }
    await page.close();
  }

  for (const query of ["?wait=1&expected=1", ""]) {
    const running = run({ status: "running", exitCode: null, finishedAt: null });
    const { page, store } = await open({ query, events: true, gate: { command: running.command, running, latest: running } });
    // 验收台上是前提列里前置命令那一行；主会话页上是回复框上方那条折叠条。
    const surface = query ? page.locator(".accept-gate-wait") : gateRow(page);
    await surface.filter({ hasText: query ? /在跑/ : /运行中/ }).waitFor();
    await fetchesSettled(page, 1, "挂载与连上对账的读取都已落地");
    store.status = 500;
    store.gate = { command: running.command, running: null, latest: run() };
    await emit(page);
    if (query) await surface.getByRole("alert").waitFor();
    else await surface.filter({ hasText: "状态待核对" }).waitFor();
    assert.match(await surface.innerText(), /状态待核对/);
    assert.doesNotMatch(await surface.getAttribute("class"), /is-running|is-passed/);
    const refresh = surface.getByRole("button", { name: query ? "刷新状态" : "重试", exact: true });
    assert.equal(await refresh.isVisible(), true);
    if (query) {
      const elapsed = await surface.locator(".wait-bar__when").innerText();
      // 秒表心跳是 1 秒：一个 1.2 秒后到期的页面定时器触发时，它要走早就走过了。
      await outlastPageTimers(page, 1200);
      assert.equal(await surface.locator(".wait-bar__when").innerText(), elapsed);
      await resizeViewport(page, { width: 340, height: 820 });
      assert.equal(await refresh.isVisible(), true);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    } else {
      // 上次读到的是「在跑」、此刻读不出来：不许把「没读到」当「跑完了」放行。
      assert.equal(await mainButton(page).isDisabled(), true);
    }
    await capture(page, query ? "wait-stale-with-refresh" : "acceptance-stale-with-refresh");
    const reads = store.reads;
    store.status = 0;
    // 恢复靠的是追平层自己排的下一次退避重试（useAcceptGate 的曲线 1→2→4→8 秒、封顶 10 秒；
    // 前面截图、换视口那几步的工夫里它可能已经退了几档），所以期限是「最长一档 + 落地」。
    const recovery = { timeout: GATE_RETRY_CAP_MS + WAIT_TIMEOUT_MS };
    if (query) await surface.waitFor({ state: "hidden", ...recovery });
    else {
      await page.locator('.acc-check[data-check="gate"].is-passed').waitFor(recovery);
      assert.match(await stateOf(gateRow(page)), /^通过 · /);
      await deskSettled(page);
      assert.equal(await mainButton(page).isEnabled(), true);
    }
    assert.ok(store.reads > reads, "a failed terminal read recovers without another SSE event or reconnect");
    assert.equal(store.canceled + store.handoffs + store.patches.length, 0);
    await capture(page, query ? "wait-recovered" : "acceptance-recovered");
    await page.close();
  }

  // 已验收的回执读不出来：不再标绿、给「重试」；重试读到了才回到「通过」。
  {
    const passed = run();
    const { page, store } = await open({ query: "?stage=accepted", events: true,
      gate: { command: passed.command, running: null, latest: passed, basis: basis("passed", passed) } });
    const row = gateRow(page);
    await page.locator('.acc-check[data-check="gate"].is-passed').waitFor();
    assert.equal(await row.getByRole("button", { name: "重试", exact: true }).count(), 0, "读得到时不摆常驻的刷新键");
    store.status = 500;
    await emit(page);
    await row.filter({ hasText: "通过，状态待核对" }).waitFor();
    assert.doesNotMatch(await row.getAttribute("class"), /is-passed/);
    await freezeAutoRetry(store);
    store.status = 0;
    await row.getByRole("button", { name: "重试", exact: true }).click();
    await page.locator('.acc-check[data-check="gate"].is-passed').waitFor();
    assert.equal(await stateOf(row), "通过");
    assert.equal(await row.getByRole("button", { name: "重试", exact: true }).count(), 0);
    await page.close();
  }

  // 命令撤掉了、只剩历史记录：验收台上不摆那一行（这一按不跑它），确认层里也没有「运行」；
  // 管理员的入口在确认层里，保存发的是项目级 PATCH，成员没有入口。
  for (const status of ["passed", "failed"]) {
    for (const role of ["admin", "member"]) {
      const previous = run({ status, logTail: `history-${status}` });
      const { page, store } = await open({ role, gate: { command: null, running: null, latest: previous } });
      assert.equal(await gateRow(page).count(), 0);
      assert.equal(await page.getByText(`history-${status}`).count(), 0);
      for (const name of ["交给任务", "停止", "重试"]) assert.equal(await page.getByRole("button", { name, exact: true }).count(), 0);
      const layer = await openConfirm(page);
      assert.equal(await layer.getByRole("checkbox", { name: "运行前置命令" }).count(), 0, "下次验收不会跑它");
      await capture(page, `withdrawn-${role}-${status}`);
      if (role === "admin") {
        await layer.getByRole("button", { name: "设一条前置命令", exact: true }).click();
        const settings = page.getByRole("dialog", { name: "前置命令设置", exact: true });
        await settings.getByLabel("验收前置命令", { exact: true }).fill("npm run replacement");
        await settings.getByRole("button", { name: "保存", exact: true }).click();
        await waitUntil(() => store.patches.length === 1, "保存发出项目级 PATCH");
        assert.deepEqual(store.patches, [{ acceptGateCommand: "npm run replacement" }]);
      } else assert.equal(await layer.getByRole("button", { name: "设一条前置命令", exact: true }).count(), 0);
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
    // 看页面那一侧发没发（桩那一侧会晚到）：旧任务那条退避重试第一档是 1 秒，一个 1.4 秒后
    // 到期的页面定时器触发时，它若还活着就已经发出去了。
    const oldReads = async () => (await fetchLog(page)).filter(entry => entry.url.includes("/gate-task/")).length;
    const before = await oldReads();
    await outlastPageTimers(page, 1400);
    assert.equal(await oldReads(), before, "换掉/卸载之后旧任务那条重试不许再发");
    if (action === "切任务") assert.ok((await fetchLog(page)).some(entry => entry.url.includes("/other-task/")));
    await page.close();
  }

  {
    const running = run({ status: "running" });
    const states = [];
    const { page, store } = await open({ query: "?wait=1&switch=1", events: true, states,
      gate: { command: running.command, running, latest: running } });
    const bar = page.locator(".accept-gate-wait");
    await bar.filter({ hasText: "验收前置命令在跑" }).waitFor();
    await fetchesSettled(page, 1, "挂载与连上对账的读取都已落地");
    const reads = store.reads;
    // 旧任务这一发扣到新任务那一发送出去之后才回：迟到是排出来的，不是赌出来的。
    states[reads] = { after: reads + 1, body: store.gate };
    await emit(page);
    await waitUntil(() => store.reads > reads, "事件触发的那次重读到达桩");
    await bar.filter({ hasText: "状态待核对" }).waitFor();
    store.gate = { command: running.command, running: null, latest: run() };
    await page.getByRole("button", { name: "切任务", exact: true }).click();
    await bar.waitFor({ state: "hidden" });
    await store.served(reads);
    await fetchesSettled(page, reads + 2, "旧任务那发迟到的响应与新任务那一发都已被页面消费完");
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
      await waitUntil(() => store.reads > previous, `第 ${delay}ms 那一档退避重试到达桩`);
      // 那发 500 被页面读完，下一档重试的定时器才排上；没排上就推时钟会白推。
      await fetchesSettled(page, 0, "这一档重试的 500 已被页面消费完");
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
