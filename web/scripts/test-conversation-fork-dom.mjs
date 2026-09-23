import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { createServer } from "vite";
import { chromeLaunchOptions } from "./chrome-path.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const server = await createServer({ root, logLevel: "error", server: { host: "127.0.0.1", port: 0 } });
const artifacts = await mkdtemp(join(tmpdir(), "ash-conversation-fork-"));
let browser;
try {
  await server.listen();
  const address = server.httpServer.address();
  browser = await chromium.launch(await chromeLaunchOptions());
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const posts = [];
  let rejectCreation = true;
  let failOutput = true;
  let failTrace = false;
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const json = (body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (path === "/api/tasks" && request.method() === "POST") {
      const task = request.postDataJSON();
      posts.push(task);
      if (rejectCreation) return json({ error: "测试创建失败" }, 500);
      return json({ ...task, id: "forked", status: "backlog", parentId: null });
    }
    if (path === "/api/tasks/source/sessions") return json([{ id: "s1", taskId: "source", role: "single", agentType: "codex", startedAt: "2026-09-10T01:00:00Z", endedAt: "2026-09-10T01:01:00Z" }]);
    if (path === "/api/sessions/s1/output") return failOutput ? json({ error: "暂时不可读" }, 503) : route.fulfill({ body: "已恢复的回复" });
    // 历史会话本来就没有 .trace.jsonl，服务端按「缺文件不是故障」回 200 []（见
    // server/src/task-session-routes.ts）。failTrace 模拟的是另一种：文件在却读不动。
    if (path === "/api/sessions/s1/trace") return failTrace ? json({ error: "trace unreadable" }, 500) : json([]);
    if (path === "/api/agents") return json([{ id: "exec-codex", name: "codex@local", type: "codex", isDefault: true }]);
    if (path === "/api/settings") return json({ defaultWorkflowId: null });
    if (path.endsWith("/run")) return json({ ok: true });
    return json([]);
  });
  await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/conversation-fork.html`);
  const forks = page.getByRole("button", { name: "派生新任务", exact: true });
  // 打断的那条、审查那条都确实渲染在页面上（不是因为没画出来才数不到按钮）。
  await page.getByText("刚查到一半就被打断的回复", { exact: true }).waitFor();
  await page.getByText(/第 6 轮结论/).waitFor();
  assert.equal(await forks.count(), 2, "未完成的回复、被引导打断的半截、审查轮的结论都没有派生入口");
  await page.screenshot({ path: join(artifacts, "reply-actions.png") });
  await page.getByRole("button", { name: "普通新建", exact: true }).click();
  const objective = page.locator(".composer-objective textarea");
  await objective.fill("原有草稿，不能混入派生任务");
  await page.getByRole("button", { name: "返回会话", exact: true }).click();
  await forks.first().click();
  assert.equal(await objective.inputValue(), "");
  const submit = page.getByRole("button", { name: "创建并运行", exact: true });
  assert.ok(await submit.isDisabled(), "历史附件不应绕过新要求的输入门禁");
  await page.locator(".composer-fork-context > summary").click();
  assert.match(await page.locator(".composer-fork-context").innerText(), /方案 A/);
  assert.doesNotMatch(await page.locator(".composer-fork-context").innerText(), /方案 C|后续内容/);
  await page.getByText("查看带入的完整对话正文", { exact: true }).click();
  assert.match(await page.locator(".composer-fork-context .task-markdown").innerText(), /研究方案 A 与 B/);
  assert.doesNotMatch(await page.locator(".composer-fork-context .task-markdown").innerText(), /方案 C|后续内容/);
  await objective.fill("沿方案 A 继续，补上验证步骤");
  await page.getByRole("button", { name: "返回会话", exact: true }).click();
  await page.getByRole("button", { name: "回到草稿", exact: true }).click();
  assert.equal(await objective.inputValue(), "沿方案 A 继续，补上验证步骤");
  await submit.click();
  await page.getByTestId("notice").filter({ hasText: "测试创建失败" }).waitFor();
  assert.equal(await objective.inputValue(), "沿方案 A 继续，补上验证步骤");
  assert.equal(posts.length, 1);
  const payload = posts[0];
  assert.equal(payload.originTaskId, "source");
  assert.equal(payload.mode, "single");
  assert.deepEqual(payload.attachments, ["/tmp/earlier.png"]);
  assert.match(payload.body, /研究方案 A 与 B/);
  assert.match(payload.body, /方案 A 实现简单/);
  assert.doesNotMatch(payload.body, /方案 C|后续内容|原有草稿|正在生成的回复/);
  assert.equal(payload.sessionId, undefined);
  assert.equal(payload.parentId, undefined);
  await page.locator(".composer-fork-context > summary").click();
  await page.screenshot({ path: join(artifacts, "fork-composer.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.screenshot({ path: join(artifacts, "fork-mobile.png") });
  rejectCreation = false;
  await submit.click();
  await page.getByTestId("created").waitFor();
  const saved = JSON.parse(await page.getByTestId("created").innerText());
  assert.equal(saved.body, payload.body);
  assert.equal(saved.originTaskId, "source");
  await page.getByRole("button", { name: "普通新建", exact: true }).click();
  assert.equal(await objective.inputValue(), "原有草稿，不能混入派生任务");
  assert.equal(await page.locator(".composer-fork-context").count(), 0);
  await page.getByRole("button", { name: "超长派生", exact: true }).click();
  await objective.fill("继续讨论");
  await page.getByRole("alert").filter({ hasText: "超过 128 KiB 上限" }).waitFor();
  assert.match(await page.locator(".composer-fork-context > summary").innerText(), /KiB/);
  assert.ok(await submit.isDisabled());
  const beforeOversize = posts.length;
  await objective.press("Control+Enter");
  assert.equal(posts.length, beforeOversize, "快捷键也不能提交过大的派生正文");
  await page.getByRole("button", { name: "正文读取失败", exact: true }).click();
  await page.getByText(/正文暂未读全/).waitFor();
  await page.locator(".run-activity").waitFor();
  assert.equal(await forks.count(), 0);
  failOutput = false;
  await page.getByRole("button", { name: "刷新正文", exact: true }).click();
  await page.getByText("已恢复的回复", { exact: true }).waitFor();
  await page.waitForFunction(() => !document.body.innerText.includes("正文暂未读全"));
  // 这一颗是在 trace 回 200 [] 的情况下拿到的：**没有 trace 不等于 trace 坏了**，
  // 半数历史会话本来就没这个文件，不该因此关掉整页的派生入口（第 3 轮审查）。
  assert.equal(await forks.count(), 1, "历史会话没有 trace 是常态，派生入口照旧");

  // trace 真读不动是另一回事：派生快照拼不全，入口该关 —— 但关掉必须说出来，
  // 而不是让按钮凭空消失（那句话原先只落在子智能体面板里）。
  failTrace = true;
  await page.getByRole("button", { name: "刷新正文", exact: true }).click();
  await page.getByText(/执行过程读取失败/).waitFor();
  await page.getByText(/派生功能暂不可用/).waitFor();
  assert.equal(await forks.count(), 0, "trace 读不动时派生入口关掉");
  failTrace = false;
  await page.getByRole("button", { name: "刷新正文", exact: true }).click();
  // 等这一轮读完再数：提示在 refetch 一开始就清掉了，那会儿正文还没落地、按钮也还没画。
  await page.waitForFunction(
    () => [...document.querySelectorAll("button")].filter((b) => b.textContent?.trim() === "派生新任务").length === 1,
  );
  assert.ok(!(await page.evaluate(() => document.body.innerText.includes("执行过程读取失败"))), "提示跟着消失");
  assert.deepEqual(errors, []);
  console.log(`conversation fork UI, creation failure/retry, draft isolation, narrow screen: passed (${artifacts})`);
} finally {
  await browser?.close();
  await server.close();
}
