import assert from "node:assert/strict";

async function openFixture({ browser, base, hold = false, clock = false }) {
  const page = await browser.newPage({ viewport: { width: 1100, height: 820 } });
  if (clock) await page.clock.install();
  const store = {
    gate: { command: "npm run current-check", running: null, latest: null, basis: null },
    requests: [], taskReads: 0, failure: null, stage: "verified",
  };
  await page.addInitScript(hold => {
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
    const streams = new Set();
    window.EventSource = class {
      constructor() { streams.add(this); queueMicrotask(() => this.onopen?.()); }
      close() { streams.delete(this); }
    };
    window.emitGateEvent = event => {
      for (const stream of streams) stream.onmessage?.({ data: JSON.stringify(event) });
    };
    window.reconnectGateEvents = () => {
      for (const stream of streams) stream.onerror?.();
      setTimeout(() => { for (const stream of streams) stream.onopen?.(); }, 50);
    };
  }, hold);
  await page.route("**/api/**", route => {
    const pathname = new URL(route.request().url()).pathname;
    const json = (body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (pathname === "/api/projects") return json([{ id: "proj-1", myRole: "member", acceptCommit: true }]);
    if (pathname.endsWith("/branch-plan")) return json({ task: { blocker: null, dependency: null, strategy: "safe" } });
    if (pathname.endsWith("/accept-gate")) return json(store.gate);
    if (pathname.endsWith("/accept")) {
      store.requests.push(JSON.parse(route.request().postData()));
      return json(store.failure ?? { accepted: false, taskId: "gate-task", reason: "target_unresolved", error: "模拟验收响应" }, 409);
    }
    if (pathname === "/api/tasks/gate-task") {
      store.taskReads++;
      return json({ id: "gate-task", projectId: "proj-1", title: "门禁卡", body: "", mode: "single",
        status: "done", stage: store.stage, labels: [], dependsOn: [], resumeDependsOn: [], agentType: "claude",
        useWorktree: true, workflowMode: "free", createdAt: "2026-10-23T00:00:00Z", updatedAt: "2026-10-25T00:00:00Z" });
    }
    return json({ error: `Unexpected request: ${pathname}` }, 404);
  });
  await page.goto(`${base}?controls=1`);
  if (hold) await page.waitForFunction(() => window.gateReadSignals.some(signal => signal && !signal.aborted));
  return { page, store };
}

export async function testAcceptGateReads({ browser, base }) {
  {
    const { page, store } = await openFixture({ browser, base });
    try {
      await page.locator(".accept-gate-command").getByText("npm run current-check", { exact: true }).waitFor();
      await page.getByRole("button", { name: "验收通过", exact: true }).click();
      const dialog = page.getByRole("dialog");
      const confirm = dialog.getByRole("button", { name: "验收通过", exact: true });
      await page.waitForFunction(() => document.querySelector(".task-confirm-dialog footer button:last-child")?.disabled === false);
      for (const trigger of ["task.acceptGate", "task.updated", "reconnect"]) {
        const reads = await page.evaluate(() => { window.holdGateReads = true; return window.gateReadSignals.length; });
        await page.evaluate(trigger => {
          if (trigger === "reconnect") window.reconnectGateEvents();
          else window.emitGateEvent(trigger === "task.updated"
            ? { type: trigger, task: { id: "gate-task" } } : { type: trigger, taskId: "gate-task" });
        }, trigger);
        await page.waitForFunction(reads => window.gateReadSignals.length > reads, reads);
        await dialog.getByText(/正在后台核对配置/).waitFor();
        assert.match(await dialog.innerText(), /上次读取的项目命令：npm run current-check/);
        assert.equal(await confirm.isEnabled(), true, `${trigger} must not disable confirmation during background reads`);
        const held = await page.evaluate(() => window.gateReadSignals.length - 1);
        await page.evaluate(() => {
          window.holdGateReads = false;
          window.emitGateEvent({ type: "task.acceptGate", taskId: "gate-task" });
        });
        await dialog.getByText(/项目配置的前置命令：/).waitFor();
        assert.equal(await page.evaluate(index => window.gateReadSignals[index].aborted, held), true);
      }
      await page.evaluate(() => { window.holdGateReads = true; window.emitGateEvent({ type: "task.acceptGate", taskId: "gate-task" }); });
      await dialog.getByText(/正在后台核对配置/).waitFor();
      await confirm.click();
      await page.locator(".team-accept-failure").filter({ hasText: "模拟验收响应" }).waitFor();
      assert.equal(store.requests.length, 1, "the accept handler must also permit a background read");
    } finally { await page.close(); }
  }

  {
    const { page } = await openFixture({ browser, base, hold: true });
    try {
      const card = page.locator('.accept-gate-card[aria-busy="true"]');
      await card.waitFor();
      const refresh = card.getByRole("button", { name: "刷新", exact: true });
      assert.equal(await refresh.isEnabled(), true, "an initial pending read must have a refresh escape");
      const held = await page.evaluate(() => { window.holdGateReads = false; return window.gateReadSignals.length - 1; });
      await refresh.click();
      await page.getByText("npm run current-check", { exact: true }).waitFor();
      assert.equal(await page.evaluate(index => window.gateReadSignals[index].aborted, held), true);
      await page.getByRole("button", { name: "验收通过", exact: true }).click();
      const confirm = page.getByRole("dialog").getByRole("button", { name: "验收通过", exact: true });
      await page.waitForFunction(() => document.querySelector(".task-confirm-dialog footer button:last-child")?.disabled === false);
      assert.equal(await confirm.isEnabled(), true);
    } finally { await page.close(); }
  }

  {
    const { page } = await openFixture({ browser, base, hold: true, clock: true });
    try {
      await page.locator('.accept-gate-card[aria-busy="true"]').waitFor();
      await page.clock.runFor(15001);
      await page.getByRole("alert").filter({ hasText: "读取验收前置命令超时（15 秒）" }).waitFor();
      assert.equal(await page.evaluate(() => window.gateReadSignals.at(-1)?.aborted), true);
      await page.evaluate(() => { window.holdGateReads = false; });
      await page.clock.runFor(1001);
      await page.getByText("npm run current-check", { exact: true }).waitFor();
    } finally { await page.close(); }
  }

  for (const entry of [
    { stage: "merged", reason: "worktree_remove_failed", completedMerge: { targetBranch: "main", commit: "abcdef12" } },
    { stage: "accepted", reason: "preview_cleanup_pending", completedMerge: { targetBranch: "main", commit: "abcdef12" } },
    { stage: "merged", reason: "branch_delete_failed", completedTag: "ash-accepted/gate-task" },
  ]) {
    const { page, store } = await openFixture({ browser, base });
    try {
      store.stage = entry.stage;
      store.failure = { ...entry, accepted: false, taskId: "gate-task", dirtyFiles: ["scratch.txt"],
        error: entry.completedMerge ? "成果已合入 main（提交 abcdef12），目录及文件已保留" : "标签 ash-accepted/gate-task 已创建，目录及文件已保留" };
      await page.getByText("npm run current-check", { exact: true }).waitFor();
      await page.getByRole("button", { name: "验收通过", exact: true }).click();
      await page.getByRole("dialog").getByRole("button", { name: "验收通过", exact: true }).click();
      await page.getByText("这次验收没有留下门禁凭据", { exact: true }).waitFor();
      const notice = page.locator(".team-accept-failure");
      await notice.getByText("scratch.txt", { exact: true }).waitFor();
      assert.match(await notice.innerText(), entry.completedMerge ? /合并已完成，清理未完成.*abcdef12/s : /标签已创建，清理未完成.*ash-accepted\/gate-task/s);
      assert.equal(store.taskReads, 1, "notice must survive the merged/accepted task refresh");
    } finally { await page.close(); }
  }
  console.log("accept gate reads: background confirmation, pending refresh, timeout recovery and post-merge failures covered");
}
