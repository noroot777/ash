import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";
import { chromeLaunchOptions } from "./chrome-path.mjs";

// 新建面板「创建并排队」在途提交期间删除刚建任务的迟到响应回归(第 7、8、9 轮审查)。
// 夹具挂真实 useTasks + 真实面板开合接线(fixtures/composer-delete-race.tsx):
//   0. 对照:填正文 → 关面板 → 重开,草稿保留(正常取消重开不丢字);
//   A. 第 7 轮:扣住建队响应 → SSE 送达新任务行 → 本页删除 → 放行,不复活不选中;
//   B. 第 8 轮:扣住入队响应 → SSE 送达 → 另一页面删除(权威列表不再含它)→ 本页
//      真实 refetch 追平(行消失)→ 放行,不复活不选中;
//   C. 第 9 轮(insert 分支):扣住 → SSE → 删除 → 关面板 → 新开面板写新草稿 →
//      放行,新面板不被关、新草稿不被清;
//   D. 第 9 轮(建队分支):同 C,前驱换成仍独立的任务走 POST /api/queues;
//   E. 对照:没删过的首次创建照常插入并选中、面板收起。
const root = fileURLToPath(new URL("..", import.meta.url));
const server = await createServer({ root, logLevel: "error", server: { host: "127.0.0.1", port: 0 } });
let browser;
try {
  await server.listen();
  browser = await chromium.launch(await chromeLaunchOptions());
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));

  const TITLES = { "t-backlog": "存量待办任务", "t-backlog2": "另一个待办任务" };
  const row = (overrides) => ({
    id: "t-backlog", title: "存量待办任务", status: "backlog", projectId: "p1", parentId: null,
    archived: false, mode: "single", groupId: null, queueId: null, queuePosition: null,
    updatedAt: "2026-10-08T07:00:00.000Z", ...overrides,
  });
  // GET /api/tasks 的权威列表由测试脚本控制 —— 场景 B 靠改它模拟「另一页面删除后的
  // 服务端状态」。SSE(/api/events)按普通 JSON 响应被 EventSource 拒绝,connected
  // 一直为 false,不会有自动追平来抢,刷新时机完全由测试点「权威刷新」决定。
  let taskList = [row({}), row({ id: "t-backlog2", title: "另一个待办任务" })];
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
      const qid = body.taskIds[0] === "t-backlog2" ? "q2" : "q1";
      data = { queueId: qid, taskIds: body.taskIds,
        tasks: body.taskIds.map((tid, i) => row({ id: tid, title: TITLES[tid] ?? tid,
          queueId: qid, queuePosition: i, updatedAt: "2026-10-08T07:00:02.000Z" })) };
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
  const composerOpen = page.getByTestId("composer-open");
  const submitQueued = async (text, target = "存量待办任务") => {
    await page.getByRole("button", { name: /^智能体：/ }).waitFor();
    await objective.fill(text);
    await page.waitForFunction(() => !document.querySelector(".studio-submit")?.disabled);
    await page.getByRole("button", { name: /^启动设置：/ }).click();
    await page.getByLabel("启动方式").selectOption("queue");
    await page.locator(".composer-queue-after .ui-select-trigger").click();
    await page.locator(".ui-dropdown-row", { hasText: target }).click();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "创建并排队", exact: true }).click();
  };
  const release = () => {
    const resolve = releaseEnqueue;
    releaseEnqueue = null;
    holdEnqueue = false;
    resolve();
  };
  const waitHeld = async () => { while (!releaseEnqueue) await new Promise((resolve) => setTimeout(resolve, 50)); };
  const enqueuedToast = (target) => page.getByText(new RegExp(`已排在「${target}」之后`));

  // ── 场景 0(对照):正常关面板再重开,草稿原样保留 ──
  await page.getByRole("button", { name: /^智能体：/ }).waitFor();
  await objective.fill("只是草稿,还没提交");
  await page.getByTestId("close-composer").click();
  await page.getByTestId("open-composer").click();
  assert.equal(await objective.inputValue(), "只是草稿,还没提交", "正常关开面板草稿必须保留");

  // ── 场景 A(第 7 轮):task-1 的建队响应被扣住;期间 SSE 送达它的行、本页删除它;放行。
  holdEnqueue = true;
  await submitQueued("审查7-删除本次新建任务");
  await waitHeld();
  await page.getByTestId("sse-create-task-1").click();
  assert.match(await rows.innerText(), /task-1:独立/, "SSE 已把新任务行送到列表");
  await page.getByTestId("delete-task-1").click();
  assert.doesNotMatch(await rows.innerText(), /task-1/, "本页删除后行已消失");
  release();
  await enqueuedToast("存量待办任务").first().waitFor({ timeout: 5000 });
  assert.doesNotMatch(await rows.innerText(), /task-1/, "迟到的创建完成回写不得复活本页删除的任务");
  assert.equal(await page.getByTestId("selected").innerText(), "无", "已删除的任务不得被自动选中");
  assert.equal(await composerOpen.innerText(), "关", "面板仍是提交那份时,守卫命中照常收面板");

  // ── 场景 B(第 8 轮):task-2 的入队响应被扣住;期间另一页面删除它(权威列表不含它),
  // 本页经真实 refetch 追平;放行后迟到回写同样整段跳过。
  await page.getByTestId("open-composer").click();
  holdEnqueue = true;
  await submitQueued("审查8-跨页删除任务");
  await waitHeld();
  await page.getByTestId("sse-create-task-2").click();
  assert.match(await rows.innerText(), /task-2:独立/, "SSE 已把新任务行送到列表");
  taskList = [row({ queueId: "q1", queuePosition: 0, updatedAt: "2026-10-08T07:00:04.000Z" }),
    row({ id: "t-backlog2", title: "另一个待办任务", updatedAt: "2026-10-08T07:00:04.000Z" })];
  await page.getByTestId("refetch").click();
  await page.waitForFunction(() => !document.querySelector('[data-testid="rows"]')?.innerText.includes("task-2"));
  release();
  await enqueuedToast("存量待办任务").nth(1).waitFor({ timeout: 5000 });
  assert.doesNotMatch(await rows.innerText(), /task-2/, "权威刷新确认跨页删除后,迟到回写不得复活该任务");
  assert.equal(await page.getByTestId("selected").innerText(), "无", "跨页删除的任务不得被自动选中");

  // ── 场景 C(第 9 轮,insert 分支):提交被扣住期间删除新任务、关面板、新开面板写
  // 新草稿;放行旧响应时新面板不得被关、新草稿不得被清。
  await page.getByTestId("open-composer").click();
  holdEnqueue = true;
  await submitQueued("审查9-删除后另写新草稿");
  await waitHeld();
  await page.getByTestId("sse-create-task-3").click();
  await page.getByTestId("delete-task-3").click();
  await page.getByTestId("close-composer").click();
  await page.getByTestId("open-composer").click();
  await objective.fill("第二个任务的草稿,这段字必须保留");
  release();
  await enqueuedToast("存量待办任务").nth(2).waitFor({ timeout: 5000 });
  assert.equal(await composerOpen.innerText(), "开", "旧请求不得关闭用户新开的面板");
  assert.equal(await objective.inputValue(), "第二个任务的草稿,这段字必须保留", "旧请求不得清掉新面板的草稿");
  assert.doesNotMatch(await rows.innerText(), /task-3/, "已删除任务不复活");
  assert.equal(await page.getByTestId("selected").innerText(), "无", "已删除的任务不得被自动选中");
  // 再关开一轮确认草稿在 Store 里也完好(不是只剩屏幕上那份)。
  await page.getByTestId("close-composer").click();
  await page.getByTestId("open-composer").click();
  assert.equal(await objective.inputValue(), "第二个任务的草稿,这段字必须保留", "草稿库里的新草稿同样未被清");

  // ── 场景 D(第 9 轮,建队分支):前驱换成仍独立的任务走 POST /api/queues,同一套
  // 删除→换面板→写新草稿流程。
  await objective.fill("");
  holdEnqueue = true;
  await submitQueued("审查9-建队分支删除后另写", "另一个待办任务");
  await waitHeld();
  await page.getByTestId("sse-create-task-4").click();
  await page.getByTestId("delete-task-4").click();
  await page.getByTestId("close-composer").click();
  await page.getByTestId("open-composer").click();
  await objective.fill("建队分支的新草稿,也必须保留");
  release();
  await enqueuedToast("另一个待办任务").first().waitFor({ timeout: 5000 });
  assert.equal(await composerOpen.innerText(), "开", "建队分支:旧请求不得关闭新面板");
  assert.equal(await objective.inputValue(), "建队分支的新草稿,也必须保留", "建队分支:新草稿不得被清");
  assert.doesNotMatch(await rows.innerText(), /task-4/, "建队分支:已删除任务不复活");

  // ── 场景 E(对照):没删过的首次创建照常回插并选中、面板收起。
  await objective.fill("");
  await submitQueued("正常创建的任务");
  await enqueuedToast("存量待办任务").nth(3).waitFor({ timeout: 5000 });
  assert.match(await rows.innerText(), /task-5:q1:1/, "真正首次创建仍按入队快照插入");
  assert.equal(await page.getByTestId("selected").innerText(), "task-5", "正常创建仍自动选中");
  assert.equal(await composerOpen.innerText(), "关", "正常创建完成后面板照常收起");

  assert.deepEqual(errors, []);
  console.log("composer delete-while-inflight regression passed (local + cross-page refetch + draft ownership)");
} finally {
  await browser?.close();
  await server.close();
}
