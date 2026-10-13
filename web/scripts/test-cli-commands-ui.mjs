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
const { appSettings, projects, tasks, agents, sessions, groups, queueItems } = await import("../../server/dist/db/schema.js");
await ensureSchema();
await mkdir(workspace);
await mkdir(screenshots, { recursive: true });
const at = new Date().toISOString();
await db.insert(appSettings).values({ key: "instanceMode", value: JSON.stringify("single") });
await db.insert(projects).values({ id: "cli-ui", name: "原生命令验证", repoPath: workspace, useWorktreeDefault: false, createdAt: at });
await db.insert(agents).values([{ id: "codex-ui", name: "codex@验证", type: "codex", isDefault: true, extraArgs: "[]", configOverrides: "{}" }, { id: "claude-ui", name: "claude@验证", type: "claude", isDefault: true, extraArgs: "[]", configOverrides: "{}" }]);
await db.insert(agents).values({ id: "codex-ui-other", name: "codex@验证备用", type: "codex", extraArgs: "[]", configOverrides: "{}" });
await db.insert(groups).values([{ id: "queue-ui", projectId: "cli-ui", name: "计划队列验证", mode: "serial", createdAt: at }, { id: "goal-ui", projectId: "cli-ui", name: "目标保护验证", mode: "parallel", createdAt: at }]);
await db.insert(tasks).values([
  { id: "codex-ui-task", projectId: "cli-ui", title: "Codex 命令", body: "测试夹具", mode: "single", status: "paused", agentType: "codex", executorId: "codex-ui", autoTitle: false, createdAt: at, updatedAt: at },
  { id: "claude-ui-task", projectId: "cli-ui", title: "Claude 目标快照", body: "测试夹具", mode: "single", status: "done", agentType: "claude", executorId: "claude-ui", autoTitle: false, stage: "accepted", cliState: JSON.stringify({ claude: { profileId: "claude-ui", ownerUserId: null, goal: { objective: "验证目标命令", status: "paused" } } }), createdAt: at, updatedAt: at },
  { id: "team-ui-task", projectId: "cli-ui", title: "团队菜单", body: "测试夹具", mode: "team", status: "idle", agentType: "codex", executorId: "codex-ui", autoTitle: false, createdAt: at, updatedAt: at },
  { id: "edited-cli-task", projectId: "cli-ui", title: "编辑后起跑失败", body: "普通正文", mode: "single", status: "backlog", agentType: "codex", executorId: "codex-ui", createdAt: at, updatedAt: at },
  { id: "legacy-cli-task", projectId: "cli-ui", title: "Codex 老任务起跑失败", body: "/usage 看一下这个月的用量再决定", mode: "single", status: "backlog", agentType: "codex", executorId: "codex-ui", createdAt: at, updatedAt: at },
  { id: "legacy-claude-task", projectId: "cli-ui", title: "Claude 老任务起跑失败", body: "/plan 怎么做这个功能", mode: "single", status: "backlog", agentType: "claude", executorId: "claude-ui", createdAt: at, updatedAt: at },
  { id: "fresh-plan-task", projectId: "cli-ui", title: "计划模式重新运行", body: "开始实施测试夹具", mode: "single", status: "backlog", agentType: "codex", executorId: "codex-ui", cliState: JSON.stringify({ codex: { profileId: "codex-ui", ownerUserId: null, plan: true } }), createdAt: at, updatedAt: at },
  { id: "queue-plan-task", projectId: "cli-ui", groupId: "queue-ui", title: "计划模式队列起跑", body: "开始实施队列任务", mode: "single", status: "backlog", agentType: "codex", executorId: "codex-ui", cliState: JSON.stringify({ codex: { profileId: "codex-ui", ownerUserId: null, plan: true } }), autoTitle: false, createdAt: at, updatedAt: at },
  { id: "scoped-goal-task", projectId: "cli-ui", groupId: "goal-ui", title: "切换执行器保留目标", body: "保持目标与预算", mode: "single", status: "paused", agentType: "codex", executorId: "codex-ui", cliState: JSON.stringify({ codex: { profileId: "codex-ui", ownerUserId: null, goalHold: true, goal: { objective: "让 test/auth 全过", status: "budgetLimited", tokenBudget: 150, tokensUsed: 150 } } }), autoTitle: false, createdAt: at, updatedAt: at },
]);
await db.insert(queueItems).values({ taskId: "queue-plan-task", queueId: "queue-ui", position: 0, createdAt: at });
await db.insert(sessions).values({ id: "queue-plan-session", taskId: "queue-plan-task", role: "single", agentType: "codex", executor: "codex", executorId: "codex-ui", cliSessionId: "queue-thread", cwd: workspace, startedAt: at, endedAt: at, exitStatus: 0 });
await db.insert(sessions).values({ id: "claude-ui-session", taskId: "claude-ui-task", role: "single", agentType: "claude", executor: "claude", executorId: "claude-ui", cwd: workspace, startedAt: at, endedAt: at, exitStatus: 0 });
await db.insert(sessions).values({ id: "codex-ui-session", taskId: "codex-ui-task", role: "single", agentType: "codex", executor: "codex", executorId: "codex-ui", cliSessionId: "ui-plan-thread", cwd: workspace, startedAt: at, endedAt: at, exitStatus: 0 });
dbClient.close();
const listener = createServer();
listener.listen(0, "127.0.0.1");
await once(listener, "listening");
const port = listener.address().port;
await new Promise((resolve) => listener.close(resolve));
const repo = fileURLToPath(new URL("../..", import.meta.url));
const boot = `
  const { CodexExecutor } = await import("./server/dist/executors/codex.js");
  CodexExecutor.prototype.runSteerable = function(options) {
    const sessionId = options.sessionId || "ui-" + options.env.ASH_TASK_ID;
    const goal = options.cliState?.goal ? { ...options.cliState.goal, status: "budgetLimited" } : null;
    return {
      sessionId, cliCommand: options.cliCommand, commandLine: "UI fixture; no CLI or model request",
      goal: () => goal, goalStarted: () => !!goal,
      kill() {},
      events: (async function* () {
        yield { kind: "session", cliSessionId: sessionId };
        yield { kind: "text", text: options.cliCommand?.name === "goal" && goal ? "目标：" + goal.objective + "；预算 " + goal.tokenBudget + "；已用 " + goal.tokensUsed : options.cliState?.plan ? "测试执行器：只讨论计划" : "测试执行器：正常实施" };
        yield { kind: "done", exitStatus: 0 };
      })(),
    };
  };
  await import("./server/dist/index.js");
`;
const backend = spawn(process.execPath, ["--input-type=module", "-e", boot], { cwd: repo, env: { ...process.env, ASH_UPLOADS_DIR: join(root, "uploads"), ASH_PREVIEW: "1", ASH_SEED_FROM: "", PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
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
  const sessionEnds = async (taskId) => new Map((await (await fetch(`${base}/api/tasks/${taskId}/sessions`)).json()).map((session) => [session.id, session.endedAt]));
  const idleTask = async (taskId, previousEnds) => {
    const deadline = Date.now() + 10_000;
    while (true) {
      const task = await (await fetch(`${base}/api/tasks/${taskId}`)).json();
      const recorded = await (await fetch(`${base}/api/tasks/${taskId}/sessions`)).json();
      const completed = recorded.some((session) => session.endedAt && session.endedAt !== previousEnds.get(session.id));
      if (completed && !["running", "queued"].includes(task.status)) return task;
      assert.ok(Date.now() < deadline, `task remained busy: ${taskId}\n${log}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  const sendCodex = async (text) => {
    const previousEnds = await sessionEnds("codex-ui-task");
    await codexReply.fill(`${text} `);
    const replied = page.waitForResponse((value) => value.url().endsWith("/tasks/codex-ui-task/reply") && value.request().method() === "POST");
    await page.getByRole("button", { name: "发送回复", exact: true }).click();
    assert.equal((await replied).status(), 202);
    return idleTask("codex-ui-task", previousEnds);
  };
  const planNotice = page.getByRole("status", { name: "Codex 计划模式" });
  assert.equal((await sendCodex("/plan")).codexPlanMode, true);
  await planNotice.waitFor();
  await page.getByText("测试执行器：只讨论计划", { exact: true }).first().waitFor();
  assert.match(await planNotice.innerText(), /\/plan off/);
  await page.screenshot({ path: join(screenshots, "plan-mode-live.png"), fullPage: true });
  await page.reload();
  await planNotice.waitFor();
  await page.getByText("测试执行器：只讨论计划", { exact: true }).first().waitFor();
  await page.screenshot({ path: join(screenshots, "plan-mode-reloaded.png"), fullPage: true });
  assert.equal((await sendCodex("继续拆解方案")).codexPlanMode, true);
  await page.getByText("测试执行器：只讨论计划", { exact: true }).first().waitFor();
  assert.equal((await sendCodex("/plan off")).codexPlanMode, false);
  await planNotice.waitFor({ state: "hidden" });
  await page.reload();
  await page.getByRole("textbox", { name: "回复任务" }).waitFor();
  assert.equal(await planNotice.count(), 0);
  await page.getByText("测试执行器：正常实施", { exact: true }).first().waitFor();
  await page.screenshot({ path: join(screenshots, "plan-mode-off.png"), fullPage: true });
  await sendCodex("/plan");
  await planNotice.waitFor();
  const previousRunEnds = await sessionEnds("codex-ui-task");
  assert.equal((await fetch(`${base}/api/tasks/codex-ui-task/run`, { method: "POST" })).status, 202);
  assert.equal((await idleTask("codex-ui-task", previousRunEnds)).codexPlanMode, false);
  await planNotice.waitFor({ state: "hidden" });
  await page.goto(`${base}/?project=cli-ui&task=fresh-plan-task`);
  await planNotice.waitFor();
  const previousFreshEnds = await sessionEnds("fresh-plan-task");
  const restarted = page.waitForResponse((value) => value.url().endsWith("/tasks/fresh-plan-task/run") && value.request().method() === "POST");
  await page.getByRole("button", { name: "运行", exact: true }).click();
  assert.equal((await restarted).status(), 202);
  assert.equal((await idleTask("fresh-plan-task", previousFreshEnds)).codexPlanMode, false);
  await planNotice.waitFor({ state: "hidden" });
  await page.getByText("测试执行器：正常实施", { exact: true }).waitFor();
  await page.reload();
  await page.getByText("测试执行器：正常实施", { exact: true }).waitFor();
  assert.equal(await planNotice.count(), 0);
  await page.screenshot({ path: join(screenshots, "plan-mode-fresh-run.png"), fullPage: true });

  await page.goto(`${base}/?project=cli-ui&task=queue-plan-task`);
  await planNotice.waitFor();
  const beforeQueue = await sessionEnds("queue-plan-task");
  assert.equal((await fetch(`${base}/api/groups/queue-ui/run`, { method: "POST" })).status, 202);
  const queuedTask = await idleTask("queue-plan-task", beforeQueue);
  assert.equal(queuedTask.codexPlanMode, false);
  assert.equal(queuedTask.status, "failed", "队列中的未确认执行不能冒充完成");
  await planNotice.waitFor({ state: "hidden" });
  await page.getByText("测试执行器：正常实施", { exact: true }).waitFor();
  await page.reload();
  await page.getByText("测试执行器：正常实施", { exact: true }).waitFor();
  assert.equal(await planNotice.count(), 0);
  await page.screenshot({ path: join(screenshots, "queue-execution-not-plan-done.png"), fullPage: true });

  await page.goto(`${base}/?project=cli-ui&task=scoped-goal-task`);
  const scopedReply = page.getByRole("textbox", { name: "回复任务" });
  const sendScoped = async (text) => {
    const previousEnds = await sessionEnds("scoped-goal-task");
    await scopedReply.fill(`${text} `);
    const response = page.waitForResponse((value) => value.url().endsWith("/tasks/scoped-goal-task/reply") && value.request().method() === "POST");
    await page.getByRole("button", { name: "发送回复", exact: true }).click();
    assert.equal((await response).status(), 202);
    return idleTask("scoped-goal-task", previousEnds);
  };
  const beforeOtherProfile = await sessionEnds("scoped-goal-task");
  const switched = await fetch(`${base}/api/tasks/scoped-goal-task/reply`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "换个执行器回复", agent: "codex", executorId: "codex-ui-other" }),
  });
  assert.equal(switched.status, 202);
  await idleTask("scoped-goal-task", beforeOtherProfile);
  const otherProfileSessions = await (await fetch(`${base}/api/tasks/scoped-goal-task/sessions`)).json();
  assert.ok(otherProfileSessions.some((session) => session.executorId === "codex-ui-other"));
  await page.getByText("测试执行器：正常实施", { exact: true }).waitFor();
  assert.equal((await sendScoped("/goal resume")).status, "paused");
  await page.getByText("目标：让 test/auth 全过；预算 150；已用 150", { exact: true }).waitFor();
  await page.reload();
  await page.getByText("目标：让 test/auth 全过；预算 150；已用 150", { exact: true }).waitFor();
  const beforeHeldRun = [...await sessionEnds("scoped-goal-task")];
  assert.equal((await fetch(`${base}/api/groups/goal-ui/run`, { method: "POST" })).status, 202);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual([...await sessionEnds("scoped-goal-task")], beforeHeldRun);
  assert.equal((await (await fetch(`${base}/api/tasks/scoped-goal-task`)).json()).status, "paused");
  await page.screenshot({ path: join(screenshots, "goal-survives-profile-switch.png"), fullPage: true });

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
  console.log("plan mode live/reload notice, slash-only exit, fresh and resumable rerun reset: passed");
  console.log("queued plan executes instead of falsely completing; profile switch/resume preserves budget and scheduler hold: passed");
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
