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
  assert.equal(answered.codexPlanMode, true);
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
  assert.equal(task.codexPlanMode, false);
  const invocation = await lastInvocation();
  assert.match(invocation.cliCommand.text, /^\/plan implement plan-/);
  assert.equal(invocation.cliState.plan, false);
  assert.equal(await implement.count(), 0);
  await page.reload();
  await page.getByRole("textbox", { name: "回复任务" }).waitFor();
  assert.equal(await implement.count(), 0);
  console.log("Plan document persists through the real API and reload; approval starts execution in the original scope: passed");
}
