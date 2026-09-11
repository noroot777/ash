import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";
import { chromeLaunchOptions } from "./chrome-path.mjs";

const server = await createServer({ root: fileURLToPath(new URL("..", import.meta.url)), logLevel: "error", server: { host: "127.0.0.1", port: 0 } });
let browser;
const failures = [];
const pending = [];
const record = (id) => ({ id, question: `${id}的问题`, answer: `${id}的答案`, reply: `【答复】\n${id}的答案`, answeredAt: `2026-09-10T02:00:00Z` });
try {
  await server.listen();
  browser = await chromium.launch(await chromeLaunchOptions());
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  const open = async (query, { autoOpen = true, respond = async () => ({ json: [] }) } = {}) => {
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    page.on("pageerror", (error) => failures.push(error.message));
    const calls = [];
    await page.addInitScript(({ autoOpen }) => {
      window.__sources = [];
      window.EventSource = class {
        constructor(url) {
          this.url = url;
          this.closed = false;
          window.__sources.push(this);
          if (autoOpen) setTimeout(() => { if (!this.closed) this.onopen?.({}); }, 0);
        }
        close() { this.closed = true; }
      };
    }, { autoOpen });
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      calls.push(path);
      if (!path.endsWith("/question-history")) {
        failures.push(`unexpected API request: ${path}`);
        await route.fulfill({ status: 500, json: { error: "unexpected request" } });
        return;
      }
      await route.fulfill(await respond(path, calls.length));
    });
    await page.goto(`${origin}/scripts/fixtures/question-history.html?${query}`);
    await page.getByRole("button", { name: "挂载切换" }).waitFor();
    return { page, calls };
  };
  const sse = (page, type, event) => page.evaluate(({ type, event }) => {
    for (const source of window.__sources.filter((item) => !item.closed)) {
      if (type === "message") source.onmessage?.({ data: JSON.stringify(event) });
      else source[type === "open" ? "onopen" : "onerror"]?.({});
    }
  }, { type, event });
  const answer = (page, receipt, taskId = "history-a") => sse(page, "message", {
    type: "task.question", taskId, question: null, questionOptions: null, questionItems: null,
    updatedAt: receipt.answeredAt, answeredQuestion: receipt,
  });
  const count = async (page, expected) => {
    await page.waitForFunction((value) => document.querySelectorAll(".task-question-record").length === value, expected);
  };
  const waitForCalls = async ({ page, calls }, expected) => {
    const deadline = Date.now() + 5000;
    while (calls.length < expected && Date.now() < deadline) await page.waitForTimeout(20);
    assert.equal(calls.length, expected);
  };

  for (const mode of ["feed", "team"]) for (const supplied of ["seed", "empty"]) {
    let saved = [];
    const { page, calls } = await open(`mode=${mode}&history=${supplied}&warm=1`, { respond: async () => ({ json: saved }) });
    await sse(page, "open");
    await page.getByRole("button", { name: "挂载切换" }).click();
    await count(page, supplied === "seed" ? 1 : 0);
    await page.waitForTimeout(1100);
    assert.deepEqual(calls, ["/api/tasks/history-a/question-history"], "已有快照也只读一次轻量历史，补齐可能过期的记录");
    const receipt = { ...record("live"), questionOptions: ["live的答案", "其他选项"], answers: ["live的答案"] };
    saved = [receipt];
    await answer(page, receipt);
    await answer(page, receipt);
    await count(page, supplied === "seed" ? 2 : 1);
    await page.getByRole("button", { name: "提供快照" }).click();
    await count(page, 2);
    assert.match(await page.locator("main").textContent(), /live的问题/);
    await page.getByRole("button", { name: "挂载切换" }).click();
    await count(page, 0);
    await page.getByRole("button", { name: "挂载切换" }).click();
    await count(page, 2);
    assert.equal(calls.length, 2, "重挂载后补齐旧快照遗漏的最新答复");
    await page.locator(".task-question-record").filter({ hasText: "live的问题" }).locator("summary").click();
    assert.equal(await page.getByText("live的问题", { exact: true }).isVisible(), true);
    assert.equal(await page.getByText("其他选项", { exact: true }).isVisible(), true, "回看仍有当时的完整选项");
    await page.close();
  }

  const first = await open("warm=1", { respond: async () => ({ json: [record("loaded")] }) });
  await sse(first.page, "open");
  await first.page.getByRole("button", { name: "挂载切换" }).click();
  await count(first.page, 1);
  await first.page.waitForTimeout(1100);
  assert.deepEqual(first.calls, ["/api/tasks/history-a/question-history"], "已连接后挂载也只读取一次轻量历史");
  await first.page.locator(".task-question-record summary").click();
  assert.equal(await first.page.getByText("loaded的问题", { exact: true }).isVisible(), true);
  await first.page.close();

  let release;
  let secondResponse = new Promise((resolve) => { release = resolve; });
  pending.push(() => release({ json: [] }));
  const reconnect = await open("", { respond: async (_path, n) => n === 1 ? { json: [record("old")] } : secondResponse });
  await count(reconnect.page, 1);
  await reconnect.page.waitForTimeout(1100);
  assert.equal(reconnect.calls.length, 1, "挂载和初次 SSE 连接合成一次请求");
  await sse(reconnect.page, "error");
  await sse(reconnect.page, "open");
  await waitForCalls(reconnect, 2);
  await answer(reconnect.page, record("fresh"));
  release({ json: [record("old"), record("missed")] });
  await count(reconnect.page, 3);
  assert.equal(reconnect.calls.length, 2, "重连拉一次历史，补齐断线期间的答复");
  assert.match(await reconnect.page.locator("main").textContent(), /fresh的问题/);
  await reconnect.page.close();

  const fallback = await open("", { autoOpen: false, respond: async () => ({ json: [record("offline")] }) });
  await count(fallback.page, 1);
  assert.equal(fallback.calls.length, 1, "事件流不可用时仍能读取历史");
  await fallback.page.close();

  const retry = await open("", { respond: async (_path, n) => n === 1 ? { status: 503, json: { error: "暂时不可用" } } : { json: [record("retried")] } });
  await retry.page.getByText("问答记录加载失败").waitFor();
  await retry.page.getByRole("button", { name: "重试", exact: true }).click();
  await count(retry.page, 1);
  assert.equal(await retry.page.getByText("问答记录加载失败").count(), 0);
  assert.equal(retry.calls.length, 2);
  await retry.page.close();

  for (const eventType of ["task.question", "task.updated"]) {
    const recovered = await open("", { respond: async () => ({ status: 503, json: { error: "暂时不可用" } }) });
    await recovered.page.getByText("问答记录加载失败").waitFor();
    await answer(recovered.page, record("other"), "another-task");
    assert.equal(await recovered.page.getByText("问答记录加载失败").count(), 1, "其他任务的事件不清除当前错误");
    if (eventType === "task.question") await answer(recovered.page, record("recovered"));
    else await sse(recovered.page, "message", { type: "task.updated", task: { id: "history-a", questionHistory: [record("recovered")] } });
    await count(recovered.page, 1);
    assert.equal(await recovered.page.getByText("问答记录加载失败").count(), 0, "实时记录恢复后清除过期的失败提示");
    assert.equal(recovered.calls.length, 1);
    await recovered.page.close();
  }

  let releaseOld;
  const old = new Promise((resolve) => { releaseOld = resolve; });
  pending.push(() => releaseOld({ json: [] }));
  const switched = await open("", { respond: async (path) => path.includes("history-a/") ? old : { json: [record("task-b")] } });
  await waitForCalls(switched, 1);
  await switched.page.getByRole("button", { name: "切换任务" }).click();
  await count(switched.page, 1);
  releaseOld({ json: [record("task-a")] });
  await answer(switched.page, record("wrong-task"));
  await switched.page.waitForTimeout(100);
  assert.equal(await switched.page.locator(".task-question-record").count(), 1);
  assert.match(await switched.page.locator("main").textContent(), /task-b的问题/);
  assert.doesNotMatch(await switched.page.locator("main").textContent(), /task-a的问题|wrong-task/);
  await switched.page.close();

  const snapshot = await open("mode=snapshot&history=seed");
  await count(snapshot.page, 1);
  assert.equal(await snapshot.page.evaluate(() => window.__sources.length), 0, "远端快照不订阅本地事件");
  assert.equal(snapshot.calls.length, 0);
  await snapshot.page.close();

  const form = await browser.newPage();
  await form.goto(`${origin}/scripts/fixtures/question-card.html`);
  await form.getByRole("button", { name: "留在会话里，点击展开", exact: true }).click();
  assert.match(await form.locator(".task-question-card footer").innerText(), /已答 1\/2 项 · 留空项会标记为未答/);
  assert.doesNotMatch(await form.locator("main").innerText(), /可稍后补充/);
  await form.close();
  assert.deepEqual(failures, []);
  console.log("question history DOM: seeded history, remount recovery, live receipts, single initial load, reconnect, stale responses, switching, retry/SSE recovery, snapshot and truthful copy passed");
} finally {
  pending.forEach((release) => release());
  await browser?.close();
  await server.close();
}
