// 确认层那几勾 ↔ 发给后端的参数、前提列里的红行 ↔ 主按钮、合并预览冲突那一行。从
// test-accept-gate-dom.mjs 拆出来（那份贴着 700 行上限，按表面拆）。钉住的是：
//
// ⑭ 跳过与重跑**不再是单独的键**，是确认层「运行」那一勾：没有可沿用的绿时默认勾着、取消 =
//    这次跳过（gate:"skip"）；有一次还作数的绿时默认不勾（沿用那次，不带 gate）、勾上 = 重跑
//    （gate:"rerun"）。「提交」那一勾默认跟项目设置，发给 /accept 的 commit 就是层里看见的值，
//    取消时确认键改口「验收，不提交」。
// ⑭b 两勾的默认是**上一次真的确认验收时的样子**（用户 2026-11-15）：点确认才记（PUT /accept-memory），
//    关掉层（取消、Esc、再点主按钮）不记、回到记住的那个样子；记住跳过时前提列那一行先说「验收时跳过」，
//    不打开层也看得出；「提交」记成项目设置本身，没有管理权限时层里说只管这一次；有一次作数的绿时
//    沿用与重跑都不改记住的「跳没跳过」；记不住不拦验收、提示里说出来；「知情」那一勾不记。
// ⑭c 第 1 轮审查：层开着时项目默认被别处改了（project.updated / 断线重连），没手动动过的「提交」跟着变、
//    动过的照旧；「记住」挂住不返回时最多等几秒就照常验收；勾上派生任务一起验收时前提列不预告跳过
//    （统一验收不走「运行」那一勾）。
// ⑭d 第 2 轮审查：项目默认重读失败、挂住时，手动改过「提交」也不许确认；勾照画、写明在读，读有上限，
//    到点给「重试」。
// ⑭e 第 3 轮审查：确认只记跟默认不一样的那一勾 —— 层里那份默认可能是旧的（重读还没回来），没动过的勾写回去
//    会盖掉别处刚确认的新选择。
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
  // ⑭ 没有可沿用的绿（没跑过 / 过期了 / 上次红了）：运行默认勾着，取消 = gate:"skip"，确认之后记成「跳过」。
  for (const [label, latest, pending, skipping] of [["一次都没跑过", null, "验收时运行", "验收时跳过"],
    ["绿了但过期了", run({ stale: true }), "通过，但代码变了", "通过，但代码变了，验收时跳过"],
    ["上次红了", run({ status: "failed", exitCode: 1, failure: "exit_code" }), "未通过，还没交给任务", "未通过，还没交给任务，验收时跳过"]]) {
    const { page, store } = await open({ gate: { command: "./kb.sh test full", running: null, latest, basis: null } });
    assert.equal(await stateOf(gateRow(page)), pending, `${label}：前提列预告这一按会跑`);
    let layer = await openConfirm(page);
    const runBox = () => confirmLayer(page).getByRole("checkbox", { name: "运行前置命令" });
    const commitBox = () => confirmLayer(page).getByRole("checkbox", { name: "合并后提交" });
    assert.equal(await runBox().isChecked(), true, `${label}：默认要跑`);
    assert.equal(await commitBox().isChecked(), true, `${label}：提交跟项目默认（开）`);
    await layer.getByRole("button", { name: "确认验收", exact: true }).waitFor();

    // 只开关、动了勾又关掉：不记，下次打开还是原样。取消、Esc、再点一次主按钮三种关法都算。
    for (const close of ["取消", "Escape", "主按钮"]) {
      await runBox().uncheck();
      await commitBox().uncheck();
      if (close === "取消") await layer.getByRole("button", { name: "取消", exact: true }).click();
      else if (close === "Escape") await page.keyboard.press("Escape");
      else await mainButton(page).click();
      await confirmLayer(page).waitFor({ state: "detached" });
      layer = await openConfirm(page);
      assert.equal(await runBox().isChecked(), true, `${label}：${close} 关掉之后「运行」还是原样`);
      assert.equal(await commitBox().isChecked(), true, `${label}：${close} 关掉之后「提交」还是原样`);
    }
    assert.equal(store.memory.length, 0, `${label}：只开关不确认，什么都不记`);

    await runBox().uncheck();
    assert.equal(await layer.locator("li.is-off").count(), 1, `${label}：不跑的那一步划掉`);
    assert.equal(await layer.getByText("上次未通过").count(), latest?.status === "failed" ? 1 : 0);
    await layer.getByRole("button", { name: "跳过并验收", exact: true }).click();
    await accepted(store, 1);
    assert.deepEqual(store.accepts[0], { confirmUnverified: false, commit: true, gate: "skip" }, `${label}：这一按要带 gate=skip`);
    assert.deepEqual(store.memory, [{ skipGate: true }], `${label}：确认时记下改过的那一勾（提交照项目设置，不写回）`);
    // 发出去就关层；回执（这里是一句「验收没完成」）留在前提列里，细节点开看。
    await confirmLayer(page).waitFor({ state: "detached" });
    const failure = checkRow(page, "failure");
    assert.equal(await failure.locator(".acc-check-text").innerText(), "验收没完成");
    await failure.locator(".acc-check-main").click();
    await failure.getByText("模拟验收响应").waitFor();

    // 记住了跳过：不打开层，前提列那一行先说出来；打开层就是跳过的样子，确认键照样说破。
    await gateRow(page).filter({ hasText: skipping }).waitFor();
    await assertTone(gateRow(page), latest?.status === "failed" ? "failed" : "skipped", `${label}：记住跳过时那一行的调子`);
    layer = await openConfirm(page);
    assert.equal(await runBox().isChecked(), false, `${label}：上次跳过，这次默认不勾`);
    assert.equal(await layer.locator("li.is-off").count(), 1, `${label}：那一步照样划掉`);
    await layer.getByRole("button", { name: "跳过并验收", exact: true }).waitFor();
    // 关掉再开：还是跳过的样子（记住的值不被只开关改动）。
    await runBox().check();
    await layer.getByRole("button", { name: "取消", exact: true }).click();
    layer = await openConfirm(page);
    assert.equal(await runBox().isChecked(), false, `${label}：没确认的那一勾不算`);

    // 重新勾上、取消提交并确认：两样都记成新的，下一次打开恢复运行、默认不提交。
    await runBox().check();
    await commitBox().uncheck();
    await layer.getByRole("button", { name: "验收，不提交", exact: true }).waitFor();
    assert.match(await layer.innerText(), /改动留在 main 工作区/);
    await layer.getByRole("button", { name: "验收，不提交", exact: true }).click();
    await accepted(store, 2);
    assert.deepEqual(store.accepts[1], { confirmUnverified: false, commit: false }, `${label}：照跑、不提交`);
    assert.deepEqual(store.memory[1], { skipGate: false, commit: false });
    assert.equal(store.acceptCommit, false, `${label}：「提交」写回项目设置，设置页看到的是同一个值`);
    await gateRow(page).filter({ hasText: pending }).waitFor();
    assert.equal(await stateOf(gateRow(page)), pending, `${label}：恢复运行，那一行跟着改回来`);
    layer = await openConfirm(page);
    assert.equal(await runBox().isChecked(), true, `${label}：恢复为默认运行`);
    assert.equal(await commitBox().isChecked(), false, `${label}：上次不提交，这次默认不勾`);
    await layer.getByRole("button", { name: "验收，不提交", exact: true }).waitFor();
    await page.close();
  }

  // ⑭b 一打开就记着跳过（换浏览器、重启之后从服务端读回来的那份）：前提列与确认层一致，确认键要按才走。
  {
    const { page, store } = await open({ gate: { command: "./kb.sh test full", running: null, latest: null, basis: null, skipRemembered: true } });
    assert.equal(await stateOf(gateRow(page)), "验收时跳过", "不打开确认层也看得出这一按不会跑");
    await deskSettled(page);
    assert.equal(store.accepts.length, 0, "记住了也不会自动验收");
    const layer = await openConfirm(page);
    assert.equal(await layer.getByRole("checkbox", { name: "运行前置命令" }).isChecked(), false);
    await layer.getByRole("button", { name: "跳过并验收", exact: true }).click();
    await accepted(store, 1);
    assert.deepEqual(store.accepts[0], { confirmUnverified: false, commit: true, gate: "skip" });
    await page.close();
  }

  // ⑭b 有一次还作数的绿：记着跳过也照样默认沿用；沿用、重跑都不改记住的「跳没跳过」。
  {
    const { page, store } = await open({ gate: { command: "./kb.sh test full", running: null, latest: run(), basis: null, skipRemembered: true } });
    assert.match(await stateOf(gateRow(page)), /^通过 · /, "这一按沿用那次绿，不提跳过");
    let layer = await openConfirm(page);
    assert.equal(await layer.getByRole("checkbox", { name: "运行前置命令" }).isChecked(), false);
    assert.equal(await layer.locator("li.is-off").count(), 0, "沿用不是跳过");
    await layer.getByRole("checkbox", { name: "运行前置命令" }).check();
    await layer.getByRole("button", { name: "确认验收", exact: true }).click();
    await accepted(store, 1);
    assert.deepEqual(store.accepts[0], { confirmUnverified: false, commit: true, gate: "rerun" });
    assert.deepEqual(store.memory, [], "重跑是一次性的：不送「跳没跳过」；提交照项目设置，也不写回");
    assert.equal(store.gate.skipRemembered, true);
    layer = await openConfirm(page);
    assert.equal(await layer.getByRole("checkbox", { name: "运行前置命令" }).isChecked(), false, "重跑不记：下一次还是沿用");
    await page.close();
  }

  // ⑭b 没有项目管理权限：「提交」改了只管这一次（层里说清），发的照样是层里看见的值，项目设置不动。
  {
    const { page, store } = await open({ gate: { command: null, running: null, latest: null, basis: null }, role: "member" });
    const layer = await openConfirm(page);
    assert.equal(await layer.getByText("只管这一次，项目默认要管理员改").count(), 0, "没改就不说");
    await layer.getByRole("checkbox", { name: "合并后提交" }).uncheck();
    await layer.getByText("只管这一次，项目默认要管理员改").waitFor();
    await layer.getByRole("button", { name: "验收，不提交", exact: true }).click();
    await accepted(store, 1);
    assert.deepEqual(store.accepts[0], { confirmUnverified: false, commit: false });
    assert.deepEqual(store.memory, [{ commit: false }]);
    assert.equal(store.acceptCommit, undefined, "成员改不动项目设置");
    assert.equal(await (await openConfirm(page)).getByRole("checkbox", { name: "合并后提交" }).isChecked(), true, "下一次还是项目默认");
    await page.close();
  }

  // ⑭b 记不住不拦验收：这一按照层里看见的值发出去，提示里说出来没记住。
  {
    const { page, store } = await open({ gate: { command: "./kb.sh test full", running: null, latest: null, basis: null },
      acceptReply: () => { store.stage = "accepted"; return { status: 200, body: { accepted: true, taskId: "gate-task" } }; } });
    store.memoryDown = true;
    const layer = await openConfirm(page);
    await layer.getByRole("checkbox", { name: "运行前置命令" }).uncheck();
    await layer.getByRole("button", { name: "跳过并验收", exact: true }).click();
    await accepted(store, 1);
    assert.deepEqual(store.accepts[0], { confirmUnverified: false, commit: true, gate: "skip" });
    await page.getByRole("status", { name: "操作结果" }).filter({ hasText: "这次的选择没记住" }).waitFor();
    await page.close();
  }

  // ⑭c 层开着时项目默认在别处被改：没动过的那一勾跟着变，动过的照旧；断线重连之后也重读。
  {
    const { page, store } = await open({ gate: { command: null, running: null, latest: null, basis: null }, events: true });
    const layer = await openConfirm(page);
    const commitBox = layer.getByRole("checkbox", { name: "合并后提交" });
    assert.equal(await commitBox.isChecked(), true);
    store.acceptCommit = false;
    await page.evaluate(() => window.emitGateEvent({ type: "project.updated", projectId: "proj-1" }));
    await layer.getByRole("button", { name: "验收，不提交", exact: true }).and(page.locator("button:enabled")).waitFor();
    assert.equal(await commitBox.isChecked(), false, "没手动动过：跟最新的项目默认");
    // 手动勾上之后：连回来重读、再来一次项目变化，都不盖掉这一次的选择。
    await commitBox.check();
    const before = store.projectReads;
    await page.evaluate(() => { window.dropGateStream(); setTimeout(() => window.reopenGateStream(), 50); });
    await waitUntil(() => store.projectReads > before, "连回来之后重读项目默认");
    await page.evaluate(() => window.emitGateEvent({ type: "project.updated", projectId: "proj-1" }));
    await waitUntil(() => store.projectReads > before + 1, "又一次项目变化");
    await layer.getByRole("button", { name: "确认验收", exact: true }).and(page.locator("button:enabled")).waitFor();
    assert.equal(await commitBox.isChecked(), true, "手动勾过的这一次选择不被别处的改动盖掉");
    await layer.getByRole("button", { name: "确认验收", exact: true }).click();
    await accepted(store, 1);
    assert.deepEqual(store.accepts[0], { confirmUnverified: false, commit: true });
    await page.close();
  }

  // ⑭d 第 2 轮审查：手动改过「提交」之后项目默认重读失败 —— 勾留着看得见，确认键锁着、给重试；
  //     读到了才放开，发的是手动那一勾。
  {
    const { page, store } = await open({ gate: { command: null, running: null, latest: null, basis: null }, events: true,
      acceptReply: () => { store.stage = "accepted"; return { status: 200, body: { accepted: true, taskId: "gate-task" } }; } });
    const layer = await openConfirm(page);
    const commitBox = layer.getByRole("checkbox", { name: "合并后提交" });
    await commitBox.uncheck();
    store.projectDown = true;
    await page.evaluate(() => window.emitGateEvent({ type: "project.updated", projectId: "proj-1" }));
    await layer.getByText("项目默认读不出来").waitFor();
    assert.equal(await commitBox.isChecked(), false, "勾还在：看得见这一按会发什么");
    const confirm = layer.getByRole("button", { name: "验收，不提交", exact: true });
    assert.equal(await confirm.isEnabled(), false, "动过这一勾也不能绕过读不出来");
    store.projectDown = false;
    await layer.getByRole("button", { name: "重试", exact: true }).click();
    await confirm.and(page.locator("button:enabled")).waitFor();
    assert.equal(await commitBox.isChecked(), false, "读到了也不盖掉手动那一勾");
    await confirm.click();
    await accepted(store, 1);
    assert.deepEqual(store.accepts[0], { confirmUnverified: false, commit: false });
    await page.close();
  }

  // ⑭d 重读挂住不返回：层里写明在读，读有上限，到点落到「读不出来 · 重试」。
  {
    const { page, store } = await open({ gate: { command: null, running: null, latest: null, basis: null }, events: true });
    const layer = await openConfirm(page);
    const confirm = layer.getByRole("button", { name: "确认验收", exact: true });
    await confirm.and(page.locator("button:enabled")).waitFor();
    store.projectHold = new Promise(() => {});
    await page.evaluate(() => window.emitGateEvent({ type: "project.updated", projectId: "proj-1" }));
    await layer.getByText("读取项目默认").waitFor();
    assert.equal(await confirm.isEnabled(), false, "重读中不许确认");
    assert.equal(await layer.getByRole("checkbox", { name: "合并后提交" }).count(), 1, "重读中勾照画");
    await layer.getByText("项目默认读不出来").waitFor({ timeout: 15_000 });
    store.projectHold = null;
    await layer.getByRole("button", { name: "重试", exact: true }).click();
    await confirm.and(page.locator("button:enabled")).waitFor();
    await page.close();
  }

  // ⑭e 第 3 轮审查：另一页刚确认成「要运行」，这一页的门禁状态重读还没回来，用户照着层里那份旧的「跳过」
  //     确认（后台重读不灰确认键，见 test-accept-gate-reads.mjs ㉑）。这一按照看见的跳过，但没动过的那一勾
  //     不写回 —— 另一页刚记下的「要运行」不被盖掉，重读回来就是它。
  {
    const { page, store } = await open({ gate: { command: "./kb.sh test full", running: null, latest: null, basis: null, skipRemembered: true },
      events: true, acceptReply: () => ({ status: 200, body: { accepted: true, taskId: "gate-task" } }) });
    const layer = await openConfirm(page);
    const skip = layer.getByRole("button", { name: "跳过并验收", exact: true });
    await skip.and(page.locator("button:enabled")).waitFor();
    let release;
    store.hold = new Promise((resolve) => { release = resolve; });
    store.gate = { ...store.gate, skipRemembered: false };
    const before = store.reads;
    await page.evaluate(() => window.emitGateEvent({ type: "task.acceptGate", taskId: "gate-task" }));
    await waitUntil(() => store.reads > before, "重读发出去了（被扣住）");
    await skip.click();
    await accepted(store, 1);
    assert.deepEqual(store.accepts[0], { confirmUnverified: false, commit: true, gate: "skip" }, "发的是层里看见的");
    assert.deepEqual(store.memory, [], "没动过的勾不写回旧快照");
    assert.equal(store.gate.skipRemembered, false, "另一页刚记下的「要运行」还在");
    store.hold = null;
    release();
    await page.close();
  }

  // ⑭c 「记住」挂住不返回：最多等几秒，照层里看见的值验收，提示里说不一定记住了。
  {
    const { page, store } = await open({ gate: { command: "./kb.sh test full", running: null, latest: null, basis: null } });
    store.memoryHold = new Promise(() => {});
    const layer = await openConfirm(page);
    await layer.getByRole("checkbox", { name: "运行前置命令" }).uncheck();
    await layer.getByRole("button", { name: "跳过并验收", exact: true }).click();
    await waitUntil(() => store.accepts.length === 1, { message: "挂住的保存不能把验收一直拦在后面", timeout: 15_000 });
    assert.deepEqual(store.accepts[0], { confirmUnverified: false, commit: true, gate: "skip" });
    await page.getByRole("status", { name: "操作结果" }).filter({ hasText: "这次的选择不一定记住了：保存超时" }).waitFor();
    await deskSettled(page);
    assert.equal(await mainButton(page).isEnabled(), true, "验收走完之后主按钮放开");
    await page.close();
  }

  // ⑭c 记着跳过，但勾上派生任务一起验收：统一验收不走「运行」那一勾，前提列就不预告跳过。
  {
    const { page } = await open({ gate: { command: "./kb.sh test full", running: null, latest: null, basis: null, skipRemembered: true },
      children: ["派生甲"] });
    assert.equal(await stateOf(gateRow(page)), "验收时跳过");
    await checkRow(page, "child").getByRole("checkbox").check();
    await mainButton(page).filter({ hasText: "验收 2 个任务" }).waitFor();
    await gateRow(page).filter({ hasText: "验收时运行" }).waitFor();
    const layer = await openConfirm(page);
    assert.equal(await layer.getByRole("checkbox", { name: "运行前置命令" }).count(), 0, "确认层里本来就没有这一步");
    await layer.getByRole("button", { name: "取消", exact: true }).click();
    await checkRow(page, "child").getByRole("checkbox").uncheck();
    await gateRow(page).filter({ hasText: "验收时跳过" }).waitFor();
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
  console.log("accept gate confirm: run/commit checks ↔ /accept params, remembered defaults ↔ gate row, blocking rows ↔ main button, baseline conflict hand-off covered");
}
