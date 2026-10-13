import assert from "node:assert/strict";
import { join } from "node:path";

const scopeKey = (profileId) => encodeURIComponent(JSON.stringify([profileId, null]));
const held = (profileId, objective) => ({ profileId, ownerUserId: null, goalHold: true, goal: { objective, status: "budgetLimited", tokenBudget: 150, tokensUsed: 150 } });

export function goalRecoveryFixtures(at) {
  const common = { projectId: "cli-ui", body: "目标作用域验证", mode: "single", status: "paused", agentType: "codex", autoTitle: false, createdAt: at, updatedAt: at };
  return [
    { ...common, id: "goal-drift-ui", title: "默认漂移后的原目标", executorId: "codex-ui", cliState: JSON.stringify({ codex: held("codex-ui-other", "Codex 原作用域目标") }) },
    { ...common, id: "goal-multiple-ui", title: "多个目标的显式选择", executorId: "codex-ui", cliState: JSON.stringify({ codex: held("codex-ui-other", "保留的 Codex 目标"), claude: held("claude-ui", "独立的 Claude 目标") }) },
    { ...common, id: "goal-deleted-ui", title: "已删除执行器的目标解锁", executorId: "codex-ui", cliState: JSON.stringify({ codex: held("deleted-goal-profile", "已删除执行器的保留目标") }) },
  ];
}

export function goalRecoverySessions(at, cwd) {
  return goalRecoveryFixtures(at).map((task) => ({ id: `${task.id}-original`, taskId: task.id, role: "single", agentType: "codex", executor: "codex", executorId: task.id === "goal-deleted-ui" ? "deleted-goal-profile" : "codex-ui-other", cliSessionId: `${task.id}-original-native`, cwd, startedAt: at, turnStartedAt: at, endedAt: at, exitStatus: 0 }));
}

export async function runGoalRecoveryUi({ page, base, screenshots, sessionEnds, idleTask }) {
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
  await page.goto(`${base}/?project=cli-ui&task=goal-drift-ui`);
  const discovery = await send("goal-drift-ui", "/goal --scopes", 200);
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
  console.log("browser slash entry: drift recovery preserves budget, explicit multi-scope selection preserves other holds, deleted-profile clear persists after reload: passed");
}
