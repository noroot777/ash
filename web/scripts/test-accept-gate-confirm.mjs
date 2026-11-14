// 确认层那几勾 ↔ 发给后端的参数、前提列里的红行 ↔ 主按钮、合并预览冲突那一行。从
// test-accept-gate-dom.mjs 拆出来（那份贴着 700 行上限，按表面拆）。钉住的是：
//
// ⑭ 跳过与重跑**不再是单独的键**，是确认层「运行」那一勾：没有可沿用的绿时默认勾着、取消 =
//    这次跳过（gate:"skip"）；有一次还作数的绿时默认不勾（沿用那次，不带 gate）、勾上 = 重跑
//    （gate:"rerun"）。「提交」那一勾默认跟项目设置，发给 /accept 的 commit 就是层里看见的值，
//    取消时确认键改口「验收，不提交」。这几勾都只管「这一次」：关掉层（取消、Esc、再点主按钮）
//    就回到默认 —— 留着上次的选择等于一个没人记得设过的隐形开关。
// ⑮ 红行拦主按钮：前置命令在跑（gate.occupied）时主按钮 disabled、那一行写「运行中」；
//    门禁状态读不出来（GET 503）时主按钮 disabled、那一行写「状态读不出来」带「重试」，点重试
//    读到之后才放开 —— **读失败不放行**（「没读到」不等于「没在跑」）。
// ⑯ 合并预览撞冲突那一行是红的，但**不禁用主按钮**（取消「运行」= 这次跳过，本来就不判基准）；
//    「让任务解决」直达 POST conflict-handoff，交过之后那一行换成「任务正在解决冲突」。
import assert from "node:assert/strict";
import { assertTone, checkRow, confirmLayer, deskSettled, freezeAutoRetry, gateRow, mainButton, openConfirm, stateOf } from "./accept-gate-stage.mjs";
import { waitUntil } from "./wait-until.mjs";

const accepted = (store, count) => waitUntil(() => store.accepts.length === count, `第 ${count} 次验收请求发出去`);

export async function testAcceptGateConfirm({ open, run }) {
  // ⑭ 没有可沿用的绿（没跑过 / 过期了 / 上次红了）：运行默认勾着，取消 = gate:"skip"。
  for (const [label, latest] of [["一次都没跑过", null], ["绿了但过期了", run({ stale: true })],
    ["上次红了", run({ status: "failed", exitCode: 1, failure: "exit_code" })]]) {
    const { page, store } = await open({ gate: { command: "./kb.sh test full", running: null, latest, basis: null } });
    let layer = await openConfirm(page);
    const runBox = () => confirmLayer(page).getByRole("checkbox", { name: "运行前置命令" });
    const commitBox = () => confirmLayer(page).getByRole("checkbox", { name: "合并后提交" });
    assert.equal(await runBox().isChecked(), true, `${label}：默认要跑`);
    assert.equal(await commitBox().isChecked(), true, `${label}：提交跟项目默认（开）`);
    await layer.getByRole("button", { name: "确认验收", exact: true }).waitFor();
    await runBox().uncheck();
    assert.equal(await layer.locator("li.is-off").count(), 1, `${label}：不跑的那一步划掉`);
    assert.equal(await layer.getByText("上次未通过").count(), latest?.status === "failed" ? 1 : 0);
    await layer.getByRole("button", { name: "跳过并验收", exact: true }).click();
    await accepted(store, 1);
    assert.deepEqual(store.accepts[0], { confirmUnverified: false, commit: true, gate: "skip" }, `${label}：这一按要带 gate=skip`);
    // 发出去就关层；回执（这里是一句「验收没完成」）留在前提列里，细节点开看。
    await confirmLayer(page).waitFor({ state: "detached" });
    const failure = checkRow(page, "failure");
    assert.equal(await failure.locator(".acc-check-text").innerText(), "验收没完成");
    await failure.locator(".acc-check-main").click();
    await failure.getByText("模拟验收响应").waitFor();

    // 关层就复位：取消、Esc、再点一次主按钮三种关法都算。
    for (const close of ["取消", "Escape", "主按钮"]) {
      layer = await openConfirm(page);
      assert.equal(await runBox().isChecked(), true, `${label}：${close} 关掉之后「运行」回到默认`);
      assert.equal(await commitBox().isChecked(), true, `${label}：${close} 关掉之后「提交」回到默认`);
      await runBox().uncheck();
      await commitBox().uncheck();
      if (close === "取消") await layer.getByRole("button", { name: "取消", exact: true }).click();
      else if (close === "Escape") await page.keyboard.press("Escape");
      else await mainButton(page).click();
      await confirmLayer(page).waitFor({ state: "detached" });
    }
    layer = await openConfirm(page);
    assert.equal(await runBox().isChecked(), true);
    // 只取消提交：确认键改口，层里说清改动留在哪，发的就是 commit:false。
    await commitBox().uncheck();
    await layer.getByRole("button", { name: "验收，不提交", exact: true }).waitFor();
    assert.match(await layer.innerText(), /改动留在 main 工作区/);
    await layer.getByRole("button", { name: "验收，不提交", exact: true }).click();
    await accepted(store, 2);
    assert.deepEqual(store.accepts[1], { confirmUnverified: false, commit: false }, `${label}：照跑、不提交`);
    await page.close();
  }

  // ⑭ 有一次还作数的绿：默认不勾（沿用那次，不带 gate），勾上 = gate:"rerun"。
  {
    const { page, store } = await open({ gate: { command: "./kb.sh test full", running: null, latest: run(), basis: null } });
    let layer = await openConfirm(page);
    const runBox = layer.getByRole("checkbox", { name: "运行前置命令" });
    assert.equal(await runBox.isChecked(), false, "有现成的绿就沿用");
    assert.match(await layer.innerText(), /刚刚通过/);
    assert.equal(await layer.locator("li.is-off").count(), 0, "沿用不是跳过，那一步不划掉");
    await layer.getByRole("button", { name: "确认验收", exact: true }).click();
    await accepted(store, 1);
    assert.deepEqual(store.accepts[0], { confirmUnverified: false, commit: true }, "沿用那次绿：不带 gate");
    layer = await openConfirm(page);
    assert.equal(await layer.getByRole("checkbox", { name: "运行前置命令" }).isChecked(), false, "复位到沿用");
    await layer.getByRole("checkbox", { name: "运行前置命令" }).check();
    await layer.getByRole("button", { name: "确认验收", exact: true }).click();
    await accepted(store, 2);
    assert.deepEqual(store.accepts[1], { confirmUnverified: false, commit: true, gate: "rerun" }, "勾上就是重跑");
    await page.close();
  }

  // ⑭ 项目默认「不提交」：那一勾默认不勾，确认键一打开就是「验收，不提交」，发 commit:false。
  {
    const { page, store } = await open({ gate: { command: null, running: null, latest: null, basis: null }, acceptCommit: false });
    const layer = await openConfirm(page);
    assert.equal(await layer.getByRole("checkbox", { name: "合并后提交" }).isChecked(), false);
    await layer.getByRole("button", { name: "验收，不提交", exact: true }).click();
    await accepted(store, 1);
    assert.deepEqual(store.accepts[0], { confirmUnverified: false, commit: false });
    await page.close();
  }

  // 验收成了：一句「验收通过」，按钮那一侧换成「已验收」。
  {
    const { page, store } = await open({ gate: { command: null, running: null, latest: null, basis: null },
      acceptReply: () => { store.stage = "accepted"; return { status: 200, body: { accepted: true, taskId: "gate-task" } }; } });
    await (await openConfirm(page)).getByRole("button", { name: "确认验收", exact: true }).click();
    await page.getByRole("status", { name: "操作结果" }).filter({ hasText: "验收通过" }).waitFor();
    await page.locator(".acc-done").filter({ hasText: "已验收" }).waitFor();
    assert.equal(await mainButton(page).count(), 0);
    await page.close();
  }

  // ⑮ 在跑：红行在，主按钮锁着。
  {
    const running = run({ status: "running", exitCode: null, finishedAt: null });
    const { page } = await open({ gate: { command: running.command, running, latest: running, basis: null } });
    assert.match(await stateOf(gateRow(page)), /^运行中/);
    assert.equal(await mainButton(page).isDisabled(), true);
    assert.equal(await mainButton(page).innerText(), "验收通过", "按钮上只写动作名，原因在下面那一行");
    await page.close();
  }

  // ⑮ 读失败不放行：503 → 「状态读不出来」+ 重试、主按钮锁着；点重试读到了才放开。
  {
    const { page, store } = await open({ gate: { command: "./kb.sh test full", running: null, latest: null, basis: null }, status: 503 });
    const row = gateRow(page);
    await row.filter({ hasText: "状态读不出来" }).waitFor();
    await assertTone(row, "block");
    await deskSettled(page);
    assert.equal(await mainButton(page).isDisabled(), true, "没读到不等于没在跑");
    assert.equal(await mainButton(page).innerText(), "验收通过");
    await freezeAutoRetry(store);
    store.status = 0;
    const before = store.reads;
    await row.getByRole("button", { name: "重试", exact: true }).click();
    await waitUntil(() => store.reads > before, "点重试真的再读一次");
    await gateRow(page).filter({ hasText: "验收时运行" }).waitFor();
    await deskSettled(page);
    assert.equal(await mainButton(page).isEnabled(), true, "读到了才放开");
    assert.equal(await gateRow(page).getByRole("button", { name: "重试", exact: true }).count(), 0);
    await page.close();
  }

  // ⑯ 合并预览撞冲突：红行、不拦主按钮；让任务解决之后改口。
  {
    const issue = { reason: "merge_conflict", targetBranch: "main", conflictFiles: ["a.ts"], handoff: null };
    const { page, store } = await open({ gate: { command: "./kb.sh test full", running: null, latest: null, basis: null,
      baseline: "merge_preview", baselineTarget: { branch: "main", commit: "def67890" }, baselineIssue: issue } });
    const row = checkRow(page, "baseline");
    await assertTone(row, "block");
    assert.equal(await row.locator(".acc-check-text").innerText(), "与 main 冲突");
    assert.equal(await stateOf(row), "1 个文件");
    await row.locator(".acc-check-main").click();
    await row.locator(".acc-check-detail").getByText("a.ts", { exact: true }).waitFor();
    assert.equal(await mainButton(page).isEnabled(), true, "跳过不判基准，这一行不拦主按钮");
    const layer = await openConfirm(page);
    assert.equal(await layer.locator("em.is-red").filter({ hasText: "会撞冲突" }).count(), 1, "照跑会被拒在门禁之前，层里要说");
    await layer.getByRole("checkbox", { name: "运行前置命令" }).uncheck();
    assert.equal(await layer.getByText("会撞冲突").count(), 0);
    await layer.getByRole("button", { name: "取消", exact: true }).click();
    await row.getByRole("button", { name: "让任务解决", exact: true }).click();
    await waitUntil(() => store.conflictHandoffs === 1, "让任务解决发出 conflict-handoff");
    await row.filter({ hasText: "任务正在解决冲突" }).waitFor();
    await assertTone(row, "live");
    assert.equal(await stateOf(row), "main");
    assert.equal(await row.getByRole("button", { name: "让任务解决", exact: true }).count(), 0);
    assert.equal(store.accepts.length, 0);
    await page.close();
  }

  // ⑯ 交出去之后照服务端报回的投递结局说：排着 / 正在解决收起按钮；没送到、那一轮没解掉都给「再交一次」。
  for (const [handoff, text, state, button] of [
    [{ state: "queued", note: null }, "已交给任务，等它接手", "main", null],
    [{ state: "failed", note: "任务已归档，这一轮在启动前被撤回" }, "与 main 冲突", "没交出去", "再交一次"],
    [{ state: "ended", note: null }, "与 main 冲突", "任务那一轮没解掉", "再交一次"],
  ]) {
    const issue = { reason: "merge_conflict", targetBranch: "main", conflictFiles: ["a.ts"], handoff: { at: "2026-11-14T10:00:00Z", ...handoff } };
    const { page, store } = await open({ gate: { command: "./kb.sh test full", running: null, latest: null, basis: null,
      baseline: "merge_preview", baselineTarget: { branch: "main", commit: "def67890" }, baselineIssue: issue } });
    const row = checkRow(page, "baseline");
    await row.filter({ hasText: text }).waitFor();
    assert.equal(await stateOf(row), state, handoff.state);
    assert.equal(await row.getByRole("button", { name: "让任务解决", exact: true }).count(), 0, handoff.state);
    if (button) {
      await assertTone(row, "block");
      if (handoff.note) {
        await row.locator(".acc-check-main").click();
        await row.locator(".acc-check-detail").getByText(handoff.note).waitFor();
      }
      await row.getByRole("button", { name: button, exact: true }).click();
      await waitUntil(() => store.conflictHandoffs === 1, `${handoff.state}：再交一次照样发 conflict-handoff`);
      await row.filter({ hasText: "任务正在解决冲突" }).waitFor();
    } else {
      await assertTone(row, "live");
      assert.equal(await row.locator(".acc-check-tools button").count(), 0, "排着的时候没有出路可按，也不该有");
    }
    await page.close();
  }

  // ⑯ 另两种基准问题：同样是红行、不拦主按钮，没有直达出路。
  for (const [reason, text] of [["accept_gate_target_behind", "还没含有最新的 main"], ["accept_gate_preview_unavailable", "和 main 的合并预览做不出来"]]) {
    const { page } = await open({ gate: { command: "./kb.sh test full", running: null, latest: null, basis: null,
      baselineIssue: { reason, targetBranch: "main", conflictFiles: [], handoff: null } } });
    const row = checkRow(page, "baseline");
    assert.equal(await row.locator(".acc-check-text").innerText(), text);
    assert.equal(await row.getByRole("button").count(), 0);
    assert.equal(await mainButton(page).isEnabled(), true);
    await page.close();
  }
  console.log("accept gate confirm: run/commit checks ↔ /accept params with reset, blocking rows ↔ main button, baseline conflict hand-off covered");
}
