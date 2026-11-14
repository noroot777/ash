// 门禁读取的并发与超时，在验收台上看是什么样。由 test-accept-gate-actions.mjs 调用。
//
// ㉑ 确认层开着时后台的重读（事件、任务更新、重连）**不许把确认键灰掉**：手上那份状态一直有效，
//    读一次就锁一次，用户会在按下去那一刻撞上一颗刚变灰的键。被扣住的那一发由追平层的期限掐掉、
//    补发的那一趟落地；这一按自己也不等后台那一发。
// ㉒ 首读挂住：主按钮转圈、不出一行字；到了 15 秒期限就如实说「状态读不出来」带「重试」，主按钮
//    仍锁着，之后自己退避重试读到才放开。
// ㉓ 验收合并已完成、清理没做完（worktree / 预览 / 分支删不掉）：照实说一句（成果已合入、目录保留），
//    任务刷新成已验收之后前置命令那一行换成回执，不拿最近一次门禁冒充凭据。
import assert from "node:assert/strict";
import { CATCH_UP_DEADLINE_MS } from "../src/lib/catchUp.ts";
import { confirmLayer, deskSettled, gateRow, mainButton, openConfirm, stateOf, checkRow } from "./accept-gate-stage.mjs";
import { WAIT_TIMEOUT_MS, waitUntil } from "./wait-until.mjs";

/** 页面里那层 fetch：记下每一发门禁读取的 signal，`holdGateReads` 为真时扣住不回（只能被 abort）。 */
const holdReads = (hold) => (page) => page.addInitScript(hold => {
  window.holdGateReads = hold;
  window.gateReadSignals = [];
  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    if (String(input).endsWith("/accept-gate")) {
      window.gateReadSignals.push(init?.signal);
      if (window.holdGateReads) return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal.reason), { once: true });
      });
    }
    return nativeFetch(input, init);
  };
}, hold);

const gate = { command: "npm run current-check", running: null, latest: null, basis: null };

export async function testAcceptGateReads({ open }) {
  {
    const { page, store } = await open({ gate, events: true, init: holdReads(false) });
    try {
      await gateRow(page).filter({ hasText: "npm run current-check" }).waitFor();
      const layer = await openConfirm(page);
      const confirm = layer.getByRole("button", { name: "确认验收", exact: true });
      await waitUntil(() => confirm.isEnabled(), "确认键可以按");
      for (const trigger of ["task.acceptGate", "task.updated", "reconnect"]) {
        const reads = await page.evaluate(() => { window.holdGateReads = true; return window.gateReadSignals.length; });
        await page.evaluate(trigger => {
          if (trigger === "reconnect") { window.dropGateStream(); setTimeout(() => window.reopenGateStream(), 50); }
          else window.emitGateEvent(trigger === "task.updated"
            ? { type: trigger, task: { id: "gate-task" } } : { type: trigger, taskId: "gate-task" });
        }, trigger);
        await page.waitForFunction(reads => window.gateReadSignals.length > reads, reads);
        assert.equal(await confirm.isEnabled(), true, `${trigger} must not disable confirmation during background reads`);
        assert.equal(await mainButton(page).getAttribute("aria-busy"), null, `${trigger}：后台读取不让主按钮转圈`);
        assert.equal(await layer.getByRole("checkbox", { name: "运行前置命令" }).isChecked(), true, "层里那份状态照常摆着");
        const held = await page.evaluate(() => window.gateReadSignals.length - 1);
        await page.evaluate(() => {
          window.holdGateReads = false;
          window.emitGateEvent({ type: "task.acceptGate", taskId: "gate-task" });
        });
        // 被扣住的那一发不会自己回来：事件触发的 run() 只记一笔欠账（不抢占），要等追平层的
        // 期限把它掐掉、补发的那一趟才落地。所以预算是「期限 + 满载余量」，不是 locator 默认的 30 秒。
        await page.waitForFunction(index => window.gateReadSignals[index].aborted, held, { timeout: CATCH_UP_DEADLINE_MS + WAIT_TIMEOUT_MS });
        await page.waitForFunction(index => window.gateReadSignals.length > index + 1, held);
        assert.equal(await confirmLayer(page).count(), 1, "后台读取不收起确认层");
      }
      await page.evaluate(() => { window.holdGateReads = true; window.emitGateEvent({ type: "task.acceptGate", taskId: "gate-task" }); });
      await confirm.click();
      await checkRow(page, "failure").filter({ hasText: "验收没完成" }).waitFor();
      assert.equal(store.accepts.length, 1, "the accept handler must also permit a background read");
    } finally { await page.close(); }
  }

  {
    const { page } = await open({ gate, init: holdReads(true), clock: true, ready: false });
    try {
      await page.waitForFunction(() => window.gateReadSignals.some(signal => signal && !signal.aborted));
      const busy = page.locator(".acc-bar button.acc-btn.is-primary[aria-busy='true']");
      await busy.waitFor();
      assert.equal(await busy.isDisabled(), true);
      assert.equal(await gateRow(page).count(), 0);
      await page.clock.runFor(15001);
      await gateRow(page).filter({ hasText: "状态读不出来" }).waitFor();
      assert.equal(await page.evaluate(() => window.gateReadSignals.at(-1)?.aborted), true);
      assert.equal(await gateRow(page).getByRole("button", { name: "重试", exact: true }).count(), 1);
      assert.equal(await mainButton(page).isDisabled(), true, "读超时不放行");
      await page.evaluate(() => { window.holdGateReads = false; });
      await page.clock.runFor(1001);
      await gateRow(page).filter({ hasText: "npm run current-check" }).waitFor();
      assert.equal(await stateOf(gateRow(page)), "验收时运行");
      await deskSettled(page);
      assert.equal(await mainButton(page).isEnabled(), true);
    } finally { await page.close(); }
  }

  for (const entry of [
    { stage: "merged", reason: "worktree_remove_failed", completedMerge: { targetBranch: "main", commit: "abcdef12" } },
    { stage: "accepted", reason: "preview_cleanup_pending", completedMerge: { targetBranch: "main", commit: "abcdef12" } },
    { stage: "merged", reason: "branch_delete_failed", completedTag: "ash-accepted/gate-task" },
  ]) {
    const error = entry.completedMerge ? "成果已合入 main（提交 abcdef12），目录及文件已保留" : "标签 ash-accepted/gate-task 已创建，目录及文件已保留";
    const { page, store } = await open({ gate, acceptReply: () => {
      store.stage = entry.stage;
      return { status: 409, body: { ...entry, accepted: false, taskId: "gate-task", dirtyFiles: ["scratch.txt"], error } };
    } });
    try {
      await (await openConfirm(page)).getByRole("button", { name: "确认验收", exact: true }).click();
      await page.getByRole("status", { name: "操作结果" }).filter({ hasText: error }).waitFor();
      await page.locator(".acc-done").filter({ hasText: "已验收" }).waitFor();
      await gateRow(page).filter({ hasText: "没留下验收凭据" }).waitFor();
      assert.equal(store.taskFetches, 1, "合并已完成就把任务刷成已验收（只刷一次）");
      // 合并已完成、清理没做完：刷成已验收之后那一行仍在，挡路的文件展开就看得见。
      const failure = page.locator('[data-check="failure"]');
      await failure.filter({ hasText: entry.completedMerge ? "合并已完成，清理没做完" : "标签已打，清理没做完" }).waitFor();
      await failure.locator("button.acc-check-main").click();
      await failure.locator(".acc-check-detail").filter({ hasText: "scratch.txt" }).waitFor();
    } finally { await page.close(); }
  }
  console.log("accept gate reads: background confirmation, pending timeout recovery and post-merge failures covered");
}
