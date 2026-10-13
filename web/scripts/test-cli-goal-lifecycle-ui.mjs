import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { chromeLaunchOptions } from "./chrome-path.mjs";

const root = await mkdtemp(join(tmpdir(), "ash-goal-lifecycle-ui-"));
const workspace = join(root, "workspace");
const screenshots = process.env.ASH_CLI_SCREENSHOTS || join(root, "screenshots");
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
delete process.env.ASH_ALLOW_REAL_AGENT;
const { db, dbClient, ensureSchema } = await import("../../server/dist/db/index.js");
const { appSettings, projects, tasks, agents, groups, queueItems, sessions } = await import("../../server/dist/db/schema.js");
await ensureSchema();
await mkdir(workspace);
await mkdir(screenshots, { recursive: true });
const at = new Date().toISOString();
await db.insert(appSettings).values({ key: "instanceMode", value: JSON.stringify("single") });
await db.insert(projects).values({ id: "goal-ui", name: "目标生命周期验证", repoPath: workspace, useWorktreeDefault: false, createdAt: at });
for (const agentType of ["codex", "claude"]) {
  await db.insert(agents).values({ id: `${agentType}-ui`, name: `${agentType}@验证`, type: agentType, isDefault: true, extraArgs: "[]", configOverrides: "{}" });
  await db.insert(groups).values({ id: `${agentType}-group`, projectId: "goal-ui", name: `${agentType} 串行组`, mode: "serial", createdAt: at });
  for (const [suffix, status, groupId] of [["busy", "backlog", null], ["A", "done", `${agentType}-group`], ["B", "backlog", `${agentType}-group`]]) {
    await db.insert(tasks).values({
      id: `${agentType}-${suffix}`, projectId: "goal-ui", groupId, title: `${agentType} · ${suffix}`, body: "普通回合测试夹具",
      mode: "single", status, agentType, executorId: `${agentType}-ui`, useWorktree: false, autoTitle: false, createdAt: at, updatedAt: at,
    });
  }
  await db.insert(queueItems).values([{ taskId: `${agentType}-A`, queueId: `${agentType}-queue`, position: 0, createdAt: at }, { taskId: `${agentType}-B`, queueId: `${agentType}-queue`, position: 1, createdAt: at }]);
  await db.insert(sessions).values({ id: `${agentType}-A-session`, taskId: `${agentType}-A`, role: "single", agentType, executor: agentType, executorId: `${agentType}-ui`, cliSessionId: `ui-${agentType}-A`, cwd: workspace, startedAt: at, endedAt: at, exitStatus: 0 });
}
dbClient.close();
const listener = createServer();
listener.listen(0, "127.0.0.1");
await once(listener, "listening");
const port = listener.address().port;
await new Promise((resolve) => listener.close(resolve));
const repo = fileURLToPath(new URL("../..", import.meta.url));
const traceFile = join(root, "invocations.jsonl");
const boot = `
  const { appendFileSync, existsSync } = await import("node:fs");
  const { setTimeout: delay } = await import("node:timers/promises");
  const { eq } = await import("drizzle-orm");
  const { db } = await import("./server/dist/db/index.js");
  const { tasks } = await import("./server/dist/db/schema.js");
  const { CodexExecutor } = await import("./server/dist/executors/codex.js");
  const { ClaudeExecutor } = await import("./server/dist/executors/claude.js");
  function fixture(options) {
    const taskId = options.env.ASH_TASK_ID;
    const isGoal = options.cliCommand?.name === "goal";
    appendFileSync(${JSON.stringify(traceFile)}, JSON.stringify({ taskId, cliCommand: options.cliCommand, goal: options.cliState?.goal }) + "\\n");
    const goal = options.cliState?.goal ? { ...options.cliState.goal, status: "active" } : null;
    let killed = false;
    return {
      sessionId: options.sessionId || "ui-" + taskId, cliCommand: options.cliCommand,
      commandLine: "goal lifecycle UI fixture; no CLI/model",
      goal: options.cliState?.profileId === "codex-ui" ? () => goal : undefined,
      goalStarted: () => !!goal,
      kill() { killed = true; },
      events: (async function* () {
        yield { kind: "session", cliSessionId: "ui-" + taskId };
        yield { kind: "text", text: isGoal ? "目标回合已启动：" + goal.objective : "普通回合已启动：" + taskId };
        if (taskId.endsWith("-busy")) {
          const signal = ${JSON.stringify(root)} + "/" + taskId + (isGoal ? ".goal-release" : ".ordinary-release");
          while (!killed && !existsSync(signal)) await delay(20);
        }
        if (goal) { goal.status = "budgetLimited"; goal.tokensUsed = 150; }
        if (!isGoal && !killed) await db.update(tasks).set({ completeConfirmedAt: new Date().toISOString() }).where(eq(tasks.id, taskId));
        yield { kind: "done", exitStatus: 0 };
      })(),
    };
  }
  CodexExecutor.prototype.runSteerable = fixture;
  ClaudeExecutor.prototype.runSteerable = fixture;
  await import("./server/dist/index.js");
`;
const backend = spawn(process.execPath, ["--input-type=module", "-e", boot], {
  cwd: repo, env: { ...process.env, ASH_UPLOADS_DIR: join(root, "uploads"), ASH_PREVIEW: "1", ASH_SEED_FROM: "", PORT: String(port) },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
backend.stdout.on("data", (chunk) => { log += chunk; });
backend.stderr.on("data", (chunk) => { log += chunk; });
const base = `http://127.0.0.1:${port}`;
let browser;
let page;
const request = async (path) => {
  const response = await fetch(`${base}/api/${path}`);
  assert.equal(response.status, 200, path);
  return response.json();
};
const invocations = async () => JSON.parse(`[${(await readFile(traceFile, "utf8")).trim().split("\n").join(",")}]`);
const waitForTask = async (taskId, predicate) => {
  const deadline = Date.now() + 20_000;
  while (true) {
    const task = await request(`tasks/${taskId}`);
    if (predicate(task)) return task;
    assert.ok(Date.now() < deadline && backend.exitCode === null, `${taskId} did not settle\n${log}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};
try {
  const deadline = Date.now() + 15_000;
  while (true) {
    try { if ((await fetch(`${base}/api/projects`)).ok) break; } catch {}
    assert.ok(Date.now() < deadline && backend.exitCode === null, log);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  browser = await chromium.launch({ ...await chromeLaunchOptions(), headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const send = async (taskId, text) => {
    await page.getByRole("textbox", { name: "回复任务" }).fill(`${text} `);
    const [response] = await Promise.all([
      page.waitForResponse((value) => value.url().endsWith(`/tasks/${taskId}/reply`) && value.request().method() === "POST"),
      page.getByRole("button", { name: /^(发送回复|排队发送，任务跑完自动发出)$/ }).click(),
    ]);
    return response;
  };
  for (const agentType of ["codex", "claude"]) {
    const busyId = `${agentType}-busy`;
    const objective = `${agentType} 完成重构并让测试全过`;
    const text = `/goal ${objective}`;
    await page.goto(`${base}/?project=goal-ui&task=${busyId}`);
    const [started] = await Promise.all([
      page.waitForResponse((value) => value.url().endsWith(`/tasks/${busyId}/run`) && value.request().method() === "POST"),
      page.getByRole("button", { name: "运行", exact: true }).click(),
    ]);
    assert.equal(started.status(), 202);
    await page.getByText(`普通回合已启动：${busyId}`, { exact: true }).waitFor();
    const queued = await send(busyId, text);
    assert.equal(queued.status(), 202);
    assert.equal((await queued.json()).scheduled, true);
    await page.locator('[aria-label="待发送消息"]').getByText(text, { exact: true }).waitFor();
    assert.equal((await request(`tasks/${busyId}`)).status, "running");
    assert.equal((await invocations()).filter((entry) => entry.taskId === busyId).length, 1);
    await page.reload();
    await page.locator('[aria-label="待发送消息"]').getByText(text, { exact: true }).waitFor();
    await page.screenshot({ path: join(screenshots, `lifecycle-${agentType}-queued-goal.png`), fullPage: true });

    await writeFile(join(root, `${busyId}.ordinary-release`), "finish");
    await page.getByText(`目标回合已启动：${objective}`, { exact: true }).waitFor();
    assert.equal((await invocations()).filter((entry) => entry.taskId === busyId).length, 2);
    assert.equal((await request(`tasks/${busyId}/scheduled-messages`)).length, 0);
    const rejected = await send(busyId, "/goal 不能替换原目标");
    assert.equal(rejected.status(), 409);
    const error = (await rejected.json()).error;
    assert.ok(error.includes(objective));
    assert.match(error, /\/goal pause.*等待回合结束/);
    await page.getByText(error, { exact: true }).waitFor();
    await page.screenshot({ path: join(screenshots, `lifecycle-${agentType}-active-goal-rejected.png`), fullPage: true });
    await writeFile(join(root, `${busyId}.goal-release`), "finish");
    await waitForTask(busyId, (task) => task.status === "done");
    await page.reload();
    await page.getByText(`目标回合已启动：${objective}`, { exact: true }).waitFor();
    assert.equal((await request(`tasks/${busyId}/scheduled-messages`)).length, 0);
    console.log(`${agentType}: busy goal queues visibly across reload, auto-delivers after the ordinary turn, and active replacement has actionable guidance: passed`);

    const firstId = `${agentType}-A`;
    const nextId = `${agentType}-B`;
    const followUp = `/goal ${agentType} 把 A 的测试覆盖率提到 90%`;
    await page.goto(`${base}/?project=goal-ui&task=${firstId}`);
    assert.equal((await send(firstId, followUp)).status(), 202);
    await page.getByText(`目标回合已启动：${agentType} 把 A 的测试覆盖率提到 90%`, { exact: true }).waitFor();
    await waitForTask(firstId, (task) => task.status === "done");
    await waitForTask(nextId, (task) => task.status === "done");
    assert.equal((await invocations()).filter((entry) => entry.taskId === nextId).length, 1);
    assert.deepEqual((await request(`queues/${agentType}-queue`)).items.map((item) => item.status), ["done", "done"]);
    await page.screenshot({ path: join(screenshots, `lifecycle-${agentType}-terminal-goal-queue.png`), fullPage: true });
    await page.reload();
    await page.getByText(`目标回合已启动：${agentType} 把 A 的测试覆盖率提到 90%`, { exact: true }).waitFor();
    assert.equal((await request(`tasks/${firstId}`)).status, "done");
    assert.equal((await request(`tasks/${nextId}`)).status, "done");
    await page.screenshot({ path: join(screenshots, `lifecycle-${agentType}-terminal-goal-reload.png`), fullPage: true });
    console.log(`${agentType}: terminal goal reply preserves completion, next serial member actually runs, and both states survive reload: passed`);
  }
  assert.deepEqual(pageErrors, []);
  console.log(`screenshots: ${screenshots}`);
} catch (error) {
  if (page) {
    await page.screenshot({ path: join(screenshots, "lifecycle-failure.png"), fullPage: true }).catch(() => {});
    await writeFile(join(screenshots, "lifecycle-failure.txt"), `${String(error)}\n${await page.locator("body").innerText()}\n${log}`).catch(() => {});
  }
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
