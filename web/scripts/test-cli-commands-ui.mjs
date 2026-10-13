import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { chromeLaunchOptions } from "./chrome-path.mjs";
import { goalRecoveryFixtures, goalRecoverySessions, runGoalRecoveryUi } from "./cli-goal-recovery-ui.mjs";

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
  ...goalRecoveryFixtures(at),
  { id: "codex-ui-task", projectId: "cli-ui", title: "Codex 命令", body: "测试夹具", mode: "single", status: "paused", agentType: "codex", executorId: "codex-ui", autoTitle: false, createdAt: at, updatedAt: at },
  { id: "claude-ui-task", projectId: "cli-ui", title: "Claude 目标快照", body: "测试夹具", mode: "single", status: "done", agentType: "claude", executorId: "claude-ui", autoTitle: false, stage: "accepted", cliState: JSON.stringify({ claude: { profileId: "claude-ui", ownerUserId: null, goal: { objective: "验证目标命令", status: "paused" } } }), createdAt: at, updatedAt: at },
  { id: "team-ui-task", projectId: "cli-ui", title: "团队菜单", body: "测试夹具", mode: "team", status: "idle", agentType: "codex", executorId: "codex-ui", autoTitle: false, createdAt: at, updatedAt: at },
  { id: "edited-cli-task", projectId: "cli-ui", title: "编辑后起跑失败", body: "普通正文", mode: "single", status: "backlog", agentType: "codex", executorId: "codex-ui", createdAt: at, updatedAt: at },
  { id: "legacy-cli-task", projectId: "cli-ui", title: "Codex 老任务起跑失败", body: "/usage 看一下这个月的用量再决定", mode: "single", status: "backlog", agentType: "codex", executorId: "codex-ui", createdAt: at, updatedAt: at },
  { id: "legacy-claude-task", projectId: "cli-ui", title: "Claude 老任务起跑失败", body: "/plan 怎么做这个功能", mode: "single", status: "backlog", agentType: "claude", executorId: "claude-ui", createdAt: at, updatedAt: at },
  { id: "ordinary-ui-task", projectId: "cli-ui", title: "普通续聊没有目标提示", body: "回答普通问题，不设置目标", mode: "single", status: "backlog", agentType: "codex", executorId: "codex-ui", autoTitle: false, createdAt: at, updatedAt: at },
  { id: "fresh-plan-task", projectId: "cli-ui", title: "计划模式重新运行", body: "开始实施测试夹具", mode: "single", status: "backlog", agentType: "codex", executorId: "codex-ui", cliState: JSON.stringify({ codex: { profileId: "codex-ui", ownerUserId: null, plan: true } }), createdAt: at, updatedAt: at },
  { id: "fresh-claude-plan-task", projectId: "cli-ui", title: "Claude 首跑清除计划", body: "由 Claude 正常实施", mode: "single", status: "backlog", agentType: "claude", executorId: "claude-ui", autoTitle: false, cliState: JSON.stringify({ codex: { activeScope: encodeURIComponent(JSON.stringify(["codex-ui", null])), scopes: Object.fromEntries(["codex-ui", "codex-ui-other"].map((profileId) => [encodeURIComponent(JSON.stringify([profileId, null])), { profileId, ownerUserId: null, plan: true }])) } }), createdAt: at, updatedAt: at },
  { id: "queue-plan-task", projectId: "cli-ui", groupId: "queue-ui", title: "计划模式队列起跑", body: "开始实施队列任务", mode: "single", status: "backlog", agentType: "codex", executorId: "codex-ui", cliState: JSON.stringify({ codex: { profileId: "codex-ui", ownerUserId: null, plan: true } }), autoTitle: false, createdAt: at, updatedAt: at },
  { id: "scoped-goal-task", projectId: "cli-ui", groupId: "goal-ui", title: "切换执行器保留目标", body: "保持目标与预算", mode: "single", status: "paused", agentType: "codex", executorId: "codex-ui", cliState: JSON.stringify({ codex: { profileId: "codex-ui", ownerUserId: null, goalHold: true, goal: { objective: "让 test/auth 全过", status: "budgetLimited", tokenBudget: 150, tokensUsed: 150 } } }), autoTitle: false, createdAt: at, updatedAt: at },
  ...["codex", "claude"].map((agentType) => ({ id: `live-${agentType}-goal`, projectId: "cli-ui", title: `${agentType} 运行中清除目标`, body: "实时目标控制验证", mode: "single", status: "backlog", agentType, executorId: `${agentType}-ui`, autoTitle: false, createdAt: at, updatedAt: at })),
]);
await db.insert(queueItems).values({ taskId: "queue-plan-task", queueId: "queue-ui", position: 0, createdAt: at });
await db.insert(sessions).values(goalRecoverySessions(at, workspace));
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
const traceFile = join(root, "invocations.jsonl");
const boot = `
  const { appendFileSync } = await import("node:fs");
  const { CodexExecutor } = await import("./server/dist/executors/codex.js");
  const { ClaudeExecutor } = await import("./server/dist/executors/claude.js");
  const { CodexNativeCommands } = await import("./server/dist/executors/codex-native-commands.js");
  function fixture(options) {
    appendFileSync(${JSON.stringify(traceFile)}, JSON.stringify({ taskId: options.env.ASH_TASK_ID, turnToken: options.env.ASH_TURN_TOKEN, cliState: options.cliState, cliCommand: options.cliCommand }) + "\\n");
    const sessionId = (options.cliCommand?.name === "fork" ? "fork-" : "") + (options.sessionId || "ui-" + options.env.ASH_TASK_ID);
    let goal = options.cliState?.goal ? { ...options.cliState.goal, status: "budgetLimited" } : null;
    const goalStarted = !!goal;
    const liveGoal = goal?.objective === "等待实时目标控制";
    if (liveGoal) goal.status = "active";
    let finish;
    const interrupted = new Promise((resolve) => { finish = resolve; });
    const notices = [];
    const native = new CodexNativeCommands({ threadId: () => sessionId, turnId: () => "", model: () => "fixture", cwd: options.cwd, prompt: "", state: options.cliState, push: (event) => notices.push(event), request: async (method, params) => {
      if (method === "thread/goal/clear") goal = null;
      if (method === "thread/goal/set") {
        const changes = { ...params };
        delete changes.threadId;
        goal = { ...goal, ...changes };
      }
      return { goal };
    } });
    return {
      sessionId, cliCommand: options.cliCommand, commandLine: "UI fixture; no CLI or model request",
      goal: liveGoal && options.env.ASH_TASK_ID === "live-claude-goal" ? undefined : () => goal, goalStarted: () => goalStarted,
      command: (command) => native.control(command),
      kill() { finish(); },
      events: (async function* () {
        yield { kind: "session", cliSessionId: sessionId };
        if (options.env.ASH_TASK_ID === "ordinary-ui-task" && options.sessionId) {
          native.notification("thread/goal/cleared", { threadId: sessionId });
        }
        for (const event of notices) yield event;
        let text = options.cliCommand?.name === "goal" && goal ? "目标：" + goal.objective + (goal.tokenBudget ? "；预算 " + goal.tokenBudget : "") + "；已用 " + goal.tokensUsed : options.cliState?.plan ? "测试执行器：只讨论计划" : "测试执行器：正常实施";
        if (options.cliCommand?.name === "fork" || options.cliCommand?.name === "goal" && !goal) {
          text = await native.control(options.cliCommand);
        }
        if (liveGoal) text += "；测试回合 " + options.env.ASH_TURN_TOKEN;
        if (options.env.ASH_TASK_ID === "ordinary-ui-task") text = "普通回合：" + options.env.ASH_TURN_TOKEN;
        yield { kind: "text", text };
        if (liveGoal) await interrupted;
        yield { kind: "done", exitStatus: 0 };
      })(),
    };
  }
  CodexExecutor.prototype.runSteerable = fixture;
  ClaudeExecutor.prototype.runSteerable = fixture;
  for (const Executor of [CodexExecutor, ClaudeExecutor]) {
    const prepareResume = Executor.prototype.prepareResume;
    Executor.prototype.prepareResume = async function(options) {
      await prepareResume?.call(this, options);
      if (/^live-(codex|claude)-goal$/.test(options.env?.ASH_TASK_ID ?? "")) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    };
  }
  await import("./server/dist/index.js");
`;
const backend = spawn(process.execPath, ["--input-type=module", "-e", boot], { cwd: repo, env: { ...process.env, ASH_UPLOADS_DIR: join(root, "uploads"), ASH_PREVIEW: "1", ASH_SEED_FROM: "", PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
let log = "";
backend.stdout.on("data", (chunk) => { log += chunk; });
backend.stderr.on("data", (chunk) => { log += chunk; });
const base = `http://127.0.0.1:${port}`;
let browser;
let page;
try {
  const deadline = Date.now() + 10_000;
  while (true) {
    try { if ((await fetch(`${base}/api/projects`)).ok) break; } catch {}
    assert.ok(Date.now() < deadline && backend.exitCode === null, log);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  browser = await chromium.launch({ ...await chromeLaunchOptions(), headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
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
  const replyAs = async (text, agent, executorId, taskId = "codex-ui-task") => {
    const previousEnds = await sessionEnds(taskId);
    const response = await fetch(`${base}/api/tasks/${taskId}/reply`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, agent, executorId }),
    });
    assert.equal(response.status, 202);
    return idleTask(taskId, previousEnds);
  };
  const lastInvocation = async () => JSON.parse((await readFile(traceFile, "utf8")).trim().split("\n").at(-1));

  await page.goto(`${base}/?project=cli-ui&task=ordinary-ui-task`);
  const ordinaryReply = page.getByRole("textbox", { name: "回复任务" });
  const beforeOrdinaryRun = await sessionEnds("ordinary-ui-task");
  const [ordinaryRun] = await Promise.all([
    page.waitForResponse((value) => value.url().endsWith("/tasks/ordinary-ui-task/run") && value.request().method() === "POST"),
    page.getByRole("button", { name: "运行", exact: true }).click(),
  ]);
  assert.equal(ordinaryRun.status(), 202);
  await idleTask("ordinary-ui-task", beforeOrdinaryRun);
  const waitOrdinaryOutput = async () => {
    const invocation = await lastInvocation();
    assert.equal(invocation.taskId, "ordinary-ui-task");
    await page.getByText(`普通回合：${invocation.turnToken}`, { exact: true }).filter({ visible: true }).last().waitFor();
    assert.equal(await page.getByText(/〔目标〕/).count(), 0, "ordinary conversation must not display phantom goal notices");
  };
  await waitOrdinaryOutput();
  for (const text of ["再说一句", "还有一句"]) {
    const previousEnds = await sessionEnds("ordinary-ui-task");
    await ordinaryReply.fill(text);
    const [returned] = await Promise.all([
      page.waitForResponse((value) => value.url().endsWith("/tasks/ordinary-ui-task/reply") && value.request().method() === "POST"),
      page.getByRole("button", { name: "发送回复", exact: true }).click(),
    ]);
    assert.equal(returned.status(), 202);
    await idleTask("ordinary-ui-task", previousEnds);
    await waitOrdinaryOutput();
  }
  await page.screenshot({ path: join(screenshots, "ordinary-no-goal-notices-live.png"), fullPage: true });
  await page.reload();
  await waitOrdinaryOutput();
  await page.screenshot({ path: join(screenshots, "ordinary-no-goal-notices-reloaded.png"), fullPage: true });

  await page.goto(`${base}/?project=cli-ui&task=codex-ui-task`);
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
  for (const text of ["换个执行器回复", "/status"]) {
    const alternateReply = await replyAs(text, "codex", "codex-ui-other");
    assert.equal(alternateReply.codexPlanMode, true);
    assert.deepEqual(alternateReply.codexPlanScopes, [{ executorId: "codex-ui", executorLabel: "codex@验证", isTaskOwner: true }]);
    assert.equal((await lastInvocation()).cliState.profileId, "codex-ui-other");
    assert.notEqual((await lastInvocation()).cliState.plan, true);
    await page.reload();
    await planNotice.waitFor();
    assert.match(await planNotice.innerText(), /codex@验证（任务归属人）/);
  }
  assert.equal((await sendCodex("照方案动手改吧")).codexPlanMode, true);
  assert.equal((await lastInvocation()).cliState.plan, true);
  await planNotice.waitFor();
  await page.screenshot({ path: join(screenshots, "plan-scopes-after-alternate-profile.png"), fullPage: true });
  assert.equal((await replyAs("/plan", "codex", "codex-ui-other")).codexPlanScopes.length, 2);
  const partiallyOff = await sendCodex("/plan off");
  assert.equal(partiallyOff.codexPlanMode, true);
  assert.deepEqual(partiallyOff.codexPlanScopes.map((scope) => scope.executorId), ["codex-ui-other"]);
  await planNotice.getByText(/codex@验证备用/).waitFor();
  await page.screenshot({ path: join(screenshots, "plan-other-scope-still-on.png"), fullPage: true });
  const previousRunEnds = await sessionEnds("codex-ui-task");
  assert.equal((await fetch(`${base}/api/tasks/codex-ui-task/run`, { method: "POST" })).status, 202);
  assert.equal((await idleTask("codex-ui-task", previousRunEnds)).codexPlanMode, false);
  await planNotice.waitFor({ state: "hidden" });
  assert.equal((await replyAs("备用执行器正常实施", "codex", "codex-ui-other")).codexPlanMode, false);
  assert.equal((await lastInvocation()).cliState.plan, false);
  await page.reload();
  await page.getByRole("textbox", { name: "回复任务" }).waitFor();
  await page.getByText("测试执行器：正常实施", { exact: true }).first().waitFor();
  assert.equal(await planNotice.count(), 0);
  await page.screenshot({ path: join(screenshots, "plan-all-scopes-reset-by-run.png"), fullPage: true });

  await sendCodex("/plan");
  await replyAs("/plan", "codex", "codex-ui-other");
  const agentPicker = page.getByRole("button", { name: /^智能体：/ });
  const switchAgent = async (agent) => {
    await agentPicker.click();
    const response = page.waitForResponse((value) => value.url().endsWith("/tasks/codex-ui-task") && value.request().method() === "PATCH");
    await page.getByRole("option", { name: new RegExp(`@${agent}`) }).click();
    assert.equal((await response).status(), 200);
    await page.keyboard.press("Escape");
  };
  await switchAgent("claude");
  const claudeStandingTask = await (await fetch(`${base}/api/tasks/codex-ui-task`)).json();
  await page.screenshot({ path: join(screenshots, "plan-scopes-after-claude-switch.png"), fullPage: true });
  assert.equal(claudeStandingTask.agentType, "claude");
  assert.equal(claudeStandingTask.codexPlanMode, true);
  assert.equal(claudeStandingTask.codexPlanScopes.length, 2);
  await planNotice.waitFor();
  assert.match(await planNotice.innerText(), /codex@验证（任务归属人）.*codex@验证备用（任务归属人）/);
  await page.reload();
  await page.getByRole("textbox", { name: "回复任务" }).waitFor();
  await planNotice.waitFor();
  await page.screenshot({ path: join(screenshots, "plan-scopes-claude-standing-reloaded.png"), fullPage: true });
  const summonCodex = async (text) => {
    await codexReply.fill(`${text} @codex`);
    await page.getByRole("option", { name: /@codex/ }).click();
    await page.getByRole("listbox", { name: "可选模型" }).getByRole("option").first().click();
    assert.match(await agentPicker.getAttribute("aria-label"), /^智能体：codex/);
    const previousEnds = await sessionEnds("codex-ui-task");
    const response = page.waitForResponse((value) => value.url().endsWith("/tasks/codex-ui-task/reply") && value.request().method() === "POST");
    await page.getByRole("button", { name: "发送回复", exact: true }).click();
    const replied = await response;
    assert.equal(replied.status(), 202);
    assert.equal(replied.request().postDataJSON().agent, "codex");
    assert.equal(replied.request().postDataJSON().executorId, "codex-ui");
    const task = await idleTask("codex-ui-task", previousEnds);
    assert.equal(task.agentType, claudeStandingTask.agentType);
    assert.equal(task.executorId, claudeStandingTask.executorId);
    return task;
  };
  assert.equal((await summonCodex("照方案动手改吧")).codexPlanMode, true);
  assert.equal((await lastInvocation()).cliState.profileId, "codex-ui");
  assert.equal((await lastInvocation()).cliState.plan, true);
  await planNotice.waitFor();
  await page.getByRole("button", { name: /^智能体：claude/ }).waitFor();
  await page.screenshot({ path: join(screenshots, "plan-scopes-temporary-codex-turn.png"), fullPage: true });
  await page.reload();
  await planNotice.waitFor();
  assert.deepEqual((await (await fetch(`${base}/api/tasks/codex-ui-task`)).json()).codexPlanScopes, claudeStandingTask.codexPlanScopes);
  assert.equal((await sendCodex("Claude 正常实施")).codexPlanMode, true);
  assert.equal((await lastInvocation()).cliState.profileId, "claude-ui");
  assert.notEqual((await lastInvocation()).cliState.plan, true);
  await planNotice.waitFor();
  await page.screenshot({ path: join(screenshots, "claude-implements-with-codex-scopes-visible.png"), fullPage: true });
  const summonedOff = await summonCodex("/plan off");
  assert.equal((await lastInvocation()).cliState.plan, false);
  assert.equal(summonedOff.codexPlanMode, true);
  assert.deepEqual(summonedOff.codexPlanScopes.map((scope) => scope.executorId), ["codex-ui-other"]);
  await planNotice.getByText(/codex@验证备用/).waitFor();
  await page.screenshot({ path: join(screenshots, "claude-standing-summoned-plan-off.png"), fullPage: true });
  assert.equal((await summonCodex("/plan")).codexPlanScopes.length, 2);
  const beforeClaudeRetry = await sessionEnds("codex-ui-task");
  const retryResponse = page.waitForResponse((value) => value.url().endsWith("/tasks/codex-ui-task/retry") && value.request().method() === "POST");
  await page.getByRole("button", { name: "重试", exact: true }).click();
  assert.equal((await retryResponse).status(), 202);
  assert.equal((await idleTask("codex-ui-task", beforeClaudeRetry)).codexPlanMode, false);
  await planNotice.waitFor({ state: "hidden" });
  await page.reload();
  await page.getByRole("textbox", { name: "回复任务" }).waitFor();
  assert.equal(await planNotice.count(), 0);
  await switchAgent("codex");
  await page.reload();
  await page.getByRole("textbox", { name: "回复任务" }).waitFor();
  assert.equal(await planNotice.count(), 0);
  for (const executorId of ["codex-ui", "codex-ui-other"]) {
    assert.equal((await replyAs("重试后正常实施", "codex", executorId)).codexPlanMode, false);
    assert.equal((await lastInvocation()).cliState.plan, false);
  }
  await page.screenshot({ path: join(screenshots, "claude-retry-clears-all-codex-scopes.png"), fullPage: true });
  await page.goto(`${base}/?project=cli-ui&task=fresh-claude-plan-task`);
  await page.getByRole("textbox", { name: "回复任务" }).waitFor();
  await planNotice.waitFor();
  assert.match(await planNotice.innerText(), /codex@验证（任务归属人）.*codex@验证备用（任务归属人）/);
  const beforeClaudeRun = await sessionEnds("fresh-claude-plan-task");
  const claudeRunResponse = page.waitForResponse((value) => value.url().endsWith("/tasks/fresh-claude-plan-task/run") && value.request().method() === "POST");
  await page.getByRole("button", { name: "运行", exact: true }).click();
  assert.equal((await claudeRunResponse).status(), 202);
  assert.equal((await idleTask("fresh-claude-plan-task", beforeClaudeRun)).codexPlanMode, false);
  await planNotice.waitFor({ state: "hidden" });
  const switchedBack = await fetch(`${base}/api/tasks/fresh-claude-plan-task`, {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ agentType: "codex", executorId: "codex-ui" }),
  });
  assert.equal(switchedBack.status, 200);
  assert.deepEqual((await switchedBack.json()).codexPlanScopes, []);
  for (const executorId of ["codex-ui", "codex-ui-other"]) {
    assert.equal((await replyAs("Claude 首跑后正常实施", "codex", executorId, "fresh-claude-plan-task")).codexPlanMode, false);
    assert.equal((await lastInvocation()).cliState.plan, false);
  }
  await page.reload();
  await page.getByText("测试执行器：正常实施", { exact: true }).first().waitFor();
  assert.equal(await planNotice.count(), 0);
  await page.screenshot({ path: join(screenshots, "claude-fresh-run-clears-codex-scopes.png"), fullPage: true });
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

  await sendScoped("/fork");
  assert.equal((await lastInvocation()).cliState.goal, null);
  assert.equal((await lastInvocation()).cliState.goalHold, false);
  assert.equal((await lastInvocation()).cliState.goalStart, undefined);
  const forkNotice = page.getByText(/^已创建独立会话分支；/).last();
  await forkNotice.waitFor();
  assert.match(await forkNotice.innerText(), /分叉后的会话不保留原目标、预算和已用量/);
  assert.match(await forkNotice.innerText(), /\/goal 描述 重新设置目标/);
  assert.match(await forkNotice.innerText(), /--budget 上限/);
  assert.doesNotMatch(await forkNotice.innerText(), /\/goal resume/);
  await page.screenshot({ path: join(screenshots, "fork-goal-reset-guide.png"), fullPage: true });
  await page.reload();
  await forkNotice.waitFor();
  await sendScoped("/goal");
  await page.getByText("当前没有目标。使用 /goal 描述 设置持续目标。", { exact: true }).waitFor();
  await page.screenshot({ path: join(screenshots, "fork-goal-empty-reloaded.png"), fullPage: true });
  const missingResume = await fetch(`${base}/api/tasks/scoped-goal-task/reply`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "/goal resume" }),
  });
  assert.equal(missingResume.status, 409);
  assert.match((await missingResume.json()).error, /没有可恢复的目标/);
  await sendScoped("/goal 分叉后的新目标 --budget 250");
  const replacementGoal = (await lastInvocation()).cliState.goal;
  assert.equal(replacementGoal.objective, "分叉后的新目标");
  assert.equal(replacementGoal.tokenBudget, 250);
  assert.equal(replacementGoal.tokensUsed, 0);
  await page.getByText("目标：分叉后的新目标；预算 250；已用 0", { exact: true }).waitFor();
  await page.screenshot({ path: join(screenshots, "fork-new-goal-budget.png"), fullPage: true });

  for (const agentType of ["codex", "claude"]) {
    const taskId = `live-${agentType}-goal`;
    await page.goto(`${base}/?project=cli-ui&task=${taskId}`);
    const beforeRun = await sessionEnds(taskId);
    const [runResponse] = await Promise.all([
      page.waitForResponse((value) => value.url().endsWith(`/tasks/${taskId}/run`) && value.request().method() === "POST"),
      page.getByRole("button", { name: "运行", exact: true }).click(),
    ]);
    assert.equal(runResponse.status(), 202);
    await idleTask(taskId, beforeRun);
    await page.getByText("测试执行器：正常实施", { exact: true }).last().waitFor();
    const liveReply = page.getByRole("textbox", { name: "回复任务" });
    const sendLive = async (text, expectedStatus) => {
      await liveReply.fill(`${text} `);
      const [returned] = await Promise.all([
        page.waitForResponse((value) => value.url().endsWith(`/tasks/${taskId}/reply`) && value.request().method() === "POST"),
        page.getByRole("button", { name: /^(发送回复|排队发送，任务跑完自动发出)$/ }).click(),
      ]);
      const result = await returned.json();
      assert.equal(returned.status(), expectedStatus, `${text}: ${JSON.stringify(result)}`);
      return result;
    };
    const startLiveGoal = async (text) => {
      const previousTurn = (await lastInvocation()).turnToken;
      await sendLive(text, 202);
      const deadline = Date.now() + 10_000;
      let invocation = await lastInvocation();
      while (invocation.taskId !== taskId || !invocation.turnToken || invocation.turnToken === previousTurn) {
        assert.ok(Date.now() < deadline, `new goal turn did not start: ${taskId} ${text}\n${log}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
        invocation = await lastInvocation();
      }
      assert.equal(invocation.cliCommand?.text, text);
      await page.getByText(/^目标：等待实时目标控制；/).filter({ hasText: `测试回合 ${invocation.turnToken}`, visible: true }).last().waitFor();
      return invocation;
    };
    await startLiveGoal(`/goal 等待实时目标控制${agentType === "codex" ? " --budget 500" : ""}`);
    assert.equal((await (await fetch(`${base}/api/tasks/${taskId}`)).json()).status, "running");
    const beforePause = await sessionEnds(taskId);
    assert.equal((await sendLive("/goal pause", 200)).command, true);
    const paused = await idleTask(taskId, beforePause);
    assert.equal(paused.status, "paused");
    const pauseNotice = page.getByText(/^持续目标已暂停；/).filter({ visible: true }).last();
    await pauseNotice.waitFor();
    assert.match(await pauseNotice.innerText(), /\/goal resume/);
    await page.reload();
    await pauseNotice.waitFor();
    await page.screenshot({ path: join(screenshots, `${agentType}-goal-paused-reloaded.png`), fullPage: true });

    const resumed = await startLiveGoal("/goal resume");
    assert.equal(resumed.cliState.goal?.objective, "等待实时目标控制");
    const beforeClear = await sessionEnds(taskId);
    assert.equal((await sendLive("/goal clear", 200)).command, true);
    if (agentType === "claude") {
      const deadline = Date.now() + 10_000;
      while ((await lastInvocation()).cliCommand?.text !== "/goal clear") {
        assert.ok(Date.now() < deadline, log);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    const cleared = await idleTask(taskId, beforeClear);
    assert.equal(cleared.status, "paused");
    const clearNotice = page.getByText(/^持续目标已清除；/).filter({ visible: true }).last();
    await clearNotice.waitFor();
    assert.match(await clearNotice.innerText(), /\/goal 描述/);
    assert.doesNotMatch(await clearNotice.innerText(), /\/goal resume/);
    await page.reload();
    await clearNotice.waitFor();
    await page.screenshot({ path: join(screenshots, `${agentType}-goal-cleared-reloaded.png`), fullPage: true });
    assert.match((await sendLive("/goal resume", 409)).error, /没有可恢复的目标/);
    const beforeReplacement = await sessionEnds(taskId);
    await sendLive(`/goal 重新设置后的目标${agentType === "codex" ? " --budget 600" : ""}`, 202);
    await idleTask(taskId, beforeReplacement);
    assert.equal((await lastInvocation()).cliState.goal.objective, "重新设置后的目标");
    await page.getByText(/^目标：重新设置后的目标；/).last().waitFor();
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
  const composerAgentPicker = page.getByRole("button", { name: /^智能体：/ });
  await composerAgentPicker.click();
  await page.getByRole("option", { name: /@claude/ }).click();
  await page.keyboard.press("Escape");
  assert.match(await composerAgentPicker.getAttribute("aria-label"), /智能体：claude/);
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
  await runGoalRecoveryUi({ page, base, screenshots, sessionEnds, idleTask });
  assert.deepEqual(pageErrors, []);
  console.log("ordinary Codex fresh task and two resumed replies have no phantom goal notices live or after reload: passed");
  console.log("native slash UI, agent/mode filtering, inline goal status without optimistic bubbles, durable reload: passed");
  console.log("creation validation reason, edited/legacy startup diagnostics, live display and durable reload: passed");
  console.log("plan mode live/reload notice, slash-only exit, fresh and resumable rerun reset: passed");
  console.log("queued plan executes instead of falsely completing; profile switch/resume preserves budget and scheduler hold: passed");
  console.log("plan scope labels survive profile switches and reloads; single-scope off stays visible; Codex Run and Claude Run/Retry reset every Codex scope: passed");
  console.log("Claude standing tasks keep scoped Codex notices; real @ summon and /plan off match invocation state without changing the standing agent: passed");
  console.log("fork output reports cleared goal and budget, remains visible after reload, and guides a fresh budgeted goal instead of unavailable resume: passed");
  console.log("Codex and Claude live goal pause stays resumable; clear persists truthful new-goal guidance across reloads, rejects missing resume, and accepts replacement: passed");
  console.log(`screenshots: ${screenshots}`);
} catch (error) {
  if (page) {
    await page.screenshot({ path: join(screenshots, "cli-regression-failed.png"), fullPage: true });
    console.error((await page.locator("body").innerText()).slice(-7000));
  }
  console.error(log.slice(-3000));
  throw error;
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
