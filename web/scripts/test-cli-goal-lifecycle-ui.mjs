import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { chromium } from "playwright-core";
import { hasCliGoalHold, readCliState } from "@ash/shared/cli-commands";
import { chromeLaunchOptions } from "./chrome-path.mjs";

const root = await mkdtemp(join(tmpdir(), "ash-goal-lifecycle-ui-"));
const workspace = join(root, "workspace");
const screenshots = process.env.ASH_CLI_SCREENSHOTS || join(root, "screenshots");
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
delete process.env.ASH_ALLOW_REAL_AGENT;
const { db, dbClient, ensureSchema } = await import("../../server/dist/db/index.js");
const { appSettings, projects, tasks, agents, groups, queueItems, sessions } = await import("../../server/dist/db/schema.js");
const { saveCliState } = await import("../../server/dist/task-cli-state.js");
await ensureSchema();
await mkdir(workspace);
await mkdir(screenshots, { recursive: true });
const at = new Date().toISOString();
await db.insert(appSettings).values({ key: "instanceMode", value: JSON.stringify("single") });
await db.insert(projects).values({ id: "goal-ui", name: "目标生命周期验证", repoPath: workspace, useWorktreeDefault: false, createdAt: at });
for (const agentType of ["codex", "claude"]) {
  await db.insert(agents).values({ id: `${agentType}-ui`, name: `${agentType}@验证`, type: agentType, isDefault: true, extraArgs: "[]", configOverrides: "{}" });
  await db.insert(groups).values({ id: `${agentType}-group`, projectId: "goal-ui", name: `${agentType} 串行组`, mode: "serial", createdAt: at });
  for (const [suffix, status, groupId] of [["busy", "backlog", null], ["A", "done", `${agentType}-group`], ["B", "backlog", `${agentType}-group`], ["invited-busy", "paused", null], ["recovery-busy", "canceled", `${agentType}-group`], ["blocker-busy", "backlog", `${agentType}-group`]]) {
    await db.insert(tasks).values({
      id: `${agentType}-${suffix}`, projectId: "goal-ui", groupId, title: `${agentType} · ${suffix}`, body: "普通回合测试夹具",
      mode: "single", status, agentType, executorId: `${agentType}-ui`, useWorktree: false, autoTitle: false, createdAt: at, updatedAt: at,
    });
  }
  await db.insert(queueItems).values([{ taskId: `${agentType}-A`, queueId: `${agentType}-queue`, position: 0, createdAt: at }, { taskId: `${agentType}-B`, queueId: `${agentType}-queue`, position: 1, createdAt: at }]);
  await db.insert(sessions).values({ id: `${agentType}-A-session`, taskId: `${agentType}-A`, role: "single", agentType, executor: agentType, executorId: `${agentType}-ui`, cliSessionId: `ui-${agentType}-A`, cwd: workspace, startedAt: at, endedAt: at, exitStatus: 0 });
  await db.insert(sessions).values({ id: `${agentType}-invited-session`, taskId: `${agentType}-invited-busy`, role: "single", agentType, executor: agentType, executorId: `${agentType}-ui`, cliSessionId: `ui-${agentType}-invited`, cwd: workspace, startedAt: at, endedAt: at, exitStatus: 0 });
  await saveCliState(`${agentType}-invited-busy`, agentType, { profileId: `${agentType}-ui`, ownerUserId: null, goal: { objective: `${agentType} 已停掉的旧目标`, status: "paused" } }, true);
  const recoveryId = `${agentType}-recovery-busy`;
  await db.insert(queueItems).values([{ taskId: recoveryId, queueId: `${agentType}-recovery-queue`, position: 0, createdAt: at }, { taskId: `${agentType}-blocker-busy`, queueId: `${agentType}-recovery-queue`, position: 1, createdAt: at }]);
  await db.insert(sessions).values({ id: `${recoveryId}-session`, taskId: recoveryId, role: "single", agentType, executor: agentType, executorId: `${agentType}-ui`, cliSessionId: `ui-${recoveryId}`, cwd: workspace, startedAt: at, endedAt: at, exitStatus: 0 });
  await saveCliState(recoveryId, agentType, { profileId: `${agentType}-ui`, ownerUserId: null, goalSessionId: `ui-${recoveryId}`, goalHold: true, goal: { objective: `${agentType} 已中断的原目标`, status: "paused", tokensUsed: 70, ...(agentType === "codex" ? { tokenBudget: 150 } : {}) } }, true);
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
      command: options.cliState?.profileId === "codex-ui" ? async (command) => {
        if (command.name !== "goal" || command.args !== "pause" || !goal) throw new Error("fixture only supports pausing a live goal");
        goal.status = "paused";
        return "目标：" + goal.objective + "；状态：已暂停";
      } : undefined,
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
const taskCliState = (taskId) => {
  const connection = new DatabaseSync(join(root, "ash.db"), { readOnly: true });
  try { return connection.prepare("SELECT cli_state FROM tasks WHERE id = ?").get(taskId).cli_state; }
  finally { connection.close(); }
};
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
  const send = async (taskId, text, summon = null) => {
    await page.getByRole("textbox", { name: "回复任务" }).fill(summon ? `${text} @${summon}` : `${text} `);
    if (summon) {
      await page.getByRole("option", { name: new RegExp(`@${summon}`) }).click();
      await page.getByRole("listbox", { name: "可选模型" }).getByRole("option").first().click();
    }
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

    const invitedId = `${agentType}-invited-busy`;
    const invitedAgent = agentType === "codex" ? "claude" : "codex";
    const invitedObjective = `${invitedAgent} 本轮召唤目标`;
    await page.goto(`${base}/?project=goal-ui&task=${invitedId}`);
    const invited = await send(invitedId, `/goal ${invitedObjective}`, invitedAgent);
    assert.equal(invited.status(), 202);
    assert.equal(invited.request().postDataJSON().agent, invitedAgent);
    await page.getByText(`目标回合已启动：${invitedObjective}`, { exact: true }).waitFor();
    const replaced = await send(invitedId, "/goal 不应替换活动目标");
    assert.equal(replaced.status(), 409);
    const replacementError = (await replaced.json()).error;
    assert.ok(replacementError.includes(invitedObjective));
    assert.doesNotMatch(replacementError, /已停掉的旧目标/);
    assert.ok(replacementError.includes(`@${invitedAgent}`));
    assert.ok(replacementError.includes(`${invitedAgent}-ui`));
    await page.getByText(replacementError, { exact: true }).waitFor();
    await page.screenshot({ path: join(screenshots, `lifecycle-${agentType}-invited-goal-rejected.png`), fullPage: true });
    const wrongPause = await send(invitedId, "/goal pause");
    assert.equal(wrongPause.status(), 409);
    const routingError = (await wrongPause.json()).error;
    assert.ok(routingError.includes(`@${invitedAgent}`));
    assert.ok(routingError.includes(`${invitedAgent}-ui`));
    assert.match(routingError, /\/goal pause/);
    await page.getByText(routingError, { exact: true }).waitFor();
    await page.screenshot({ path: join(screenshots, `lifecycle-${agentType}-invited-pause-routing.png`), fullPage: true });
    const rightPause = await send(invitedId, "/goal pause", invitedAgent);
    assert.equal(rightPause.status(), 200);
    const pausedTask = await waitForTask(invitedId, (task) => task.status === "paused");
    const storedState = taskCliState(invitedId);
    assert.equal(readCliState(storedState, invitedAgent, `${invitedAgent}-ui`, null).goal?.status, "paused");
    assert.equal(readCliState(storedState, agentType, `${agentType}-ui`, null).goal?.objective, `${agentType} 已停掉的旧目标`);
    assert.equal(pausedTask.agentType, agentType);
    assert.equal(pausedTask.executorId, `${agentType}-ui`);
    await page.reload();
    await page.getByText(`目标回合已启动：${invitedObjective}`, { exact: true }).waitFor();
    await page.screenshot({ path: join(screenshots, `lifecycle-${agentType}-invited-goal-paused-reload.png`), fullPage: true });
    console.log(`${agentType}: invited ${invitedAgent} objective and routing hints are accurate; following the summon hint pauses the active goal without changing the standing executor or old goal: passed`);

    const recoveryId = `${agentType}-recovery-busy`;
    const blockerId = `${agentType}-blocker-busy`;
    await page.goto(`${base}/?project=goal-ui&task=${blockerId}`);
    const [blockerStarted] = await Promise.all([
      page.waitForResponse((value) => value.url().endsWith(`/tasks/${blockerId}/run`) && value.request().method() === "POST"),
      page.getByRole("button", { name: "运行", exact: true }).click(),
    ]);
    assert.equal(blockerStarted.status(), 202);
    await page.getByText(`普通回合已启动：${blockerId}`, { exact: true }).waitFor();
    await page.goto(`${base}/?project=goal-ui&task=${recoveryId}`);
    const resumeResponse = await send(recoveryId, "/goal resume");
    assert.equal(resumeResponse.status(), 202);
    const queuedRecovery = await resumeResponse.json();
    assert.equal(queuedRecovery.scheduled, true);
    assert.equal(queuedRecovery.message.execution, true);
    assert.equal((await request(`tasks/${recoveryId}`)).status, "canceled");
    assert.equal((await request(`tasks/${blockerId}`)).status, "running");
    assert.equal((await invocations()).filter((entry) => entry.taskId === recoveryId).length, 0);
    await page.reload();
    await page.locator('[aria-label="待发送消息"]').getByText(queuedRecovery.message.text, { exact: true }).waitFor();
    await page.getByRole("button", { name: "查看队列 · 2 个任务", exact: true }).click();
    await page.getByText("running", { exact: true }).first().waitFor();
    assert.equal(await page.getByText("running", { exact: true }).count(), 1);
    assert.equal(await page.getByText("canceled", { exact: true }).count(), 1);
    await page.screenshot({ path: join(screenshots, `lifecycle-${agentType}-recovery-waits-queue.png`), fullPage: true });
    await writeFile(join(root, `${blockerId}.ordinary-release`), "finish");
    await waitForTask(blockerId, (task) => task.status === "done");
    await waitForTask(recoveryId, (task) => task.status === "running");
    await page.reload();
    await page.getByText(`目标回合已启动：${agentType} 已中断的原目标`, { exact: false }).last().waitFor();
    const resumedInvocations = (await invocations()).filter((entry) => entry.taskId === recoveryId);
    assert.equal(resumedInvocations.length, 1);
    const invocation = resumedInvocations[0];
    assert.equal(invocation.cliCommand.args, "resume");
    assert.equal(invocation.goal.objective, `${agentType} 已中断的原目标`);
    assert.equal(invocation.goal.tokensUsed, 70);
    if (agentType === "codex") assert.equal(invocation.goal.tokenBudget, 150);
    assert.equal(readCliState(taskCliState(recoveryId), agentType).goalSessionId, `ui-${recoveryId}`);
    assert.equal((await request(`tasks/${recoveryId}/scheduled-messages`)).length, 0);
    assert.deepEqual((await request(`queues/${agentType}-recovery-queue`)).items.map((item) => item.status), ["running", "done"]);
    await page.screenshot({ path: join(screenshots, `lifecycle-${agentType}-recovery-after-release.png`), fullPage: true });
    await writeFile(join(root, `${recoveryId}.goal-release`), "finish");
    await waitForTask(recoveryId, (task) => task.status === "paused");
    assert.equal(hasCliGoalHold(taskCliState(recoveryId)), true);
    console.log(`${agentType}: terminal resume waits for its running sibling, survives reload, restores original usage/session and retains unfinished-goal protection: passed`);
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
