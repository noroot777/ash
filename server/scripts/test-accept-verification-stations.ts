import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { makeStep } from "@ash/shared/workflow";

export const multiVerifyWorkflow = JSON.stringify({ workspace: "isolated", steps: [
  makeStep("run", "run"), makeStep("verify", "v1"), makeStep("human", "h1"),
  makeStep("verify", "v2"), makeStep("human", "h2"),
] });

export async function testVerificationStations() {
  const { db, dbClient, ensureSchema } = await import("../src/db/index.js");
  const { tasks, sessions } = await import("../src/db/schema.js");
  const { acceptTask, mountTaskAcceptanceRoutes } = await import("../src/task-accept.js");
  const { handleTaskSettlement, startVerifyRound } = await import("../src/review.js");
  const { isTurnClaimed } = await import("../src/runs.js");
  const { readBranchPlan } = await import("../src/task-branch-routes.js");
  const api = new Hono();
  mountTaskAcceptanceRoutes(api);
  const at = new Date().toISOString();
  const row = async (id: string) => (await db.select().from(tasks).where(eq(tasks.id, id)))[0]!;
  const post = (id: string, confirmUnverified = false) => api.request(`/tasks/${id}/accept`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirmUnverified }),
  });
  const check = async (id: string) => (await (await api.request(`/tasks/${id}/acceptance-check`)).json()).verification;
  async function make(id: string, patch: Partial<typeof tasks.$inferInsert> = {}) {
    await db.insert(tasks).values({ id, projectId: "verification", title: id, mode: "single", status: "done",
      stage: "awaiting_acceptance", workflow: multiVerifyWorkflow, workflowAt: "h2", useWorktree: false,
      createdAt: at, updatedAt: at, ...patch });
  }
  async function missing(id: string, stepIds: string[]) {
    assert.deepEqual((await check(id)).stepIds, stepIds);
    const before = await row(id);
    const response = await post(id);
    assert.equal(response.status, 409);
    const result = await response.json();
    assert.equal(result.reason, "verify_not_run");
    assert.equal(result.confirmationRequired, "confirmUnverified");
    assert.deepEqual(result.verification.stepIds, stepIds);
    assert.deepEqual(await row(id), before, "refusal leaves task unchanged");
  }

  // 报告里的旧数据：只执行过 v1，却已停在最终 human。
  await make("stations-skipped", { verifyRounds: 1, reviewStep: "v1", verifyStationRounds: 1 });
  await missing("stations-skipped", ["v2"]);
  assert.deepEqual((await readBranchPlan("stations-skipped"))!.task.unexecutedVerification?.stepIds, ["v2"]);
  assert.equal((await post("stations-skipped", true)).status, 200);
  assert.equal((await row("stations-skipped")).stage, "accepted");
  assert.equal((await row("stations-skipped")).verifyCompletedSteps, "[]", "confirmation cannot invent execution evidence");

  await make("stations-none");
  await missing("stations-none", ["v1", "v2"]);
  await make("stations-unnamed", { verifyRounds: 3 });
  await missing("stations-unnamed", ["v2"]);
  await make("stations-last-only", { verifyRounds: 1, reviewStep: "v2", verifyStationRounds: 1 });
  await missing("stations-last-only", ["v1"]);
  await make("stations-switched", { verifyRounds: 1, reviewStep: "v2", verifyStationRounds: 0 });
  await missing("stations-switched", ["v1", "v2"]);

  // 独立审查任务也按站归属；只建行但没会话不能算执行。
  await make("stations-legacy");
  for (const [id, reviewStep] of [["stations-old-first", null], ["stations-old-second", "v2"]] as const) {
    await make(id, { reviewOf: "stations-legacy", reviewStep, workflow: null });
  }
  await missing("stations-legacy", ["v1", "v2"]);
  const session = (id: string) => db.insert(sessions).values({ id: `${id}-session`, taskId: id,
    role: "single", agentType: "codex", executor: "codex", startedAt: at, endedAt: at });
  await session("stations-old-first");
  await missing("stations-legacy", ["v2"]);
  await session("stations-old-second");
  assert.equal(await check("stations-legacy"), null);

  // 真实收轮写记录，跨站及重复结算后仍能证明两站都跑过。
  await make("stations-finished", { workflowAt: "v1", reviewStep: "v1", verifyRound: 1, stage: "verified" });
  await handleTaskSettlement("stations-finished", "done", false, true);
  assert.equal((await row("stations-finished")).workflowAt, "h1");
  assert.deepEqual(JSON.parse((await row("stations-finished")).verifyCompletedSteps), ["v1"]);
  let dispatched = 0;
  const released = await acceptTask("stations-finished", "human", { startVerifyRound: async () => { dispatched++; } });
  assert.ok(released.accepted && released.kind === "gate_released");
  assert.equal(dispatched, 1);
  assert.equal((await row("stations-finished")).workflowAt, "v2");
  assert.notEqual((await row("stations-finished")).stage, "accepted");
  await db.update(tasks).set({ reviewStep: "v2", verifyStationRounds: 0, verifyRound: 2, stage: "verified" })
    .where(eq(tasks.id, "stations-finished"));
  await handleTaskSettlement("stations-finished", "done", false, true);
  await handleTaskSettlement("stations-finished", "done", false, true);
  assert.equal((await row("stations-finished")).verifyRounds, 2);
  assert.equal((await row("stations-finished")).workflowAt, "h2");
  assert.deepEqual(JSON.parse((await row("stations-finished")).verifyCompletedSteps), ["v1", "v2"]);
  await ensureSchema();
  assert.equal(await check("stations-finished"), null, "schema initialization preserves station history");
  assert.equal((await post("stations-finished")).status, 200, "all stations ran: no extra confirmation");

  // 升级前只存最后站的任务，换站时先持久保存它，避免旧记录被归零抹去。
  await make("stations-upgrade", { workflowAt: "v2", reviewStep: "v1", verifyStationRounds: 1, verifyRounds: 1 });
  await startVerifyRound("stations-upgrade", { agentType: "claude", reasoningEffort: "no-such-effort" });
  for (let i = 0; i < 200 && ((await row("stations-upgrade")).verifyRound || isTurnClaimed("stations-upgrade")); i++) await delay(20);
  assert.equal((await row("stations-upgrade")).verifyRound, null);
  assert.equal(isTurnClaimed("stations-upgrade"), false);
  assert.deepEqual(JSON.parse((await row("stations-upgrade")).verifyCompletedSteps), ["v1", "v2"]);
  assert.equal(await check("stations-upgrade"), null);

  // 在 throwaway 库上模拟旧 schema，确认启动 DDL 能补列且旧站记录仍可判读。
  await dbClient.execute("ALTER TABLE tasks DROP COLUMN verify_completed_steps");
  await ensureSchema();
  await missing("stations-last-only", ["v1"]);
  console.log("accept verification stations: missing-step HTTP/branch-plan/MCP data, legacy attribution, durable settlement, post-human dispatch and old-schema upgrade passed");
}
