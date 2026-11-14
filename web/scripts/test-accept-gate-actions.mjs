// 真人动作那一道闸：验收按下去被前置命令拦回来之后，这一屏怎么接着走。从 test-accept-gate-dom.mjs
// 拆出来（那份贴着 700 行上限，按表面拆）。钉住的是：
//
// ⑰ 一按被 409 拦回来（门禁红了）**没有 SSE 也要把门禁那一行刷出来**：拦回来的那一刻就是用户最
//    想看清「为什么」的时刻。门禁状态此刻读不出来时由「前置命令没通过，没有合并」那一行兜着，
//    主按钮锁着（读不出来不放行），读到之后由门禁那一行接手。
// ⑱ 归档 / 任务在跑 / 宿主那道关（审查进行中）任何一个在，主按钮都锁着，原因各自一行。
// ⑲ 红了之后的两条出路都在确认层里，**打开确认层不动任何东西**：取消「运行」+ 取消「提交」
//    发的是 {commit:false, gate:"skip"}；照常确认（失败从不被沿用）就是重跑，回执说「已开跑」
//    之后那一行写「运行中」、主按钮锁着，确认层不留着。
// ⑳ 门禁还在读的时候主按钮只转圈不放行（文字不变）；读到的命令是项目**现在**那一条，不是
//    上一次跑的那一条；读出来是「没设」就没有这一行、确认层里也不跑；读失败不能被当成「没设」。
import assert from "node:assert/strict";
import { assertTone, checkRow, confirmLayer, deskSettled, gateRow, mainButton, openConfirm } from "./accept-gate-stage.mjs";
import { testAcceptGateReads } from "./test-accept-gate-reads.mjs";
import { waitUntil } from "./wait-until.mjs";

export async function testAcceptGateActions({ open, run }) {
  for (const projection of ["unset", "loaded", "error"]) {
    const latest = run({ status: "failed", exitCode: 1, failure: "exit_code", logTail: "acceptance failed" });
    const loaded = { command: latest.command, running: null, latest, basis: null };
    const unset = { command: null, running: null, latest: null, basis: null };
    let replies = 0;
    const acceptReply = (body) => {
      replies += 1;
      if (replies === 1) {
        // 第一按：门禁红了。此后读到的门禁是那份红（error 投影则读不出来）。
        store.gate = loaded;
        if (projection === "error") store.status = 500;
        return { status: 409, body: { accepted: false, taskId: "gate-task", reason: "accept_gate_failed",
          error: "验收前置命令未通过（rc=1），没有重跑，也没有合并。", gate: latest } };
      }
      if (body.gate === "skip") return { status: 409, body: { accepted: false, taskId: "gate-task", reason: "target_unresolved", error: "模拟验收响应" } };
      const view = { ...latest, status: "running", exitCode: null, finishedAt: null };
      store.gate = { ...loaded, running: view, latest: view };
      return { status: 409, body: { accepted: false, taskId: "gate-task", reason: "accept_gate_running", error: "已开跑", gate: view } };
    };
    const { page, store } = await open({ gate: projection === "loaded" ? loaded : unset, acceptReply });
    try {
      await (await openConfirm(page)).getByRole("button", { name: "确认验收", exact: true }).click();
      await waitUntil(() => store.accepts.length === 1, "第一按发出去");
      assert.deepEqual(store.accepts[0], { confirmUnverified: false, commit: true }, `${projection}：第一按不带 gate`);
      if (projection === "error") {
        // ⑰ 读不出来：由那一行兜着说「没通过」，主按钮锁着。
        const failure = checkRow(page, "failure");
        await failure.filter({ hasText: "前置命令没通过，没有合并" }).waitFor();
        await assertTone(failure, "failed");
        await deskSettled(page);
        assert.equal(await mainButton(page).isDisabled(), true, "门禁读不出来时不放行");
        // 服务端恢复：追平层自己退避重试读到，门禁那一行接手，兜底那一行收起。
        store.status = 0;
        await gateRow(page).filter({ hasText: "未通过" }).waitFor({ timeout: 25_000 });
        await failure.waitFor({ state: "detached" });
      }
      const row = gateRow(page);
      await row.filter({ hasText: "未通过，还没交给任务" }).waitFor();
      assert.match(await row.locator(".acc-log pre").innerText(), /acceptance failed/, "红了日志就地展开");
      if (projection === "unset") assert.ok(store.reads >= 2, "409 without SSE must refresh the gate projection");
      assert.equal(await checkRow(page, "failure").count(), 0, "门禁那一行读得到时，不再另起一行重复说没通过");

      // ⑱ 三道闸：主按钮锁着、原因各自一行。
      for (const [guard, key] of [["archived", "archived"], ["running", "in-flight"], ["blocked", "host"]]) {
        await page.getByLabel("保护状态").selectOption(guard);
        await checkRow(page, key).waitFor();
        assert.equal(await mainButton(page).isDisabled(), true, `${guard}：主按钮锁着`);
        if (guard !== "blocked") assert.equal(await row.getByRole("button", { name: "交给任务", exact: true }).isDisabled(), true);
      }
      assert.equal(await checkRow(page, "host").innerText(), "审查进行中");
      await page.getByLabel("保护状态").selectOption("none");

      // ⑲ 跳过且不提交：开层、动勾都不发东西。
      let layer = await openConfirm(page);
      await layer.getByRole("checkbox", { name: "运行前置命令" }).uncheck();
      assert.match(await layer.innerText(), /上次未通过/);
      await layer.getByRole("checkbox", { name: "合并后提交" }).uncheck();
      assert.equal(store.accepts.length, 1, "opening skip confirmation must not mutate anything");
      await layer.getByRole("button", { name: "跳过并验收", exact: true }).click();
      await waitUntil(() => store.accepts.length === 2, "跳过那一按发出去");
      assert.deepEqual(store.accepts[1], { confirmUnverified: false, commit: false, gate: "skip" });
      await checkRow(page, "failure").filter({ hasText: "验收没完成" }).waitFor();

      // ⑲ 照常确认 = 重跑：回执说已开跑，那一行换成「运行中」，主按钮锁着，层不留着。
      layer = await openConfirm(page);
      assert.equal(await layer.getByRole("checkbox", { name: "运行前置命令" }).isChecked(), true, "上一按的取消不该留到这一按");
      await layer.getByRole("button", { name: "确认验收", exact: true }).click();
      await waitUntil(() => store.accepts.length === 3, "重跑那一按发出去");
      assert.deepEqual(store.accepts[2], { confirmUnverified: false, commit: true });
      await gateRow(page).filter({ hasText: "运行中" }).waitFor();
      await page.getByRole("status", { name: "操作结果" }).filter({ hasText: "已开跑" }).waitFor();
      assert.equal(await mainButton(page).isDisabled(), true);
      assert.equal(await confirmLayer(page).count(), 0);
    } finally {
      await page.close();
    }
  }

  // ⑳ 还在读 → 读到现在那条命令 → 撤掉 → 读不出来。
  {
    const release = Promise.withResolvers();
    const previous = run({ command: "npm run previous-check", status: "failed", exitCode: 1 });
    const { page, store } = await open({ role: "member", hold: release.promise, ready: false,
      gate: { command: "npm run current-check", running: null, latest: previous, basis: null } });
    try {
      const main = page.locator(".acc-bar button.acc-btn.is-primary[aria-busy='true']");
      await main.waitFor();
      // 还没读到门禁时连确认层都不给开：主按钮禁用、转圈，字不变。
      assert.equal(await main.isDisabled(), true);
      assert.equal(await main.innerText(), "验收通过");
      assert.equal(await gateRow(page).count(), 0, "读取中不出一行字（不让它闪进来又闪出去）");
      store.hold = null;
      release.resolve();
      const layer = await openConfirm(page);
      await layer.locator("code").filter({ hasText: "npm run current-check" }).waitFor();
      await layer.getByRole("button", { name: "取消", exact: true }).click();
      assert.match(await gateRow(page).locator(".acc-check-text").innerText(), /npm run current-check/);
      assert.doesNotMatch(await gateRow(page).locator(".acc-check-text").innerText(), /previous-check/);

      store.gate = { command: null, running: null, latest: null, basis: null };
      await page.reload();
      await deskSettled(page);
      assert.equal(await gateRow(page).count(), 0, "没设就没有这一行");
      const unsetLayer = await openConfirm(page);
      assert.equal(await unsetLayer.getByRole("checkbox", { name: "运行前置命令" }).count(), 0);
      assert.equal(await unsetLayer.getByRole("button", { name: "设一条前置命令", exact: true }).count(), 0, "成员没有入口");
      await unsetLayer.getByRole("button", { name: "取消", exact: true }).click();

      store.status = 500;
      await page.reload();
      await gateRow(page).filter({ hasText: "状态读不出来" }).waitFor();
      assert.equal(await mainButton(page).isDisabled(), true, "读取失败不能当作未设置");
      store.status = 0;
      await gateRow(page).waitFor({ state: "detached", timeout: 25_000 });
      await deskSettled(page);
      assert.equal(await mainButton(page).isEnabled(), true);
    } finally {
      release.resolve();
      await page.close();
    }
  }
  await testAcceptGateReads({ open });
  console.log("accept gate failure actions: 409 refresh, guards, skip/rerun through the confirm layer and read states covered");
}
