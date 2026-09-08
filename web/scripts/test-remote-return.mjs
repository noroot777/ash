import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";
import { chromeLaunchOptions } from "./chrome-path.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const server = await createServer({ root, logLevel: "error", server: { host: "127.0.0.1", port: 0 } });
let browser;
const routeErrors = [];
const releasePending = [];
try {
  await server.listen();
  browser = await chromium.launch(await chromeLaunchOptions());
  const page = await browser.newPage({ viewport: { width: 1180, height: 780 } });
  page.setDefaultTimeout(10_000);
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const targetUrl = "http://remote.test:4317";
  const task = {
    id: "remote-return-task", projectId: "project", title: "查看理赔审核提案", body: "",
    mode: "single", status: "canceled", stage: null, labels: [], dependsOn: [], resumeDependsOn: [],
    createdAt: "2026-09-08T09:00:00.000Z", updatedAt: "2026-09-08T09:00:00.000Z",
    handoff: { direction: "in" },
  };
  const networkError = "对端返回 502：连不上对端 ash（http://source.test:4317/api/handoff/return/ping）：fetch failed";
  let responses = [];
  let requests = [];
  let requestedTaskIds = [];
  let snapshotCount = 0;
  let returnAvailable = true;
  let delayedSnapshot = null;
  const holdReturn = (response) => {
    const gate = Promise.withResolvers();
    releasePending.push(gate.resolve);
    return {
      release: gate.resolve,
      respond: async (route) => { await gate.promise; await route.fulfill(response); },
    };
  };
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    try {
      if (path.endsWith("/remote-snapshot")) {
        snapshotCount += 1;
        const taskId = path.split("/").at(-2);
        if (taskId === task.id && delayedSnapshot) {
          const respond = delayedSnapshot;
          delayedSnapshot = null;
          return await respond(route);
        }
        const selected = { ...task, id: taskId, title: taskId === task.id ? task.title : "另一条任务" };
        return await route.fulfill({ json: { task: selected, sessions: [], persisted: [], returnAvailable, target: { name: "远程服务器", url: targetUrl } } });
      }
      if (path.endsWith("/remote-return")) {
        requests.push(route.request().postDataJSON());
        requestedTaskIds.push(path.split("/").at(-2));
        const response = responses.shift();
        if (response) return await (typeof response === "function" ? response(route) : route.fulfill(response));
        routeErrors.push(`移回请求不能多发或因轮询自动重试: ${path}`);
      } else {
        routeErrors.push(`Unexpected API request: ${path}`);
      }
    } catch (error) {
      routeErrors.push(`${path}: ${error.message}`);
    }
    await route.fulfill({ status: 500, json: { error: routeErrors.at(-1) } }).catch(() => undefined);
  });
  const url = `http://127.0.0.1:${server.httpServer.address().port}/scripts/fixtures/remote-return.html`;
  const openReturn = async () => {
    await page.getByRole("button", { name: "移回本机…", exact: true }).click();
    return page.getByRole("dialog");
  };

  responses = [{ status: 502, json: { error: networkError } }];
  await page.goto(url);
  let dialog = await openReturn();
  await dialog.getByRole("button", { name: "移回本机", exact: true }).click();
  await dialog.getByRole("alert").waitFor();
  assert.match(await dialog.getByRole("alert").innerText(), /移回未完成[\s\S]*return\/ping[\s\S]*fetch failed/);
  assert.equal(await dialog.getByRole("button", { name: "重试移回", exact: true }).isEnabled(), true);
  const beforePoll = snapshotCount;
  await page.waitForTimeout(3_200);
  assert.ok(snapshotCount > beforePoll, "覆盖错误出现后的正常远端轮询");
  assert.equal(await dialog.getByRole("alert").isVisible(), true, "后续正常轮询不能清掉移回失败");
  assert.equal(requests.length, 1);
  const screenshot = process.env.REMOTE_RETURN_SHOT;
  if (screenshot) {
    await mkdir(dirname(screenshot), { recursive: true });
    await page.screenshot({ path: screenshot, fullPage: true });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  const mobileBounds = await dialog.boundingBox();
  assert.ok(mobileBounds && mobileBounds.x >= 0 && mobileBounds.x + mobileBounds.width <= 390);
  assert.ok(mobileBounds.y >= 0 && mobileBounds.y + mobileBounds.height <= 844, "窄屏仍能看到完整错误和重试按钮");
  if (screenshot) await page.screenshot({ path: screenshot.replace(/\.png$/, "-mobile.png"), fullPage: true });
  await page.setViewportSize({ width: 1180, height: 780 });
  returnAvailable = false;
  await page.getByRole("button", { name: "移回本机…", exact: true }).waitFor({ state: "detached" });
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  assert.equal(await page.getByRole("alert").isVisible(), true, "关闭弹窗后详情页仍保留失败原因");
  assert.equal(await page.getByRole("alert").getByRole("button").count(), 2, "没有原始移回入口时，横幅仍有重试和关闭出口");
  if (screenshot) await page.screenshot({ path: screenshot.replace(/\.png$/, "-banner.png"), fullPage: true });
  await page.getByRole("alert").getByRole("button", { name: "重试移回", exact: true }).click();
  dialog = page.getByRole("dialog");
  assert.equal(await dialog.getByRole("alert").isVisible(), true);
  const heldReturn = holdReturn({ json: { task: { ...task, handoff: { direction: "returned" } } } });
  responses = [heldReturn.respond];
  await dialog.getByRole("button", { name: "重试移回", exact: true }).click();
  const busyButton = dialog.getByRole("button", { name: "处理中…", exact: true });
  await busyButton.waitFor();
  assert.equal(await busyButton.isDisabled(), true);
  assert.equal(await dialog.getByRole("button", { name: "后台等待", exact: true }).isEnabled(), true);
  assert.equal(await dialog.getByRole("button", { name: "关闭把任务移回本机？", exact: true }).isEnabled(), true);
  assert.equal(await dialog.getByRole("alert").count(), 0, "重试时清掉上一轮错误，但保持忙碌状态");
  await page.waitForFunction(() => /已等待 [1-9]\d* 秒/.test(document.querySelector(".remote-return-progress")?.textContent ?? ""));
  assert.match(await dialog.getByRole("status").innerText(), /目前尚未收到完成确认[\s\S]*不会取消迁移/);
  if (screenshot) await page.screenshot({ path: screenshot.replace(/\.png$/, "-waiting.png"), fullPage: true });
  await dialog.getByRole("button", { name: "后台等待", exact: true }).click();
  for (const close of [
    () => page.keyboard.press("Escape"),
    () => dialog.getByRole("button", { name: "关闭把任务移回本机？", exact: true }).click(),
    () => page.locator(".task-modal-scrim").dispatchEvent("mousedown"),
  ]) {
    await page.getByRole("dialog").waitFor({ state: "detached" });
    assert.match(await page.locator(".remote-return-progress").innerText(), /正在等待移回确认/);
    await page.getByRole("button", { name: "查看移回进度", exact: true }).click();
    await close();
  }
  await page.getByRole("dialog").waitFor({ state: "detached" });
  assert.equal(requests.length, 2, "收起和重开进行态不能重复发送移回请求");
  const elapsedSeconds = Number((await page.locator(".remote-return-progress").innerText()).match(/已等待 (\d+) 秒/)[1]);
  await page.getByRole("button", { name: "切换任务", exact: true }).click();
  await page.locator(".task-detail-title").filter({ hasText: "另一条任务" }).waitFor();
  assert.equal(await page.locator(".remote-return-progress").count(), 0);
  await page.getByRole("button", { name: "切回原任务", exact: true }).click();
  await page.getByRole("button", { name: "查看移回进度", exact: true }).waitFor();
  await page.waitForFunction((elapsed) => Number(document.querySelector(".remote-return-progress")?.textContent?.match(/已等待 (\d+) 秒/)?.[1]) >= elapsed, elapsedSeconds);
  await page.getByRole("button", { name: "离开详情", exact: true }).click();
  assert.equal(await page.locator(".remote-task-detail").count(), 0);
  await page.waitForTimeout(1_100);
  await page.getByRole("button", { name: "重新打开详情", exact: true }).click();
  await page.waitForFunction((elapsed) => Number(document.querySelector(".remote-return-progress")?.textContent?.match(/已等待 (\d+) 秒/)?.[1]) > elapsed, elapsedSeconds);
  await page.getByRole("button", { name: "查看移回进度", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "处理中…", exact: true }).waitFor();
  assert.equal(await page.getByRole("dialog").getByRole("button", { name: "处理中…", exact: true }).isDisabled(), true);
  await page.getByRole("dialog").getByRole("button", { name: "后台等待", exact: true }).click();
  assert.equal(requests.length, 2, "切回及详情卸载重挂保留原请求与开始时间，不允许重复移回");
  if (screenshot) await page.screenshot({ path: screenshot.replace(/\.png$/, "-background.png"), fullPage: true });
  heldReturn.release();
  await page.getByRole("status").filter({ hasText: "本机任务" }).waitFor();
  assert.equal(await page.getByRole("alert").count(), 0);
  assert.deepEqual(requests, Array.from({ length: 2 }, () => ({ targetUrl, ignoreCapabilityGaps: false })));

  requests = [];
  returnAvailable = true;
  const heldCapabilityReturn = holdReturn({ status: 502, json: { error: networkError } });
  responses = [
    { status: 409, json: { error: "本机缺少所需执行器", code: "capability-blocked" } },
    heldCapabilityReturn.respond,
    { json: { task: { ...task, handoff: { direction: "returned" } } } },
  ];
  await page.goto(url);
  dialog = await openReturn();
  await dialog.getByRole("button", { name: "移回本机", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "本机跑不动这个任务的执行器" });
  await dialog.getByRole("button", { name: "仍然移回", exact: true }).click();
  await dialog.getByRole("status").waitFor();
  await dialog.getByRole("button", { name: "后台等待", exact: true }).click();
  heldCapabilityReturn.release();
  await page.getByRole("alert").waitFor();
  assert.equal(await page.getByRole("dialog").count(), 0, "后台收到失败时不强行重新打开弹窗");
  await page.getByRole("alert").getByRole("button", { name: "重试移回", exact: true }).click();
  await dialog.getByRole("alert").waitFor();
  assert.match(await dialog.getByRole("alert").innerText(), /fetch failed/);
  await dialog.getByRole("button", { name: "仍然重试移回", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "本机任务" }).waitFor();
  assert.deepEqual(requests.map((request) => request.ignoreCapabilityGaps), [false, true, true]);

  const heldCapabilityBlock = holdReturn({ status: 409, json: { error: "本机缺少所需执行器", code: "capability-blocked" } });
  responses = [heldCapabilityBlock.respond];
  await page.goto(url);
  dialog = await openReturn();
  await dialog.getByRole("button", { name: "移回本机", exact: true }).click();
  await dialog.getByRole("button", { name: "后台等待", exact: true }).click();
  heldCapabilityBlock.release();
  await page.getByRole("alert").waitFor();
  assert.match(await page.getByRole("alert").innerText(), /移回需要确认/);
  assert.equal(await page.getByRole("dialog").count(), 0);
  await page.getByRole("button", { name: "查看移回确认", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "本机跑不动这个任务的执行器" });
  await dialog.getByRole("button", { name: "仍然移回", exact: true }).waitFor();
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  if (screenshot) await page.screenshot({ path: screenshot.replace(/\.png$/, "-capability-banner.png"), fullPage: true });
  const beforeFreshAttempt = requests.length;
  responses = [{ status: 409, json: { error: "重新检查后仍缺少执行器", code: "capability-blocked" } }];
  dialog = await openReturn();
  await page.getByRole("dialog", { name: "把任务移回本机？", exact: true }).waitFor();
  assert.equal(await dialog.getByRole("button", { name: "仍然移回", exact: true }).count(), 0, "正常入口不能被陈旧能力确认劫持");
  if (screenshot) await page.screenshot({ path: screenshot.replace(/\.png$/, "-fresh-confirm.png"), fullPage: true, animations: "disabled" });
  await dialog.getByRole("button", { name: "移回本机", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "本机跑不动这个任务的执行器" });
  await dialog.getByText(/重新检查后仍缺少执行器/).waitFor();
  assert.deepEqual(requests.slice(beforeFreshAttempt).map((request) => request.ignoreCapabilityGaps), [false], "关闭能力确认后正常入口必须重新执行门禁");
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await page.getByRole("button", { name: "知道了", exact: true }).click();
  assert.equal(await page.getByRole("alert").count(), 0);

  responses = [{ status: 502, json: { error: networkError } }];
  await page.goto(url);
  dialog = await openReturn();
  await dialog.getByRole("button", { name: "移回本机", exact: true }).click();
  await dialog.getByRole("alert").waitFor();
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await page.getByRole("alert").getByRole("button", { name: "知道了", exact: true }).click();
  assert.equal(await page.getByRole("alert").count(), 0, "失败横幅可以由用户关闭");

  for (const pending of [false, true]) {
    responses = [{ json: { task: { ...task, handoff: { direction: "out", pending } } } }];
    await page.goto(url);
    dialog = await openReturn();
    await dialog.getByRole("button", { name: "移回本机", exact: true }).click();
    await dialog.getByRole("alert").waitFor();
    assert.match(await dialog.getByRole("alert").innerText(), /尚未确认任务已移回本机/);
    assert.equal(await page.getByRole("status").filter({ hasText: "本机任务" }).count(), 0);
    assert.match(await page.locator(".workspace-toast").innerText(), /^「查看理赔审核提案」移回未完成：尚未确认任务已移回本机/, "本机仍是 out 存档时只能通知未完成，不能报成功");
  }

  for (const response of [
    { status: 502, json: { error: networkError } },
    { json: { task: { ...task, handoff: { direction: "returned" } } } },
  ]) {
    requests = [];
    const held = holdReturn(response);
    responses = [held.respond];
    await page.goto(url);
    dialog = await openReturn();
    await dialog.getByRole("button", { name: "移回本机", exact: true }).click();
    await dialog.getByRole("button", { name: "后台等待", exact: true }).click();
    const heldSnapshot = holdReturn({ status: 404, json: { error: "远端任务已移回" } });
    delayedSnapshot = heldSnapshot.respond;
    await Promise.all([
      page.waitForRequest((request) => request.url().includes(`/${task.id}/remote-snapshot`)),
      page.getByRole("button", { name: "刷新远程会话", exact: true }).click(),
    ]);
    await page.getByRole("button", { name: "切换任务", exact: true }).click();
    await page.locator(".task-detail-title").filter({ hasText: "另一条任务" }).waitFor();
    if (!response.status) await page.getByRole("button", { name: "离开详情", exact: true }).click();
    const finished = page.waitForResponse((result) => result.url().endsWith("/remote-return"));
    held.release();
    await finished;
    const snapshotFinished = page.waitForResponse((result) => result.url().includes(`/${task.id}/remote-snapshot`));
    heldSnapshot.release();
    await snapshotFinished;
    await page.waitForTimeout(100);
    assert.equal(await page.getByRole("alert").count(), 0, "上一任务的迟到失败不能污染当前任务");
    assert.equal(await page.getByRole("status").filter({ hasText: "本机任务" }).count(), 0, "上一任务的迟到成功不能切走当前任务");
    assert.match(await page.locator(".workspace-toast").innerText(), new RegExp(task.title), "后台移回的迟到结果应通知具体任务");
    if (!response.status) await page.getByRole("button", { name: "重新打开详情", exact: true }).click();
    await page.locator(".task-detail-title").filter({ hasText: "另一条任务" }).waitFor();
    if (screenshot) await page.screenshot({ path: screenshot.replace(/\.png$/, `-late-${response.status ? "failure" : "success"}.png`), fullPage: true });
    await page.getByRole("button", { name: "切回原任务", exact: true }).click();
    if (response.status) {
      await page.getByRole("alert").waitFor();
      assert.match(await page.getByRole("alert").innerText(), /移回未完成[\s\S]*fetch failed/);
      if (screenshot) await page.screenshot({ path: screenshot.replace(/\.png$/, "-restored-failure.png"), fullPage: true });
      responses = [{ json: { task: { ...task, handoff: { direction: "returned" } } } }];
      await page.getByRole("button", { name: "重试移回", exact: true }).click();
      await page.getByRole("dialog").getByRole("button", { name: "重试移回", exact: true }).click();
      await page.getByRole("status").filter({ hasText: "本机任务" }).waitFor();
      assert.equal(requests.length, 2, "切回可显式重试迟到失败");
    } else {
      await page.getByRole("status").filter({ hasText: "本机任务" }).waitFor();
      assert.equal(requests.length, 1, "切回后消费原请求成功结果，不重新迁移");
      await page.getByRole("button", { name: "同任务再次接力", exact: true }).click();
      await page.getByRole("button", { name: "移回本机…", exact: true }).waitFor();
      assert.equal(await page.getByRole("status").filter({ hasText: "本机任务" }).count(), 0, "新的 transferId 不得继承历史成功");
      responses = [{ status: 502, json: { error: "新一轮移回失败" } }];
      dialog = await openReturn();
      await dialog.getByRole("button", { name: "移回本机", exact: true }).click();
      await dialog.getByRole("alert").waitFor();
      assert.equal(requests.length, 2, "同一任务的新接力可以发起新的移回");
    }
  }

  requests = [];
  requestedTaskIds = [];
  const heldFirst = holdReturn({ status: 502, json: { error: "原任务独立失败" } });
  const heldSecond = holdReturn({ status: 502, json: { error: "另一任务独立失败" } });
  responses = [heldFirst.respond, heldSecond.respond];
  await page.goto(url);
  dialog = await openReturn();
  await dialog.getByRole("button", { name: "移回本机", exact: true }).click();
  await dialog.getByRole("button", { name: "后台等待", exact: true }).click();
  await page.getByRole("button", { name: "切换任务", exact: true }).click();
  await page.locator(".task-detail-title").filter({ hasText: "另一条任务" }).waitFor();
  dialog = await openReturn();
  await dialog.getByRole("button", { name: "移回本机", exact: true }).click();
  await dialog.getByRole("button", { name: "后台等待", exact: true }).click();
  await page.getByRole("button", { name: "切回原任务", exact: true }).click();
  dialog = await openReturn();
  assert.equal(await dialog.getByRole("button", { name: "处理中…", exact: true }).isDisabled(), true);
  await dialog.getByRole("button", { name: "后台等待", exact: true }).click();
  await page.getByRole("button", { name: "离开详情", exact: true }).click();
  heldSecond.release();
  await page.locator(".workspace-toast").filter({ hasText: "另一条任务" }).waitFor();
  heldFirst.release();
  await page.locator(".workspace-toast").filter({ hasText: "原任务独立失败" }).waitFor();
  await page.getByRole("button", { name: "重新打开详情", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "原任务独立失败" }).waitFor();
  await page.getByRole("button", { name: "切换任务", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "另一任务独立失败" }).waitFor();
  assert.deepEqual(requestedTaskIds, [task.id, "another-task"], "多个任务并发移回彼此独立，同一任务只发一次");

  responses = [{ status: 502, json: { error: networkError } }];
  await page.goto(url);
  dialog = await openReturn();
  await dialog.getByRole("button", { name: "移回本机", exact: true }).click();
  await dialog.getByRole("alert").waitFor();
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await page.getByRole("button", { name: "切换任务", exact: true }).click();
  await page.getByRole("alert").waitFor({ state: "detached" });

  responses = [{ status: 502, json: { error: networkError } }];
  await page.goto(url);
  await page.getByRole("button", { name: "模拟预览失败", exact: true }).click();
  const pinnedToast = page.getByTestId("workspace-toast-pinned");
  await pinnedToast.waitFor();
  dialog = await openReturn();
  await dialog.getByRole("button", { name: "移回本机", exact: true }).click();
  await dialog.getByRole("alert").waitFor();
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  assert.match(await page.getByTestId("workspace-toast-transient").innerText(), /查看理赔审核提案[\s\S]*移回未完成/);
  assert.match(await pinnedToast.innerText(), /预览命令缺失/, "移回结果通知不能覆盖主线的常驻预览错误");
  if (screenshot) await page.screenshot({ path: screenshot.replace(/\.png$/, "-toast-coexist.png"), fullPage: true, animations: "disabled" });
  await page.getByTestId("workspace-toast-transient").waitFor({ state: "detached" });
  assert.equal(await pinnedToast.isVisible(), true, "移回通知自动消失后，主线常驻错误仍保留");
  await pinnedToast.getByRole("button", { name: "关闭提示", exact: true }).click();
  await pinnedToast.waitFor({ state: "detached" });
  assert.match(await page.getByRole("alert").innerText(), /移回未完成/, "关闭预览提示不能清掉移回操作的失败记录");
  assert.deepEqual(pageErrors, []);
} finally {
  releasePending.forEach((release) => release());
  await browser?.close();
  await server.close();
  assert.deepEqual(routeErrors, [], "所有模拟 API 请求都应被处理；未预期请求或重复移回必须在主流程报错");
}

console.log("remote return browser tests passed: visible errors, background waiting, task switching/remount, independent operations, fresh capability checks, override retry, false success, retained late results, new transfers, workspace toast coexistence");
