import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const scopeKey = (profileId) => encodeURIComponent(JSON.stringify([profileId, null]));
const held = (profileId, objective) => ({ profileId, ownerUserId: null, goalHold: true, goal: { objective, status: "budgetLimited", tokenBudget: 150, tokensUsed: 150 } });

export function goalRecoveryFixtures(at) {
  const common = { projectId: "cli-ui", body: "目标作用域验证", mode: "single", status: "paused", agentType: "codex", autoTitle: false, createdAt: at, updatedAt: at };
  return [
    { ...common, id: "goal-empty-ui", title: "尚未运行的目标查询", status: "backlog", executorId: "codex-ui" },
    { ...common, id: "ordinary-drift-ui", title: "换档后继续旧对话", status: "done", executorId: null },
    ...["missing", "different"].map((kind) => ({ ...common, id: `goal-snapshot-${kind}`, title: `原生目标快照 ${kind}`, executorId: "codex-ui", cliState: JSON.stringify({ codex: held("codex-ui", "快照保留目标") }) })),
    { ...common, id: "goal-drift-ui", title: "默认漂移后的原目标", executorId: "codex-ui", cliState: JSON.stringify({ codex: held("codex-ui-other", "Codex 原作用域目标") }) },
    { ...common, id: "goal-multiple-ui", title: "多个目标的显式选择", executorId: "codex-ui", cliState: JSON.stringify({ codex: held("codex-ui-other", "保留的 Codex 目标"), claude: held("claude-ui", "独立的 Claude 目标") }) },
    { ...common, id: "goal-deleted-ui", title: "已删除执行器的目标解锁", executorId: "codex-ui", cliState: JSON.stringify({ codex: held("deleted-goal-profile", "已删除执行器的保留目标") }) },
  ];
}

export function goalRecoverySessions(at, cwd) {
  return goalRecoveryFixtures(at).filter((task) => task.id !== "goal-empty-ui").map((task) => ({ id: `${task.id}-original`, taskId: task.id, role: "single", agentType: "codex", executor: "codex", executorId: task.id.startsWith("goal-snapshot-") ? "codex-ui" : task.id === "goal-deleted-ui" ? "deleted-goal-profile" : "codex-ui-other", cliSessionId: `${task.id}-original-native`, cwd, startedAt: at, turnStartedAt: at, endedAt: at, exitStatus: 0 }));
}

export async function seedGoalRecoveryTranscripts(root) {
  const directory = join(root, "runs", "ordinary-drift-ui");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "ordinary-drift-ui-original.md"), "我已经把 auth 模块迁移了一半，剩下 token 刷新那段。\n");
}

export async function runGoalRecoveryUi({ page, base, screenshots, sessionEnds, idleTask, readInvocations }) {
  const expandNotice = async (text) => {
    const notice = page.locator(".system-event-digest").filter({ hasText: text }).last();
    await notice.locator("summary").click();
    assert.equal(await notice.locator("ol").isVisible(), true);
    return notice.locator("ol").innerText();
  };
  const send = async (taskId, text, expectedStatus) => {
    const previous = await sessionEnds(taskId);
    await page.getByRole("textbox", { name: "回复任务" }).fill(`${text} `);
    const [result] = await Promise.all([
      page.waitForResponse((value) => value.url().endsWith(`/tasks/${taskId}/reply`) && value.request().method() === "POST", { timeout: 10000 }),
      page.getByRole("button", { name: "发送回复", exact: true }).click(),
    ]).catch(async (error) => {
      await page.screenshot({ path: join(screenshots, `${taskId}-send-failed.png`), fullPage: true });
      console.error(await page.locator("body").innerText());
      throw error;
    });
    assert.equal(result.status(), expectedStatus);
    const body = await result.json();
    if (expectedStatus === 202) await idleTask(taskId, previous);
    return body;
  };
  await page.goto(`${base}/?project=cli-ui&task=goal-empty-ui`);
  const beforeEmpty = await (await fetch(`${base}/api/tasks/goal-empty-ui`)).json();
  const emptyScopes = await send("goal-empty-ui", "/goal --scopes", 200);
  assert.equal(emptyScopes.recorded, false);
  const localResult = page.getByRole("status", { name: "命令结果" });
  await localResult.waitFor();
  assert.match(await localResult.innerText(), /没有已保存的目标[\s\S]*\/goal 描述/);
  assert.equal(await page.getByRole("textbox", { name: "回复任务" }).inputValue(), "");
  assert.equal((await sessionEnds("goal-empty-ui")).size, 0);
  assert.deepEqual(await (await fetch(`${base}/api/tasks/goal-empty-ui`)).json(), beforeEmpty);
  assert.equal((await readInvocations()).some((invocation) => invocation.taskId === "goal-empty-ui"), false);
  await page.screenshot({ path: join(screenshots, "goal-empty-scopes-visible.png"), fullPage: true });
  await page.getByRole("textbox", { name: "回复任务" }).fill("普通追问");
  assert.equal(await page.getByRole("button", { name: "发送回复", exact: true }).isDisabled(), true, "scope discovery does not enable ordinary conversation on a never-run task");
  let releaseResponse;
  let requestReceived;
  const delayed = new Promise((resolve) => { releaseResponse = resolve; });
  const received = new Promise((resolve) => { requestReceived = resolve; });
  const delayedReply = async (route) => {
    const response = await route.fetch();
    requestReceived();
    await delayed;
    await route.fulfill({ response });
  };
  await page.route("**/api/tasks/goal-empty-ui/reply", delayedReply);
  await page.getByRole("textbox", { name: "回复任务" }).fill("/goal --scopes ");
  await page.getByRole("button", { name: "发送回复", exact: true }).click();
  await received;
  await page.locator('.workspace-task-row[data-task-id="goal-drift-ui"]').click();
  const returned = page.waitForResponse((response) => response.url().endsWith("/tasks/goal-empty-ui/reply"));
  releaseResponse();
  await returned;
  await page.unroute("**/api/tasks/goal-empty-ui/reply", delayedReply);
  await page.getByRole("button", { name: "发送回复", exact: true }).waitFor();
  assert.equal(await localResult.count(), 0, "an old task's delayed command result must not leak into the selected task");

  await page.goto(`${base}/?project=cli-ui&task=goal-drift-ui`);
  const beforeTypos = await (await fetch(`${base}/api/tasks/goal-drift-ui`)).json();
  const callsBeforeTypos = (await readInvocations()).length;
  for (const text of ["/goal --scope", "/goal --scope codex:mistyped", "/goal -scopes", "/goal --scopes=1", "/goal scopes", "/plan --off", "/plan -off", "/review --bas main"]) {
    const rejected = await send("goal-drift-ui", text, 409);
    assert.match(rejected.error, /\/goal|不支持这个参数/);
    assert.deepEqual(await (await fetch(`${base}/api/tasks/goal-drift-ui`)).json(), beforeTypos);
  }
  assert.equal((await readInvocations()).length, callsBeforeTypos);
  await page.screenshot({ path: join(screenshots, "goal-typo-rejected.png"), fullPage: true });
  const discovery = await send("goal-drift-ui", "/goal --scopes", 200);
  assert.equal(discovery.recorded, true);
  assert.equal(await localResult.count(), 0, "recorded command output appears only in the timeline");
  assert.match(discovery.text, /codex@验证备用/);
  assert.match(discovery.text, /150 \/ 150/);
  await page.reload();
  const visibleScopes = await expandNotice(/已保存的目标作用域/);
  assert.match(visibleScopes, /resume --scope codex:/);
  assert.match(visibleScopes, /clear --scope codex:/);
  assert.match(visibleScopes, /150 \/ 150/);
  await page.screenshot({ path: join(screenshots, "goal-cross-scope-discovery.png"), fullPage: true });
  await send("goal-drift-ui", "/goal resume", 202);
  const resumed = await send("goal-drift-ui", "/goal --scopes", 200);
  assert.match(resumed.text, /Codex 原作用域目标/);
  assert.match(resumed.text, /150 \/ 150/);
  const standing = await (await fetch(`${base}/api/tasks/goal-drift-ui`)).json();
  assert.equal(standing.executorId, "codex-ui");
  assert.equal(standing.status, "paused");
  await page.reload();
  await expandNotice(/已保存的目标作用域/);
  await page.screenshot({ path: join(screenshots, "goal-cross-scope-resumed-reloaded.png"), fullPage: true });

  await page.goto(`${base}/?project=cli-ui&task=goal-multiple-ui`);
  const ambiguous = await send("goal-multiple-ui", "/goal resume", 409);
  assert.match(ambiguous.error, /多个目标/);
  const both = await send("goal-multiple-ui", "/goal --scopes", 200);
  assert.match(both.text, /保留的 Codex 目标/);
  assert.match(both.text, /独立的 Claude 目标/);
  await page.reload();
  const visibleChoices = await expandNotice(/已保存的目标作用域/);
  assert.match(visibleChoices, /resume --scope codex:/);
  assert.match(visibleChoices, /resume --scope claude:/);
  await page.screenshot({ path: join(screenshots, "goal-multiple-scope-selection.png"), fullPage: true });
  const selected = `claude:${scopeKey("claude-ui")}`;
  await send("goal-multiple-ui", `/goal resume --scope ${selected}`, 202);
  await send("goal-multiple-ui", `/goal clear --scope ${selected}`, 202);
  const remaining = await send("goal-multiple-ui", "/goal --scopes", 200);
  assert.match(remaining.text, /保留的 Codex 目标/);
  assert.match(remaining.text, /持有任务暂停标记/);
  assert.doesNotMatch(remaining.text, /独立的 Claude 目标/);
  assert.equal((await (await fetch(`${base}/api/tasks/goal-multiple-ui`)).json()).status, "paused", "scope controls do not falsely complete a task");

  await page.goto(`${base}/?project=cli-ui&task=goal-deleted-ui`);
  const deletedHint = await send("goal-deleted-ui", "/goal --scopes", 200);
  assert.doesNotMatch(deletedHint.text, /恢复：\/goal resume/);
  assert.match(deletedHint.text, /不能恢复[\s\S]*清除：\/goal clear --scope/);
  assert.match(await expandNotice(/不能恢复/), /不能恢复/);
  await page.screenshot({ path: join(screenshots, "goal-unavailable-clear-only.png"), fullPage: true });
  const unavailable = await send("goal-deleted-ui", "/goal resume", 409);
  assert.match(unavailable.error, /目标仍保存在[\s\S]*deleted-goal-profile[\s\S]*clear --scope/);
  const cleared = await send("goal-deleted-ui", `/goal clear --scope codex:${scopeKey("deleted-goal-profile")}`, 200);
  assert.equal(cleared.started, false);
  assert.match(cleared.text, /已保存目标已清除，暂停标记已释放/);
  assert.match(cleared.text, /未调用其 CLI/);
  await page.getByText(/已保存目标已清除，暂停标记已释放/).filter({ visible: true }).first().waitFor();
  await page.reload();
  await page.getByText(/已保存目标已清除，暂停标记已释放/).filter({ visible: true }).first().waitFor();
  assert.match(await expandNotice(/已保存目标已清除，暂停标记已释放/), /未调用其 CLI/);
  await page.screenshot({ path: join(screenshots, "goal-deleted-profile-cleared-reloaded.png"), fullPage: true });
  await page.goto(`${base}/?project=cli-ui&task=ordinary-drift-ui`);
  await page.getByText("我已经把 auth 模块迁移了一半，剩下 token 刷新那段。", { exact: true }).waitFor();
  await send("ordinary-drift-ui", "token 刷新那段你做完了吗？", 202);
  const ordinaryCalls = (await readInvocations()).filter((invocation) => invocation.taskId === "ordinary-drift-ui");
  assert.equal(ordinaryCalls.length, 1);
  assert.equal(ordinaryCalls[0].sessionId, "ordinary-drift-ui-original-native");
  assert.equal(ordinaryCalls[0].cliState.profileId, "codex-ui");
  assert.equal((await sessionEnds("ordinary-drift-ui")).size, 1);
  await page.reload();
  await page.getByText("我已经把 auth 模块迁移了一半，剩下 token 刷新那段。", { exact: true }).waitFor();
  await page.getByLabel("任务会话", { exact: true }).getByText("token 刷新那段你做完了吗？", { exact: true }).waitFor();
  await page.screenshot({ path: join(screenshots, "ordinary-profile-drift-keeps-history.png"), fullPage: true });
  for (const kind of ["missing", "different"]) {
    const taskId = `goal-snapshot-${kind}`;
    await page.goto(`${base}/?project=cli-ui&task=${taskId}`);
    for (const command of ["/goal", "/goal pause"]) {
      await send(taskId, command, 202);
      await page.reload();
      const snapshotOutput = page.locator(".task-message--agent").filter({ hasText: "快照保留目标" }).last();
      await snapshotOutput.waitFor();
      assert.match(await snapshotOutput.innerText(), /150 \/ 150[\s\S]*原生会话里[\s\S]*保存快照/);
      assert.doesNotMatch(await page.getByLabel("任务会话", { exact: true }).innerText(), /起跑失败|启动失败/);
      const snapshotTask = await (await fetch(`${base}/api/tasks/${taskId}`)).json();
      assert.equal(snapshotTask.status, "paused");
      const snapshotSessions = await (await fetch(`${base}/api/tasks/${taskId}/sessions`)).json();
      assert.equal(snapshotSessions.length, 1);
      assert.equal(snapshotSessions[0].exitStatus, 0);
    }
    await page.screenshot({ path: join(screenshots, `${taskId}-query-pause-reloaded.png`), fullPage: true });
  }
  console.log("mismatched/missing native goals show the saved snapshot and warning for query/pause, without startup failure or native mutation: passed");
  console.log("never-run scope query stays visible/model-free; delayed results do not leak between tasks; recorded results do not duplicate; ordinary drift resumes the historical thread: passed");
  console.log("browser slash entry: drift recovery preserves budget, explicit multi-scope selection preserves other holds, deleted-profile clear persists after reload: passed");
}
