import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { chromeLaunchOptions } from "./chrome-path.mjs";

const root = await mkdtemp(join(tmpdir(), "ash-cli-ui-"));
const workspace = join(root, "workspace");
const screenshots = process.env.ASH_CLI_SCREENSHOTS || join(root, "screenshots");
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
delete process.env.ASH_ALLOW_REAL_AGENT;
const { db, dbClient, ensureSchema } = await import("../../server/dist/db/index.js");
const { appSettings, projects, tasks, agents, sessions } = await import("../../server/dist/db/schema.js");
await ensureSchema();
await mkdir(workspace);
await mkdir(screenshots, { recursive: true });
const at = new Date().toISOString();
await db.insert(appSettings).values({ key: "instanceMode", value: JSON.stringify("single") });
await db.insert(projects).values({ id: "cli-ui", name: "原生命令验证", repoPath: workspace, useWorktreeDefault: false, createdAt: at });
await db.insert(agents).values([{ id: "codex-ui", name: "codex@验证", type: "codex", isDefault: true, extraArgs: "[]", configOverrides: "{}" }, { id: "claude-ui", name: "claude@验证", type: "claude", isDefault: true, extraArgs: "[]", configOverrides: "{}" }]);
await db.insert(tasks).values([
  { id: "codex-ui-task", projectId: "cli-ui", title: "Codex 命令", body: "测试夹具", mode: "single", status: "done", agentType: "codex", executorId: "codex-ui", autoTitle: false, createdAt: at, updatedAt: at },
  { id: "claude-ui-task", projectId: "cli-ui", title: "Claude 目标快照", body: "测试夹具", mode: "single", status: "done", agentType: "claude", executorId: "claude-ui", autoTitle: false, stage: "accepted", cliState: JSON.stringify({ claude: { profileId: "claude-ui", ownerUserId: null, goal: { objective: "验证目标命令", status: "paused" } } }), createdAt: at, updatedAt: at },
  { id: "team-ui-task", projectId: "cli-ui", title: "团队菜单", body: "测试夹具", mode: "team", status: "idle", agentType: "codex", executorId: "codex-ui", autoTitle: false, createdAt: at, updatedAt: at },
  { id: "edited-cli-task", projectId: "cli-ui", title: "编辑后起跑失败", body: "普通正文", mode: "single", status: "backlog", agentType: "codex", executorId: "codex-ui", createdAt: at, updatedAt: at },
  { id: "legacy-cli-task", projectId: "cli-ui", title: "Codex 老任务起跑失败", body: "/usage 看一下这个月的用量再决定", mode: "single", status: "backlog", agentType: "codex", executorId: "codex-ui", createdAt: at, updatedAt: at },
  { id: "legacy-claude-task", projectId: "cli-ui", title: "Claude 老任务起跑失败", body: "/plan 怎么做这个功能", mode: "single", status: "backlog", agentType: "claude", executorId: "claude-ui", createdAt: at, updatedAt: at },
]);
await db.insert(sessions).values({ id: "claude-ui-session", taskId: "claude-ui-task", role: "single", agentType: "claude", executor: "claude", executorId: "claude-ui", cwd: workspace, startedAt: at, endedAt: at, exitStatus: 0 });
dbClient.close();
const listener = createServer();
listener.listen(0, "127.0.0.1");
await once(listener, "listening");
const port = listener.address().port;
await new Promise((resolve) => listener.close(resolve));
const repo = fileURLToPath(new URL("../..", import.meta.url));
const backend = spawn(process.execPath, [join(repo, "server/dist/index.js")], { cwd: repo, env: { ...process.env, ASH_UPLOADS_DIR: join(root, "uploads"), ASH_PREVIEW: "1", ASH_SEED_FROM: "", PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
let log = "";
backend.stdout.on("data", (chunk) => { log += chunk; });
backend.stderr.on("data", (chunk) => { log += chunk; });
const base = `http://127.0.0.1:${port}`;
let browser;
try {
  const deadline = Date.now() + 10_000;
  while (true) {
    try { if ((await fetch(`${base}/api/projects`)).ok) break; } catch {}
    assert.ok(Date.now() < deadline && backend.exitCode === null, log);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  browser = await chromium.launch({ ...await chromeLaunchOptions(), headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(`${base}/?project=cli-ui&task=claude-ui-task`);
  const claudeReply = page.getByRole("textbox", { name: "回复任务" });
  await claudeReply.fill("/go");
  await page.getByRole("option", { name: /^\/goal\b/ }).waitFor();
  assert.match(await page.getByRole("listbox").innerText(), /原生命令/);
  assert.equal(await page.getByRole("button", { name: /^目标$/ }).count(), 0);
  await page.screenshot({ path: join(screenshots, "claude-goal-slash.png"), fullPage: true });
  await claudeReply.fill("/fa");
  assert.equal(await page.getByRole("option", { name: /^\/fast\b/ }).count(), 0);
  await claudeReply.fill("/goal ");
  const response = page.waitForResponse((value) => value.url().endsWith("/tasks/claude-ui-task/reply") && value.request().method() === "POST");
  await page.getByRole("button", { name: "发送回复", exact: true }).click();
  assert.equal((await (await response).json()).command, true);
  await page.getByText(/这是 ash 保存的目标快照/).first().waitFor();
  assert.equal(await page.locator(".task-message--user").count(), 0);
  const unchanged = await (await fetch(`${base}/api/tasks/claude-ui-task`)).json();
  assert.equal(unchanged.status, "done");
  assert.equal(unchanged.stage, "accepted");
  await page.reload();
  await page.getByText(/这是 ash 保存的目标快照/).first().waitFor();
  await page.screenshot({ path: join(screenshots, "claude-goal-status.png"), fullPage: true });

  await page.goto(`${base}/?project=cli-ui&task=codex-ui-task`);
  const codexReply = page.getByRole("textbox", { name: "回复任务" });
  await codexReply.fill("/go");
  await page.getByRole("option", { name: /^\/goal\b/ }).waitFor();
  await page.screenshot({ path: join(screenshots, "codex-goal-slash.png"), fullPage: true });
  for (const name of ["plan", "compact", "review", "plugins", "fast", "personality", "fork"]) {
    await codexReply.fill(`/${name}`);
    await page.getByRole("option", { name: new RegExp(`^/${name}(?:\\s|$)`) }).waitFor();
  }

  await page.goto(`${base}/?project=cli-ui&task=team-ui-task`);
  const teamReply = page.getByPlaceholder("调度者待命中，说句话就接回同一会话…");
  await teamReply.fill("/");
  await page.getByRole("listbox").waitFor();
  for (const name of ["goal", "plan", "compact", "fast", "plugins"]) assert.equal(await page.getByRole("option", { name: new RegExp(`^/${name}\\b`) }).count(), 0);
  await page.getByRole("button", { name: "新建任务", exact: true }).click();
  const objective = page.getByRole("textbox", { name: "任务目标" });
  await objective.fill("/go");
  await page.getByRole("option", { name: /^\/goal\b/ }).waitFor();
  await page.getByRole("tab", { name: "团队", exact: true }).click();
  await objective.fill("/");
  await page.getByRole("listbox").waitFor();
  assert.equal(await page.getByRole("option", { name: /^\/goal\b/ }).count(), 0);
  await page.getByRole("tab", { name: "单任务", exact: true }).click();
  const agentPicker = page.getByRole("button", { name: /^智能体：/ });
  await agentPicker.click();
  await page.getByRole("option", { name: /@claude/ }).click();
  await page.keyboard.press("Escape");
  assert.match(await agentPicker.getAttribute("aria-label"), /智能体：claude/);
  await objective.fill("/plan 怎么做这个功能");
  const beforeCreation = await (await fetch(`${base}/api/tasks`)).json();
  const invalidCreation = page.waitForResponse((response) => response.url().endsWith("/api/tasks") && response.request().method() === "POST");
  await page.getByRole("button", { name: "创建并运行", exact: true }).click();
  const rejected = await invalidCreation;
  assert.equal(rejected.status(), 400);
  assert.match((await rejected.json()).error, /ash 通道不支持 \/plan/);
  await page.getByText("当前执行器的 ash 通道不支持 /plan", { exact: true }).waitFor();
  await page.locator(".workspace-toast.is-visible").filter({ hasText: "当前执行器的 ash 通道不支持 /plan" }).waitFor();
  assert.equal(await objective.inputValue(), "/plan 怎么做这个功能");
  assert.equal((await (await fetch(`${base}/api/tasks`)).json()).length, beforeCreation.length);
  await page.screenshot({ path: join(screenshots, "cli-creation-validation.png"), fullPage: true, animations: "disabled" });

  const edited = await fetch(`${base}/api/tasks/edited-cli-task`, {
    method: "PATCH", headers: { "content-type": "application/json" },
    body: JSON.stringify({ body: "/status 看一下当前进度再决定下一步" }),
  });
  assert.equal(edited.status, 200);
  for (const [taskId, reason] of [
    ["edited-cli-task", /这一轮没能起跑：\/status 不接受参数/],
    ["legacy-cli-task", /这一轮没能起跑：\/usage 不接受参数/],
    ["legacy-claude-task", /这一轮没能起跑：当前执行器的 ash 通道不支持 \/plan/],
  ]) {
    await page.goto(`${base}/?project=cli-ui&task=${taskId}`);
    const runResponse = page.waitForResponse((response) => response.url().endsWith(`/tasks/${taskId}/run`) && response.request().method() === "POST");
    await page.getByRole("button", { name: "运行", exact: true }).click();
    assert.equal((await runResponse).status(), 202);
    await page.getByText(reason).first().waitFor();
    assert.equal(await page.getByText(/执行输出会实时显示在这里/).count(), 0);
    await page.screenshot({ path: join(screenshots, `${taskId}-failure-live.png`), fullPage: true });
    await page.reload();
    await page.getByText(reason).first().waitFor();
    await page.screenshot({ path: join(screenshots, `${taskId}-failure-reloaded.png`), fullPage: true });
    const recorded = await (await fetch(`${base}/api/tasks/${taskId}/sessions`)).json();
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].cliSessionId, null);
    assert.equal(recorded[0].exitStatus, 1);
  }
  assert.deepEqual(pageErrors, []);
  console.log("native slash UI, agent/mode filtering, inline goal status without optimistic bubbles, durable reload: passed");
  console.log("creation validation reason, edited/legacy startup diagnostics, live display and durable reload: passed");
  console.log(`screenshots: ${screenshots}`);
} finally {
  await browser?.close();
  if (backend.exitCode === null) {
    const closed = once(backend, "close");
    backend.kill("SIGTERM");
    const force = setTimeout(() => backend.kill("SIGKILL"), 5000);
    await closed;
    clearTimeout(force);
  }
  await rm(root, { recursive: true, force: true });
}
