import assert from "node:assert/strict";
import { join } from "node:path";

export async function clarifyPlanUi({ page, base, sendCodex, sessionEnds, idleTask, lastInvocation, screenshots }) {
  const task = await sendCodex("/plan clarify-ui");
  assert.equal(task.question, "请确认以下问题");
  assert.equal(task.questionItems.length, 2);
  await page.reload();
  const card = page.getByRole("region", { name: "等待答复的问题", exact: true });
  await card.getByRole("textbox", { name: "答复：什么时候重置？", exact: true }).fill("每周一");
  await card.getByRole("button", { name: "下一题", exact: true }).click();
  await card.getByRole("textbox", { name: "答复：什么时候生效？", exact: true }).fill("立即生效");
  await page.screenshot({ path: join(screenshots, "plan-clarification.png"), fullPage: true });
  const previousEnds = await sessionEnds("codex-ui-task");
  const replied = page.waitForResponse((response) => response.url().endsWith("/tasks/codex-ui-task/answer") && response.request().method() === "POST");
  await card.getByRole("button", { name: "发送答复", exact: true }).click();
  assert.equal((await replied).status(), 200);
  const answered = await idleTask("codex-ui-task", previousEnds);
  assert.equal(answered.question, null);
  assert.equal(answered.planMode, true);
  assert.equal((await lastInvocation()).cliState.plan, true);
  console.log("Native planning questions persist through reload; answering resumes planning rather than implementation: passed");
}

export async function implementPlanUi({ page, base, sessionEnds, idleTask, lastInvocation, screenshots }) {
  const plan = page.getByRole("region", { name: "计划书", exact: true }).last();
  await plan.getByRole("heading", { name: "计划 UI 验证", exact: true }).waitFor();
  assert.equal(await plan.locator("table").count(), 1);
  assert.doesNotMatch(await plan.innerText(), /尚未定稿/);
  const implement = page.getByRole("button", { name: "实施此计划", exact: true });
  await implement.waitFor();
  await page.reload();
  await implement.waitFor();
  await page.screenshot({ path: join(screenshots, "plan-document-ready.png"), fullPage: true });
  const previousEnds = await sessionEnds("codex-ui-task");
  const replied = page.waitForResponse((response) => response.url().endsWith("/tasks/codex-ui-task/reply") && response.request().method() === "POST");
  await implement.click();
  const response = await replied;
  assert.equal(response.status(), 202, await response.text());
  const task = await idleTask("codex-ui-task", previousEnds);
  assert.equal(task.planMode, false);
  const invocation = await lastInvocation();
  assert.match(invocation.cliCommand.text, /^\/plan implement plan-/);
  assert.equal(invocation.cliState.plan, false);
  assert.equal(await implement.count(), 0);
  await page.reload();
  await page.getByRole("textbox", { name: "回复任务" }).waitFor();
  assert.equal(await implement.count(), 0);
  console.log("Plan document persists through the real API and reload; approval starts execution in the original scope: passed");
}

// claude 的计划模式由 Navi 切权限参数实现（server/src/plan-turn.ts）：开关当场生效、不起回合；带问题的
// /plan 摘掉前缀进计划回合；实施以默认权限续同一会话，prompt 换成「按已确认的计划动手」那一句。
export async function claudePlanUi({ page, base, sessionEnds, idleTask, lastInvocation, screenshots }) {
  const taskUrl = `${base}/api/tasks/claude-plan-task`;
  const send = (text) => fetch(`${taskUrl}/reply`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
  await page.goto(`${base}/?project=cli-ui&task=claude-plan-task`);
  const reply = page.getByRole("textbox", { name: "回复任务" });
  await reply.fill("/pl");
  await page.getByRole("option", { name: /^\/plan\b/ }).waitFor();
  await reply.fill("");
  const sessionsBefore = (await (await fetch(`${taskUrl}/sessions`)).json()).length;
  const on = await send("/plan");
  assert.equal(on.status, 200);
  assert.equal((await on.json()).command, true);
  const notice = page.getByRole("status", { name: "计划模式" });
  await notice.waitFor();
  assert.match(await notice.innerText(), /\/plan off/);
  assert.equal((await (await fetch(`${taskUrl}/sessions`)).json()).length, sessionsBefore, "开关不起回合");
  await notice.getByRole("button", { name: "退出计划模式" }).click();
  await notice.waitFor({ state: "hidden" });
  assert.equal((await (await fetch(taskUrl)).json()).planMode, false);

  const beforePlan = await sessionEnds("claude-plan-task");
  assert.equal((await send("/plan 怎么拆这个功能")).status, 202);
  const planned = await idleTask("claude-plan-task", beforePlan);
  assert.equal(planned.planMode, true);
  assert.equal(planned.status, "done", "计划回合是旁路回合，任务回到原状态");
  const planning = await lastInvocation();
  assert.equal(planning.planMode, true);
  assert.match(planning.prompt, /怎么拆这个功能/);
  assert.doesNotMatch(planning.prompt, /\/plan 怎么拆/);
  const implement = page.getByRole("button", { name: "实施此计划", exact: true });
  await implement.waitFor();
  await page.screenshot({ path: join(screenshots, "claude-plan-ready.png"), fullPage: true });
  const beforeImplement = await sessionEnds("claude-plan-task");
  const replied = page.waitForResponse((response) => response.url().endsWith("/tasks/claude-plan-task/reply") && response.request().method() === "POST");
  await implement.click();
  assert.equal((await replied).status(), 202);
  const implemented = await idleTask("claude-plan-task", beforeImplement);
  assert.equal(implemented.planMode, false);
  const run = await lastInvocation();
  assert.match(run.cliCommand.text, /^\/plan implement plan-/);
  assert.notEqual(run.planMode, true);
  assert.match(run.prompt, /用户已确认最新计划，现在按此计划开始实施/);
  assert.equal(await implement.count(), 0);
  console.log("Claude plan toggles in place, plans in a read-only turn and implements in the original session: passed");
}
