import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { chromeLaunchOptions } from "../../web/scripts/chrome-path.mjs";

const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const root = await mkdtemp(join(tmpdir(), "ash-mobile-command-ui-"));
const shots = process.env.ASH_MOBILE_SCREENSHOTS ?? join(root, "shots");
await mkdir(shots, { recursive: true });
const at = new Date().toISOString();
const tasks = ["empty", "recorded", "other"].map((id) => ({
  id, projectId: "mobile-ui", title: `手机命令 ${id}`, body: "手机命令结果回归", mode: "single", status: id === "recorded" ? "done" : "backlog",
  agentType: "codex", parentId: null, groupId: null, executorId: null, model: null, reasoningEffort: null, archived: false,
  workflowMode: "free", stage: "none", labels: [], createdAt: at, updatedAt: at, endedAt: null, question: null, resumePrompt: null,
}));
let replies = 0;
let emptySessionReads = 0;
let transcript = "已保存的历史对话";
const session = { id: "recorded-session", taskId: "recorded", role: "single", agentType: "codex", executor: "codex", startedAt: at, endedAt: at, exitStatus: 0 };
const json = (response, value) => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".ttf": "font/ttf", ".png": "image/png", ".ico": "image/x-icon" };
const server = createServer(async (request, response) => {
  try {
    const path = new URL(request.url, "http://localhost").pathname;
    if (path.startsWith("/api/")) {
      if (path === "/api/projects") return json(response, [{ id: "mobile-ui", name: "手机命令测试", repoPath: root, createdAt: at }]);
      if (path === "/api/tasks") return json(response, tasks);
      if (path === "/api/groups") return json(response, []);
      if (path === "/api/skills") return json(response, { skills: [], cliCommands: [] });
      if (path === "/api/agents" || path === "/api/llm-providers" || path === "/api/agents/detect" || path === "/api/agents/models") return json(response, []);
      if (path === "/api/sessions/recorded-session/output") { response.writeHead(200, { "content-type": "text/plain" }); response.end(transcript); return; }
      const match = /^\/api\/tasks\/([^/]+)(?:\/(.*))?$/.exec(path);
      if (match) {
        const task = tasks.find((candidate) => candidate.id === match[1]);
        const action = match[2];
        if (!action) return json(response, task);
        if (action === "sessions") {
          if (task.id === "empty") emptySessionReads++;
          return json(response, task.id === "recorded" ? [session] : []);
        }
        if (action === "review") return json(response, { reviewRequested: false, rounds: [] });
        if (action === "reply") {
          let body = "";
          for await (const chunk of request) body += chunk;
          assert.equal(JSON.parse(body).text.trim(), "/goal --scopes");
          replies++;
          const text = task.id === "recorded" ? "已经落盘的作用域结果" : `没有已保存的目标（查询 ${replies}）。使用 /goal 描述 设置持续目标。`;
          if (task.id === "recorded") transcript = text;
          return json(response, { started: false, command: true, text, recorded: task.id === "recorded" });
        }
        return json(response, []);
      }
      return json(response, {});
    }
    const relative = decodeURIComponent(path.replace(/^\/mobile\/app/, ""));
    if (relative.includes("..")) { response.writeHead(400).end(); return; }
    const asset = join(dist, relative === "/" || !relative ? "index.html" : relative);
    let content;
    let contentType = mime[extname(asset)] ?? "application/octet-stream";
    try { content = await readFile(asset); }
    catch { content = await readFile(join(dist, "index.html")); contentType = "text/html"; }
    response.writeHead(200, { "content-type": contentType });
    response.end(content);
  } catch (error) { response.writeHead(500).end(String(error)); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
let page;
const errors = [];
try {
  browser = await chromium.launch(await chromeLaunchOptions());
  page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  page.on("request", (request) => assert.equal(new URL(request.url()).origin, origin, "the mobile fixture must not contact live services"));
  const open = async (id) => {
    await page.goto(`${origin}/mobile/app/`);
    await page.getByRole("button", { name: `打开任务：手机命令 ${id}`, exact: true }).click();
    await page.getByRole("textbox", { name: "回复这个任务" }).waitFor();
  };
  const send = async (id) => {
    await page.getByRole("textbox", { name: "回复这个任务" }).fill("/goal --scopes ");
    const [reply] = await Promise.all([
      page.waitForResponse((response) => response.url().endsWith(`/tasks/${id}/reply`) && response.request().method() === "POST"),
      page.getByRole("button", { name: "发送回复", exact: true }).click(),
    ]);
    assert.equal(reply.status(), 200);
    return reply.json();
  };
  await open("empty");
  const result = await send("empty");
  const local = page.getByTestId("reply-command-result");
  await local.waitFor();
  assert.match(await local.innerText(), /没有已保存的目标/);
  assert.equal(await page.getByRole("textbox", { name: "回复这个任务" }).inputValue(), "");
  assert.equal(tasks[0].status, "backlog");
  await page.screenshot({ path: join(shots, "mobile-unrecorded-visible.png"), fullPage: true });
  tasks[0].status = "running";
  await send("empty");
  const reads = emptySessionReads;
  await page.getByRole("button", { name: "排队发送", exact: true }).waitFor();
  await assertEventually(() => emptySessionReads >= reads + 2);
  assert.equal(await local.count(), 1);
  assert.match(await local.innerText(), /查询 2/);
  assert.ok(!(await local.innerText()).includes(result.text));
  await page.screenshot({ path: join(shots, "mobile-command-after-poll.png"), fullPage: true });
  tasks[0].status = "backlog";
  await open("recorded");
  await send("recorded");
  await page.getByText("已经落盘的作用域结果", { exact: true }).waitFor();
  assert.equal(await page.getByText("已经落盘的作用域结果", { exact: true }).count(), 1);
  assert.equal(await local.count(), 0, "recorded command results must not also render a local copy");
  await page.screenshot({ path: join(shots, "mobile-recorded-once.png"), fullPage: true });
  await page.reload();
  await page.getByText("已经落盘的作用域结果", { exact: true }).waitFor();
  assert.equal(await local.count(), 0);
  await open("empty");
  let release;
  let received;
  const held = new Promise((resolve) => { release = resolve; });
  const arrival = new Promise((resolve) => { received = resolve; });
  await page.route("**/api/tasks/empty/reply", async (route) => {
    const response = await route.fetch();
    received();
    await held;
    await route.fulfill({ response });
  });
  await page.getByRole("textbox", { name: "回复这个任务" }).fill("/goal --scopes ");
  await page.getByRole("button", { name: "发送回复", exact: true }).click();
  await arrival;
  await page.goBack();
  await page.getByRole("button", { name: "打开任务：手机命令 other", exact: true }).click();
  release();
  await page.waitForResponse((response) => response.url().endsWith("/tasks/empty/reply"));
  assert.equal(await local.count(), 0, "a delayed response must not leak into another task");
  await page.screenshot({ path: join(shots, "mobile-delayed-other-task.png"), fullPage: true });
  assert.deepEqual(errors, []);
  console.log("mobile real UI: unrecorded scope results stay visible through polls; recorded results appear once and survive reload; late results stay task-local: passed");
  console.log(`screenshots: ${shots}`);
} catch (error) {
  if (page) {
    await page.screenshot({ path: join(shots, "mobile-command-failure.png"), fullPage: true }).catch(() => {});
    console.error(await page.locator("body").innerText().catch(() => ""));
    console.error(errors);
  }
  throw error;
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}

async function assertEventually(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail("expected mobile polling did not occur");
}
