// 已验收那张回执：前置命令那一行在验收做完之后**留着**（用户 2026-10-23）。原先在盖章那一
// 刻整个消失，于是「门禁通过了」和「我明确跳过了那条红」在界面上长得一模一样 —— 而两者的区别
// 恰恰是这次合并到底有没有凭据。从 test-accept-gate-dom.mjs 拆出来（那份贴着 700 行上限，按表面拆）。
//
// ⑪ 回执**只认这一按自己的凭据**（`basis`），绝不拿「最近一次门禁」反推（第 1 轮审查
//    F1 实测出一份假回执：命令在 A 上跑绿、代码改成 B、项目再撤掉命令，那时「最近一次」
//    仍是那条绿的，而真正放行的理由是「现在没有门禁」）。四种凭据各有自己的状态词：
//    passed「通过」、skipped「已跳过」、unset「验收时没设」、null（老数据）「没留下验收凭据」。
// ⑫ 回执只读：不再摆任何会改变状态的键（停止 / 交给任务 / 设置），主按钮换成「已验收」。
// ⑬ 凭据后来才落进来（事件、阶段变化、任务更新三条路）：回执跟着改口，不用刷新。
import assert from "node:assert/strict";
import { assertTone, gateRow, stateOf } from "./accept-gate-stage.mjs";

export async function testAcceptGateReceipts({ open, run, basis }) {
  const noActions = async (page, label) => {
    for (const name of ["停止", "交给任务", "重试", "前置命令设置", "验收通过", "打回"]) {
      assert.equal(await page.getByRole("button", { name, exact: true }).count(), 0, `${label}：验收做完之后不该还摆「${name}」`);
    }
  };

  // ⑪⑫ 凭据是那次跑绿：摆的是**凭据那一次**（不是此后又跑红的最近一次），日志也指着它。
  {
    const evidence = run({ id: "run-green", logTail: "green tail\n" });
    const later = run({ id: "run-2", status: "failed", exitCode: 1, failure: "exit_code", command: "./kb.sh test other" });
    const { page, store } = await open({
      gate: { command: "./kb.sh test full", running: null, latest: later, basis: basis("passed", evidence) },
      query: "?stage=accepted",
    });
    await page.locator(".acc-done").filter({ hasText: "已验收" }).waitFor();
    const row = gateRow(page);
    await assertTone(row, "passed");
    assert.equal(await stateOf(row), "通过");
    assert.equal(await row.locator(".acc-check-text").innerText(), evidence.command);
    await noActions(page, "通过");
    await row.locator(".acc-check-main").click();
    assert.match(await row.locator(".acc-log-head").innerText(), /^run-green · /, "回执的日志是凭据那一次");
    assert.match(await row.locator(".acc-log pre").innerText(), /green tail/);
    store.logText = "full log of run-green";
    const request = page.waitForRequest((entry) => entry.url().includes("/accept-gate/log"));
    await row.getByRole("button", { name: "全文", exact: true }).click();
    assert.match((await request).url(), /[?&]run=run-green\b/, "全文要按凭据那一次去取");
    await row.getByText("full log of run-green", { exact: true }).waitFor();
    await page.close();
  }

  // 凭据那一次的记录已经清掉了：照样是「通过」，只是说明记录不在了。
  {
    const { page } = await open({ gate: { command: "./kb.sh test full", running: null, latest: null, basis: basis("passed", null) },
      query: "?stage=accepted" });
    assert.equal(await stateOf(gateRow(page)), "通过，记录已清理");
    assert.equal(await gateRow(page).locator("button.acc-check-main").count(), 0, "没有那次运行就没有日志可展开");
    await page.close();
  }

  // ⑪ 凭据是「你明确跳过了它」：琥珀不是红（此刻什么都没拦着），也没有那条红的出路。
  {
    const failed = run({ status: "failed", exitCode: 1, failure: "exit_code", logTail: "1 failed\n" });
    const { page } = await open({ gate: { command: "./kb.sh test full", running: null, latest: failed, basis: basis("skipped") },
      query: "?stage=accepted" });
    const row = gateRow(page);
    assert.equal(await stateOf(row), "已跳过");
    await assertTone(row, "skipped", "跳过是琥珀不是红");
    await noActions(page, "已跳过");
    assert.doesNotMatch(await row.innerText(), /通过/);
    await page.close();
  }

  // 命令后来被撤掉了，但这一按的凭据确实是那次跑绿：验收做完之后仍要留痕。
  {
    const evidence = run();
    const { page } = await open({ gate: { command: null, running: null, latest: evidence, basis: basis("passed", evidence) },
      query: "?stage=accepted", command: null });
    assert.equal(await stateOf(gateRow(page)), "通过");
    await page.close();
  }

  // ⑪ **第 1 轮审查 F1 的那份假回执**：命令在 A 上跑绿（latest 还是那条绿的、只是 stale），
  //    代码改成了 B、项目又把命令撤掉，于是真正放行的理由是「那一刻没有门禁」。回执必须
  //    照凭据说话 —— 一个字都不许出现「通过」。
  {
    const { page } = await open({ gate: { command: null, running: null, latest: run({ stale: true }), basis: basis("unset") },
      query: "?stage=accepted", command: null });
    const row = gateRow(page);
    assert.equal(await stateOf(row), "验收时没设");
    await assertTone(row, "idle");
    assert.doesNotMatch(await row.innerText(), /通过/, "那条绿不是这次合并的凭据，说「通过」就是给没测过的代码背书");
    await page.close();
  }

  // 凭据是后来才开始记的：老数据如实说「没留下验收凭据」，不拿最近一次替它背书。
  {
    const { page } = await open({ gate: { command: "./kb.sh test full", running: null, latest: run(), basis: null },
      query: "?stage=accepted" });
    const row = gateRow(page);
    assert.equal(await stateOf(row), "没留下验收凭据");
    assert.doesNotMatch(await row.innerText(), /通过/);
    await page.close();
  }

  // 那一刻没设、项目现在也没命令、也没跑过：这一行什么都不澄清，不出。
  {
    const { page } = await open({ gate: { command: null, running: null, latest: null, basis: basis("unset") }, query: "?stage=accepted" });
    await page.locator(".acc-done").waitFor();
    assert.equal(await gateRow(page).count(), 0);
    await page.close();
  }

  // ⑬ 凭据落进来的三条路：回执跟着改口。
  for (const event of [
    { type: "task.acceptGate", taskId: "gate-task" },
    { type: "task.stage", taskId: "gate-task", stage: "accepted", updatedAt: new Date().toISOString() },
    { type: "task.updated", task: { id: "gate-task", stage: "accepted" } },
  ]) {
    const passed = run();
    const { page, store } = await open({ gate: { command: passed.command, running: null, latest: passed, basis: null },
      query: "?stage=accepted", events: true });
    assert.equal(await stateOf(gateRow(page)), "没留下验收凭据");
    store.gate = { ...store.gate, basis: basis("passed", passed) };
    await page.evaluate(event => window.emitGateEvent(event), event);
    await page.locator('.acc-check[data-check="gate"].is-passed').waitFor();
    assert.equal(await stateOf(gateRow(page)), "通过");
    await page.close();
  }

  // 日志已迁走或清理：有末尾就照摆、「全文」灰着说清楚；连末尾都没有就不给展开。
  for (const logTail of ["", "last lines\n"]) {
    const moved = run({ logAvailable: false, logTail });
    const { page } = await open({ gate: { command: moved.command, running: null, latest: moved, basis: basis("passed", moved) }, query: "?stage=accepted" });
    const row = gateRow(page);
    assert.equal(await stateOf(row), "通过");
    if (!logTail) assert.equal(await row.locator("button.acc-check-main").count(), 0);
    else {
      await row.locator(".acc-check-main").click();
      const missing = row.getByRole("button", { name: "日志已清理", exact: true });
      assert.equal(await missing.isDisabled(), true);
      assert.match(await row.locator(".acc-log pre").innerText(), /last lines/);
      if (process.env.ASH_TEST_ARTIFACTS) await page.screenshot({ path: `${process.env.ASH_TEST_ARTIFACTS}/handoff-log-unavailable.png`, fullPage: true });
    }
    await page.close();
  }
  console.log("accept gate receipts: passed / skipped / unset / legacy basis, read-only, live update and moved logs covered");
}
