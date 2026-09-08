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
  let snapshotCount = 0;
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/remote-snapshot")) {
      snapshotCount += 1;
      return route.fulfill({ json: { task, sessions: [], persisted: [], returnAvailable: true, target: { name: "远程服务器", url: targetUrl } } });
    }
    if (path.endsWith("/remote-return")) {
      requests.push(route.request().postDataJSON());
      const response = responses.shift();
      assert.ok(response, "移回请求不能多发或因轮询自动重试");
      return typeof response === "function" ? response(route) : route.fulfill(response);
    }
    throw new Error(`Unexpected API request: ${path}`);
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
  await page.waitForFunction(() => !document.querySelector(".workspace-toast.is-visible"));
  await page.waitForTimeout(3_200);
  assert.ok(snapshotCount > beforePoll, "覆盖错误出现后的正常远端轮询");
  assert.equal(await dialog.getByRole("alert").isVisible(), true, "轮询与 toast 消失都不能清掉移回失败");
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
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  assert.equal(await page.getByRole("alert").isVisible(), true, "关闭弹窗后详情页仍保留失败原因");
  dialog = await openReturn();
  assert.equal(await dialog.getByRole("alert").isVisible(), true);
  let releaseReturn;
  const returnGate = new Promise((resolve) => { releaseReturn = resolve; });
  responses = [async (route) => {
    await returnGate;
    await route.fulfill({ json: { task: { ...task, handoff: { direction: "returned" } } } });
  }];
  await dialog.getByRole("button", { name: "重试移回", exact: true }).click();
  const busyButton = dialog.getByRole("button", { name: "处理中…", exact: true });
  await busyButton.waitFor();
  assert.equal(await busyButton.isDisabled(), true);
  assert.equal(await dialog.getByRole("button", { name: "取消", exact: true }).isDisabled(), true);
  assert.equal(await dialog.getByRole("alert").count(), 0, "重试时清掉上一轮错误，但保持忙碌状态");
  releaseReturn();
  await page.getByRole("status").filter({ hasText: "本机任务" }).waitFor();
  assert.equal(await page.getByRole("alert").count(), 0);
  assert.deepEqual(requests, Array.from({ length: 2 }, () => ({ targetUrl, ignoreCapabilityGaps: false })));

  requests = [];
  responses = [
    { status: 409, json: { error: "本机缺少所需执行器", code: "capability-blocked" } },
    { status: 502, json: { error: networkError } },
    { json: { task: { ...task, handoff: { direction: "returned" } } } },
  ];
  await page.goto(url);
  dialog = await openReturn();
  await dialog.getByRole("button", { name: "移回本机", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "本机跑不动这个任务的执行器" });
  await dialog.getByRole("button", { name: "仍然移回", exact: true }).click();
  await dialog.getByRole("alert").waitFor();
  assert.match(await dialog.getByRole("alert").innerText(), /fetch failed/);
  await dialog.getByRole("button", { name: "仍然重试移回", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "本机任务" }).waitFor();
  assert.deepEqual(requests.map((request) => request.ignoreCapabilityGaps), [false, true, true]);

  responses = [{ status: 502, json: { error: networkError } }];
  await page.goto(url);
  dialog = await openReturn();
  await dialog.getByRole("button", { name: "移回本机", exact: true }).click();
  await dialog.getByRole("alert").waitFor();
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await page.getByRole("button", { name: "切换任务", exact: true }).click();
  await page.getByRole("alert").waitFor({ state: "detached" });
  assert.deepEqual(pageErrors, []);
} finally {
  await browser?.close();
  await server.close();
}

console.log("remote return browser tests passed: visible failure, polling, reopen, retry, capability override, task switch");
