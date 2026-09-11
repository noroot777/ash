import assert from "node:assert/strict";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { makeStep } from "@ash/shared/workflow";

export async function testTeamAcceptanceVerification() {
  const { db } = await import("../src/db/index.js");
  const { tasks, sessions, projects } = await import("../src/db/schema.js");
  const { mountTaskAcceptanceRoutes, acceptTask } = await import("../src/task-accept.js");
  const { readBranchPlan, acceptFamily } = await import("../src/task-branch-routes.js");
  const { commitAt } = await import("../src/task-branch-plan.js");
  const at = new Date().toISOString();
  const workflow = JSON.stringify({ workspace: "isolated", steps: [
    makeStep("run", "run"), makeStep("verify", "v1"), makeStep("verify", "v2"), makeStep("human", "human"),
  ] });
  const make = (id: string, patch: Partial<typeof tasks.$inferInsert> = {}) => db.insert(tasks).values({
    id, projectId: "verification", title: id, mode: "single", status: "done", stage: "awaiting_acceptance",
    workflow, workflowAt: "human", useWorktree: false, createdAt: at, updatedAt: at, ...patch,
  });
  const row = async (id: string) => (await db.select().from(tasks).where(eq(tasks.id, id)))[0]!;
  const api = new Hono();
  mountTaskAcceptanceRoutes(api);
  const check = async (id: string) => (await (await api.request(`/tasks/${id}/acceptance-check`)).json()).verification;
  const post = (id: string, confirmUnverified = false) => api.request(`/tasks/${id}/accept`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirmUnverified }),
  });

  await make("team-empty", { mode: "team", status: "idle" });
  assert.equal(await check("team-empty"), null, "a resident lead's empty verify stations are not missing work");
  assert.equal((await post("team-empty")).status, 200);

  await make("team-covered", { mode: "team", status: "idle" });
  await make("covered-inline", { parentId: "team-covered", verifyCompletedSteps: '["v1","v2"]' });
  await make("covered-confirmed", { parentId: "team-covered", stage: "accepted" });
  await make("covered-no-verify", { parentId: "team-covered", workflow: null });
  await make("covered-legacy", { parentId: "team-covered" });
  for (const step of ["v1", "v2"]) {
    await make(`team-review-${step}`, { parentId: "team-covered", reviewOf: "covered-legacy", reviewStep: step, workflow: null });
    await db.insert(sessions).values({ id: `team-session-${step}`, taskId: `team-review-${step}`,
      role: "single", agentType: "codex", executor: "codex", startedAt: at, endedAt: at });
  }
  await make("excluded-isolated", { parentId: "team-covered", useWorktree: true });
  await make("excluded-unrelated");
  assert.equal(await check("team-covered"), null);
  assert.equal((await readBranchPlan("team-covered"))!.task.unexecutedVerification, null);
  assert.equal((await post("team-covered")).status, 200);
  assert.equal((await row("covered-inline")).stage, "accepted");
  assert.equal((await row("excluded-isolated")).stage, "awaiting_acceptance");
  assert.deepEqual((await check("excluded-isolated")).stepIds, ["v1", "v2"], "isolated worker retains its own check");

  for (const [lead, leadWorkflow] of [["team-missing", workflow], ["team-no-workflow", null]] as const) {
    await make(lead, { mode: "team", status: "idle", workflow: leadWorkflow });
    const worker = `${lead}-worker`;
    await make(worker, { parentId: lead, title: "搜索排序", verifyCompletedSteps: '["v1"]' });
    await make(`${lead}-covered`, { parentId: lead, verifyCompletedSteps: '["v1","v2"]' });
    const missing = await check(lead);
    assert.deepEqual(missing.unverifiedTasks, [{ taskId: worker, title: "搜索排序", stepIds: ["v2"] }]);
    assert.deepEqual(missing.stepIds, [], "worker station ids are not attributed to the lead");
    assert.ok(missing.message.includes(worker));
    assert.match(missing.message, /搜索排序/);
    assert.doesNotMatch(missing.message, /工作流中有|covered/);
    assert.deepEqual((await readBranchPlan(lead))!.task.unexecutedVerification, missing);
    const before = await row(worker);
    const denied = await post(lead);
    assert.equal(denied.status, 409);
    assert.deepEqual((await denied.json()).verification, missing);
    assert.deepEqual(await row(worker), before);
    const automatic = await acceptTask(lead, "workflow");
    assert.ok(!automatic.accepted && automatic.reason === "verify_not_run");
    assert.equal((await post(lead, true)).status, 200);
    assert.equal(await check(lead), null);
    assert.equal((await row(worker)).stage, "accepted");
    assert.equal((await row(worker)).verifyCompletedSteps, '["v1"]', "confirmation cannot invent missing station evidence");
    await db.update(tasks).set({ stage: "awaiting_acceptance" }).where(eq(tasks.id, lead));
    assert.equal(await check(lead), null, "previously accepted workers need no repeated confirmation");
    await db.update(tasks).set({ stage: "implemented" }).where(eq(tasks.id, worker));
    assert.deepEqual((await check(lead)).unverifiedTasks, missing.unverifiedTasks, "reopened worker needs a fresh decision");
  }

  const project = (await db.select().from(projects).where(eq(projects.id, "verification")))[0]!;
  const start = await commitAt(project.repoPath, "main");
  await make("mixed-batch-root", { verifyCompletedSteps: '["v1","v2"]' });
  for (const id of ["mixed-batch-good", "mixed-batch-missing"]) {
    await make(id, { mode: "team", status: "idle", baseTaskId: "mixed-batch-root", worktreeStartCommit: start, mergeTargetBranch: "main" });
    await make(`${id}-worker`, { parentId: id, title: "批量执行者", verifyCompletedSteps: id.endsWith("good") ? '["v1","v2"]' : '["v1"]' });
  }
  const plan = (await readBranchPlan("mixed-batch-root"))!;
  assert.equal(plan.descendants.find(t => t.taskId === "mixed-batch-good")!.unexecutedVerification, null);
  const blocked = await acceptFamily("mixed-batch-root", [plan.task, ...plan.descendants], acceptTask);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.stoppedAt, "mixed-batch-missing");
  assert.deepEqual(blocked.completed, ["mixed-batch-root", "mixed-batch-good"]);
  assert.match(blocked.error!, /批量执行者/);
  assert.match(blocked.error!, /mixed-batch-missing-worker/);
  const retry = (await readBranchPlan("mixed-batch-root"))!;
  assert.equal((await acceptFamily("mixed-batch-root", [retry.task, ...retry.descendants]
    .map(t => ({ ...t, confirmUnverified: !!t.unexecutedVerification })), acceptTask)).ok, true);
  console.log("team accept verification: resident lead, shared-worker coverage, named missing stations, legacy/confirmed/reopened workers and mixed family acceptance passed");
}
