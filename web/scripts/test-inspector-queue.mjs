import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";
import { chromeLaunchOptions } from "./chrome-path.mjs";

// 真实 Inspector 回调链的迟到响应回归(第 6 轮审查两条拦验收):
// ① insert 响应在途期间 SSE 送达更晚的「移出」,旧响应放行后不得反转回排队中;
// ② 响应里包含本页已删除成员的旧快照,放行后不得把已删任务加回列表。
// 夹具挂生产 TaskInspector,接线照抄 WorkspaceShell/TaskDetail(见 fixtures/inspector-queue.tsx)。
const T1 = "2026-10-08T06:00:05.000Z"; // K1 健康入队
const T6 = "2026-10-08T06:00:06.000Z"; // K2 的在途 insert 响应(旧)
const T9 = "2026-10-08T06:00:09.000Z"; // SSE 送达的移出(新)

const root = fileURLToPath(new URL("..", import.meta.url));
const server = await createServer({ root, logLevel: "error", server: { host: "127.0.0.1", port: 0 } });
let browser;
try {
  await server.listen();
  browser = await chromium.launch(await chromeLaunchOptions());
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));

  const TITLES = { "t-prev": "前驱任务A", "t-b": "队列成员B", "t-k1": "主体K1", "t-k2": "主体K2" };
  const member = (id, position, updatedAt) => ({
    id, queueId: "q1", queuePosition: position, updatedAt,
    title: TITLES[id] ?? id, body: TITLES[id] ?? id, status: "backlog", projectId: "p1", parentId: null, archived: false, mode: "single", groupId: null,
    agentType: "claude", executorId: null, model: null, reasoningEffort: null, labels: [], createdAt: "2026-10-08T06:00:00.000Z",
  });
  let queueItems = [{ taskId: "t-prev", title: "前驱任务A" }, { taskId: "t-b", title: "队列成员B" }];
  let holdInsert = false;
  let releaseInsert = null;
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    let data = [];
    if (path === "/api/queues/q1") data = { id: "q1", items: queueItems };
    if (path.endsWith("/commits")) data = { branch: null, commits: [] };
    if (path.endsWith("/diff")) data = { available: false, files: [], sourceBranch: null };
    if (path === "/api/queues/q1/insert" && request.method() === "POST") {
      const body = request.postDataJSON();
      if (holdInsert) await new Promise((resolve) => { releaseInsert = resolve; });
      const tasks = [member("t-prev", 0, holdInsert ? T6 : T1), member(body.taskId, 1, holdInsert ? T6 : T1), member("t-b", 2, holdInsert ? T6 : T1)];
      queueItems = [{ taskId: "t-prev", title: "前驱任务A" }, { taskId: body.taskId, title: body.taskId }, { taskId: "t-b", title: "队列成员B" }];
      data = { ok: true, task: tasks[1], tasks };
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(data) });
  });

  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/scripts/fixtures/inspector-queue.html`);
  const rows = page.getByTestId("rows");
  const pickA = async () => {
    await page.locator(".task-inspector-queue-after .ui-select-trigger").click();
    await page.locator(".ui-dropdown-row", { hasText: "前驱任务A" }).click();
  };

  // 健康路径(真实回调链):K1 接在 A 后,响应即时返回,快照整批生效。
  await page.locator(".task-inspector-queue-after").waitFor();
  await pickA();
  await page.getByText(/已排在「前驱任务A」之后/).waitFor();
  await page.getByText(/第 2 \/ 3 位/).waitFor();
  assert.match(await rows.innerText(), new RegExp(`t-k1:q1:1:${T1}`), "主体按响应快照入队");
  assert.match(await rows.innerText(), new RegExp(`t-prev:q1:0:${T1}`), "前驱快照同步生效");
  assert.equal(await page.getByTestId("refresh-fallbacks").innerText(), "0", "带快照时不走兜底刷新");

  // 竞态:K2 的 insert 响应被扣住;在途期间 SSE 送达更晚的移出、本页删除成员 B。
  await page.getByTestId("pick-k2").click();
  await page.locator(".task-inspector-queue-after").waitFor();
  holdInsert = true;
  await pickA();
  while (!releaseInsert) await new Promise((resolve) => setTimeout(resolve, 50)); // 入队请求已发出并被扣住
  await page.getByTestId("sse-remove-k2").click();
  await page.getByTestId("delete-b").click();
  assert.doesNotMatch(await rows.innerText(), /t-b:/, "删除后 B 行已消失");
  releaseInsert();
  await page.getByText(/已排在「前驱任务A」之后/).nth(1).waitFor();
  // ① 旧响应(T6)不得反转 SSE 已送达的移出(T9):K2 仍是独立任务。
  assert.match(await rows.innerText(), new RegExp(`t-k2:独立:-:${T9}`), "迟到旧响应不得把已移出任务改回排队中");
  await page.locator(".task-inspector-queue-after").waitFor();
  assert.equal(await page.getByText(/第 \d+ \/ \d+ 位/).count(), 0, "Inspector 不得显示旧位次");
  // ② 响应里 B 的旧快照不得复活已删除的行。
  assert.doesNotMatch(await rows.innerText(), /t-b:/, "已删除成员不被旧快照加回列表");
  // 前驱是仍存在的旧成员:更新的快照照常生效。
  assert.match(await rows.innerText(), new RegExp(`t-prev:q1:0:${T6}`), "仍存在的成员按更新快照同步");
  assert.equal(await page.getByTestId("refresh-fallbacks").innerText(), "0");

  assert.deepEqual(errors, []);
  console.log("inspector queue-after late-response regression passed");
} finally {
  await browser?.close();
  await server.close();
}
