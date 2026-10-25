import assert from "node:assert/strict";
import { testAcceptGateReads } from "./test-accept-gate-reads.mjs";

export async function testAcceptGateActions({ browser, base, run }) {
  const json = (route, body, status = 200) => route.fulfill({
    status, contentType: "application/json", body: JSON.stringify(body),
  });
  for (const projection of ["unset", "loaded", "error"]) {
    const page = await browser.newPage({ viewport: { width: 1100, height: 820 } });
    const latest = run({ status: "failed", exitCode: 1, failure: "exit_code", logTail: "acceptance failed" });
    const store = { requests: [], reads: 0, failed: false, running: false, reason: "accept_gate_failed" };
    await page.addInitScript(() => {
      window.EventSource = class {
        constructor() { queueMicrotask(() => this.onopen?.()); }
        close() {}
      };
    });
    await page.route("**/api/**", async route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === "/api/projects") return json(route, [{ id: "proj-1", myRole: "member", acceptCommit: true }]);
      if (pathname.endsWith("/branch-plan")) return json(route, { task: { blocker: null, dependency: null, strategy: "safe" } });
      if (pathname.endsWith("/accept-gate")) {
        store.reads++;
        if (projection === "error" && store.failed) return json(route, { error: "状态暂时读不出来" }, 500);
        const shown = store.running ? { ...latest, status: "running", exitCode: null } : latest;
        return json(route, projection !== "loaded" && !store.failed
          ? { command: null, latest: null, running: null, basis: null }
          : { command: latest.command, latest: shown, running: store.running ? shown : null, basis: null });
      }
      if (pathname.endsWith("/accept")) {
        const request = JSON.parse(route.request().postData());
        store.requests.push(request);
        store.failed = true;
        store.running = request.gate === "rerun";
        return json(route, {
          accepted: false, taskId: latest.taskId,
          reason: store.running ? "accept_gate_running" : store.reason,
          error: "验收前置命令未通过（rc=1），没有重跑，也没有合并。",
          gate: store.running ? { ...latest, status: "running", exitCode: null } : latest,
        }, 409);
      }
      return json(route, { error: `Unexpected request: ${pathname}` }, 404);
    });
    try {
      await page.goto(`${base}?controls=1`);
      await page.getByRole("button", { name: "验收通过", exact: true }).click();
      await page.getByRole("dialog").getByRole("button", { name: "验收通过", exact: true }).click();
      const failure = page.locator(".team-accept-failure, .accept-gate-card.is-failed");
      await failure.getByRole("button", { name: "重跑一次", exact: true }).waitFor();
      assert.equal(store.requests.length, 1);
      assert.equal(store.requests[0].gate, undefined);
      if (projection !== "error") {
        await page.locator(".accept-gate-card").filter({ hasText: "acceptance failed" }).waitFor();
      }
      assert.equal(await page.getByRole("button", { name: "重跑一次", exact: true }).count(), 1);
      assert.equal(await page.getByRole("button", { name: "这次跳过它，直接合并", exact: true }).count(), 1);
      if (projection === "unset") assert.ok(store.reads >= 2, "409 without SSE must refresh the gate projection");

      for (const guard of ["archived", "running", "blocked"]) {
        await page.getByLabel("保护状态").selectOption(guard);
        assert.equal(await failure.getByRole("button", { name: "重跑一次", exact: true }).isDisabled(), true);
        assert.equal(await failure.getByRole("button", { name: "这次跳过它，直接合并" }).isDisabled(), true);
      }
      await page.getByLabel("保护状态").selectOption("none");
      await failure.getByRole("button", { name: "这次跳过它，直接合并" }).click();
      let dialog = page.getByRole("dialog");
      assert.match(await dialog.innerText(), /这一次不跑.*上一次是红的/s);
      assert.equal(store.requests.length, 1, "opening skip confirmation must not mutate anything");
      await dialog.getByRole("button", { name: "取消", exact: true }).click();
      await page.getByRole("button", { name: "验收通过", exact: true }).click();
      dialog = page.getByRole("dialog");
      assert.equal(await dialog.getByRole("button", { name: "跳过前置命令并验收" }).count(), 0);
      await dialog.getByRole("button", { name: "取消", exact: true }).click();
      await failure.getByRole("button", { name: "这次跳过它，直接合并" }).click();
      dialog = page.getByRole("dialog");
      await dialog.getByRole("checkbox", { name: "合并后提交代码" }).uncheck();
      await dialog.getByRole("button", { name: "跳过前置命令并验收" }).click();
      await failure.getByRole("button", { name: "重跑一次", exact: true }).waitFor();
      assert.deepEqual(store.requests[1], { confirmUnverified: false, commit: false, gate: "skip" });

      await failure.getByRole("button", { name: "重跑一次", exact: true }).click();
      dialog = page.getByRole("dialog");
      assert.match(await dialog.innerText(), /从头跑一遍.*rc=0/s);
      assert.equal(store.requests.length, 2);
      await dialog.getByRole("button", { name: "重跑前置命令", exact: true }).click();
      await failure.waitFor({ state: "hidden" });
      assert.deepEqual(store.requests[2], { confirmUnverified: false, commit: true, gate: "rerun" });
      if (projection !== "error") await page.locator(".accept-gate-card.is-running").waitFor();
      assert.equal(await page.getByRole("dialog").count(), 0);
    } finally {
      await page.close();
    }
  }
  {
    const page = await browser.newPage();
    let release;
    const waiting = new Promise(resolve => { release = resolve; });
    let status = 200;
    let gate = { command: "npm run current-check", running: null,
      latest: run({ command: "npm run previous-check", status: "failed", exitCode: 1 }), basis: null };
    await page.addInitScript(() => {
      window.EventSource = class {
        constructor() { queueMicrotask(() => this.onopen?.()); }
        close() {}
      };
    });
    await page.route("**/api/**", async route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === "/api/projects") return json(route, [{ id: "proj-1", myRole: "member", acceptCommit: true }]);
      if (pathname.endsWith("/branch-plan")) return json(route, { task: { blocker: null, dependency: null, strategy: "safe" } });
      if (pathname.endsWith("/accept-gate")) {
        await waiting;
        return json(route, status === 200 ? gate : { error: "读取失败，不能当作未设置" }, status);
      }
      return json(route, { error: "No mutation expected" }, 409);
    });
    try {
      await page.goto(`${base}?controls=1`);
      await page.locator('.accept-gate-card[aria-busy="true"]').waitFor();
      assert.match(await page.getByRole("region", { name: "验收前置命令" }).innerText(), /正在读取/);
      await page.getByRole("button", { name: "验收通过", exact: true }).click();
      assert.equal(await page.getByRole("dialog").getByRole("button", { name: "验收通过", exact: true }).isDisabled(), true);
      release();
      await page.getByRole("dialog").getByText("npm run current-check", { exact: true }).waitFor();
      await page.getByRole("dialog").getByRole("button", { name: "取消", exact: true }).click();
      assert.match(await page.locator(".accept-gate-command").innerText(), /npm run current-check/);
      assert.doesNotMatch(await page.locator(".accept-gate-command").innerText(), /previous-check/);
      assert.match(await page.locator(".accept-gate-card").innerText(), /previous-check/);
      gate = { command: null, running: null, latest: null, basis: null };
      await page.reload();
      await page.getByText("未设置（验收时不运行前置命令）", { exact: true }).waitFor();
      assert.equal(await page.getByRole("button", { name: "设一条" }).count(), 0);
      status = 500;
      await page.reload();
      await page.getByRole("alert").filter({ hasText: "读取失败，不能当作未设置" }).waitFor();
      assert.equal(await page.getByText("未设置（验收时不运行前置命令）", { exact: true }).count(), 0);
      status = 200;
      await page.getByRole("button", { name: "刷新", exact: true }).click();
      await page.getByText("未设置（验收时不运行前置命令）", { exact: true }).waitFor();
    } finally {
      release();
      await page.close();
    }
  }
  await testAcceptGateReads({ browser, base });
  console.log("accept gate failure actions: inline recovery, explicit confirmation, guards and projection refresh covered");
}
