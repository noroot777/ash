import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";
import { chromeLaunchOptions } from "./chrome-path.mjs";

// 新建面板「创建并排队」在途提交期间删除刚建任务的迟到响应回归(第 7、8 轮审查)。
// 夹具挂真实 useTasks(fixtures/composer-delete-race.tsx),三轮:
//   A. 第 7 轮:扣住建队响应 → SSE 送达新任务行 → 本页删除 → 放行,不复活不选中;
//   B. 第 8 轮:扣住入队响应 → SSE 送达 → 另一页面删除(权威列表不再含它)→ 本页
//      真实 refetch 追平(行消失,confirmedDeletions 登记)→ 放行,不复活不选中;
//   C. 对照:没删过的首次创建照常插入并选中。
const root = fileURLToPath(new URL("..", import.meta.url));
const server = await createServer({ root, logLevel: "error", server: { host: "127.0.0.1", port: 0 } });
let browser;
try {
  await server.listen();
  browser = await chromium.launch(await chromeLaunchOptions());
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));

  const row = (overrides) => ({
    id: "t-backlog", title: "存量待办任务", status: "backlog", projectId: "p1", parentId: null,
    archived: false, mode: "single", groupId: null, queueId: null, queuePosition: null,
    updatedAt: "2026-10-08T07:00:00.000Z", ...overrides,
  });
  // GET /api/tasks 的权威列表由测试脚本控制 —— 场景 B 靠改它模拟「另一页面删除后的
  // 服务端状态」。SSE(/api/events)按普通 JSON 响应被 EventSource 拒绝,connected
  // 一直为 false,不会有自动追平来抢,刷新时机完全由测试点「权威刷新」决定。
  let taskList = [row({})];
  let taskSeq = 0;
  let holdEnqueue = false;
  let releaseEnqueue = null;
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    let data = [];
    if (path === "/api/agents") data = [{ id: "exec-claude", name: "claude@cpa", type: "claude", model: "claude-opus-4.6", reasoningEffort: "high", providerId: "provider-cpa", isDefault: true }];
    if (path === "/api/llm-providers") data = [{ id: "provider-cpa", name: "CPA 中转", protocol: "anthropic", baseUrl: "https://example.invalid", model: "claude-opus-4.6", protocolConversionEnabled: false, modelListMode: "pinned", pinnedModels: ["claude-opus-4.6"], context1mModels: [], hasKey: true, createdAt: "2026-09-07T00:00:00.000Z" }];
    if (path === "/api/settings") data = { defaultWorkflowId: null };
    if (path.endsWith("/branches")) data = { branches: ["main"], current: "main" };
    if (path === "/api/tasks" && request.method() === "GET") data = taskList;
    if (path === "/api/tasks" && request.method() === "POST") {
      const body = request.postDataJSON();
      taskSeq += 1;
      data = { ...body, id: `task-${taskSeq}`, status: "backlog", title: body.body, updatedAt: "2026-10-08T07:00:01.000Z" };
    }
    // 排队的两条路径都可被扣住:目标还独立时走建队,已在队列时走 insert。
    if (path === "/api/queues" && request.method() === "POST") {
      const body = request.postDataJSON();
      if (holdEnqueue) await new Promise((resolve) => { releaseEnqueue = resolve; });
      data = { queueId: "q1", taskIds: body.taskIds,
        tasks: body.taskIds.map((tid, i) => row({ id: tid, title: tid === "t-backlog" ? "存量待办任务" : tid,
          queueId: "q1", queuePosition: i, updatedAt: "2026-10-08T07:00:02.000Z" })) };
    }
    if (/\/api\/queues\/q1\/insert$/.test(path) && request.method() === "POST") {
      const body = request.postDataJSON();
      if (holdEnqueue) await new Promise((resolve) => { releaseEnqueue = resolve; });
      const tasks = [
        row({ queueId: "q1", queuePosition: 0, updatedAt: "2026-10-08T07:00:03.000Z" }),
        row({ id: body.taskId, title: body.taskId, queueId: "q1", queuePosition: 1, updatedAt: "2026-10-08T07:00:03.000Z" }),
      ];
      data = { ok: true, task: tasks[1], tasks };
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(data) });
  });

  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/scripts/fixtures/composer-delete-race.html`);
  const objective = page.getByRole("textbox", { name: "任务目标" });
  const rows = page.getByTestId("rows");
  const submitQueued = async (text) => {
    await page.getByRole("button", { name: /^智能体：/ }).waitFor();
    await objective.fill(text);
    await page.waitForFunction(() => !document.querySelector(".studio-submit")?.disabled);
    await page.getByRole("button", { name: /^启动设置：/ }).click();
    await page.getByLabel("启动方式").selectOption("queue");
    await page.locator(".composer-queue-after .ui-select-trigger").click();
    await page.locator(".ui-dropdown-row", { hasText: "存量待办任务" }).click();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "创建并排队", exact: true }).click();
  };
  const release = () => {
    const resolve = releaseEnqueue;
    releaseEnqueue = null;
    holdEnqueue = false;
    resolve();
  };
  const enqueuedToast = page.getByText(/已排在「存量待办任务」之后/);

  // 场景 A(第 7 轮):task-1 的建队响应被扣住;期间 SSE 送达它的行、本页删除它;放行。
  holdEnqueue = true;
  await submitQueued("审查7-删除本次新建任务");
  while (!releaseEnqueue) await new Promise((resolve) => setTimeout(resolve, 50));
  await page.getByTestId("sse-create-task-1").click();
  assert.match(await rows.innerText(), /task-1:独立/, "SSE 已把新任务行送到列表");
  await page.getByTestId("delete-task-1").click();
  assert.doesNotMatch(await rows.innerText(), /task-1/, "本页删除后行已消失");
  release();
  await enqueuedToast.waitFor({ timeout: 5000 });
  assert.doesNotMatch(await rows.innerText(), /task-1/, "迟到的创建完成回写不得复活本页删除的任务");
  assert.equal(await page.getByTestId("selected").innerText(), "无", "已删除的任务不得被自动选中");

  // 场景 B(第 8 轮):task-2 的入队响应被扣住;期间另一页面删除它(权威列表不含它),
  // 本页经真实 refetch 追平;放行后迟到回写同样整段跳过。
  holdEnqueue = true;
  await submitQueued("审查8-跨页删除任务");
  while (!releaseEnqueue) await new Promise((resolve) => setTimeout(resolve, 50));
  await page.getByTestId("sse-create-task-2").click();
  assert.match(await rows.innerText(), /task-2:独立/, "SSE 已把新任务行送到列表");
  taskList = [row({ queueId: "q1", queuePosition: 0, updatedAt: "2026-10-08T07:00:04.000Z" })];
  await page.getByTestId("refetch").click();
  await page.waitForFunction(() => !document.querySelector('[data-testid="rows"]')?.innerText.includes("task-2"));
  release();
  await enqueuedToast.nth(1).waitFor({ timeout: 5000 });
  assert.doesNotMatch(await rows.innerText(), /task-2/, "权威刷新确认跨页删除后,迟到回写不得复活该任务");
  assert.equal(await page.getByTestId("selected").innerText(), "无", "跨页删除的任务不得被自动选中");

  // 场景 C(对照):没删过的首次创建照常回插并选中(同样有在途响应,但没有删除)。
  await submitQueued("正常创建的任务");
  await enqueuedToast.nth(2).waitFor({ timeout: 5000 });
  assert.match(await rows.innerText(), /task-3:q1:1/, "真正首次创建仍按入队快照插入");
  assert.equal(await page.getByTestId("selected").innerText(), "task-3", "正常创建仍自动选中");

  assert.deepEqual(errors, []);
  console.log("composer delete-while-inflight regression passed (local + cross-page refetch)");
} finally {
  await browser?.close();
  await server.close();
}
