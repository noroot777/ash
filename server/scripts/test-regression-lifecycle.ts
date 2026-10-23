import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { makeStep } from "@ash/shared/workflow";
import { db, makeTask, runs, schema, tasks, teardown } from "./monitors-fixture.js";
import { setupRegression } from "./regression-fixture.js";

const { regressionEvidenceReference } = await import("../src/regression-checks.js");
const { verifyReminderFor, reviewReminderFor } = await import("../src/review-prompts.js");
const { freeReviewPrompt } = await import("../src/free-review-prompts.js");
const { freeReviewReminder, handleFreeWorkflowSettlement, reportFreeReviewConclusion } = await import("../src/free-workflow.js");
const { freeReviewEvidenceDir } = await import("../src/free-review-files.js");
const { mountTaskStageRoutes } = await import("../src/task-stage.js");
const { handleTaskSettlement } = await import("../src/review.js");
const { replayUndeliveredMcpCalls } = await import("../src/mcp-handoff.js");
const { detachedPathsFor } = await import("../src/executors/detached.js");

try {
  const { taskId, task, repo, evidenceDir, manifest, run } = await setupRegression();
  await run("node -e \"console.log('passed')\"");
  await regressionEvidenceReference(task, repo, evidenceDir);
  const oldManifest = { ...manifest(), protocol: 1, records: manifest().records.map((record) => ({ ...record, reusable: true })) };
  const stale = (directory: string) => {
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "regression-evidence.json"), JSON.stringify(oldManifest));
  };
  const refreshed = (directory: string) => {
    assert.equal(manifest(directory).protocol, 2);
    assert.equal(manifest(directory).records.length, 1);
    assert.equal(manifest(directory).records[0]!.reusable, false);
  };

  writeFileSync(join(repo, "code.txt"), "changed after prompt");
  stale(evidenceDir);
  assert.match(await verifyReminderFor(taskId, 1), /regression-evidence\.json.*禁止自动复用/);
  refreshed(evidenceDir);
  stale(evidenceDir);
  assert.match(await reviewReminderFor({ id: "legacy", reviewOf: taskId, reviewRound: 1 }), /regression-evidence\.json/);
  refreshed(evidenceDir);

  await db.update(tasks).set({ workflowMode: "preset", verifyRound: 1 }).where(eq(tasks.id, taskId));
  const api = new Hono();
  mountTaskStageRoutes(api);
  const stage = () => api.request(`/tasks/${taskId}/stage`, {
    method: "POST", headers: { "content-type": "application/json", "x-ash-turn-token": `turn-${taskId}` },
    body: JSON.stringify({ stage: "verified" }),
  });
  stale(evidenceDir);
  const refused = await stage();
  assert.equal(refused.status, 409);
  assert.match((await refused.json() as { error: string }).error, /旧回归复用资格已撤销/);
  assert.notEqual((await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!.stage, "verified");
  refreshed(evidenceDir);
  assert.equal((await stage()).status, 200, "重新读取并独立验证后的结论仍可上报，不能禁用整个验证功能");

  const legacyId = await makeTask();
  await db.update(tasks).set({ reviewOf: taskId, reviewRound: 2 }).where(eq(tasks.id, legacyId));
  await db.update(tasks).set({ verifyRound: null, stage: "verifying" }).where(eq(tasks.id, taskId));
  const legacyDir = join(evidenceDir, "..", "round-2");
  stale(legacyDir);
  assert.equal((await stage()).status, 409, "历史独立审查的结论入口同样重新核验");
  refreshed(legacyDir);
  const turnStart = new Date().toISOString();
  const { out } = detachedPathsFor(join(evidenceDir, "..", ".."), "proof-session", turnStart);
  writeFileSync(out, JSON.stringify({ type: "item.completed", item: {
    id: "lost-conclusion", type: "mcp_tool_call", server: "ash", tool: "report_stage",
    arguments: { taskId, stage: "verified" }, result: null, error: { message: "Transport closed" }, status: "failed",
  } }) + "\n");
  stale(legacyDir);
  assert.equal(await replayUndeliveredMcpCalls({ taskId, sessId: "proof-session", turnStart, agentType: "codex" }), 0,
    "MCP 补捞不能绕过结论消费的输入核验");
  refreshed(legacyDir);

  await db.update(tasks).set({ verifyRound: 1, stage: "verified", workflowAt: "verify",
    workflow: JSON.stringify({ workspace: "shared", steps: [makeStep("run", "run"), makeStep("verify", "verify")] }),
  }).where(eq(tasks.id, taskId));
  stale(evidenceDir);
  await handleTaskSettlement(taskId, "done", false, true);
  assert.equal((await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!.stage, "verify_failed",
    "在结论上报与实际结算之间出现旧授权，也不能用它推进验证通过");
  refreshed(evidenceDir);

  await db.update(tasks).set({ workflowMode: "free", workflow: null, workflowAt: null, verifyRound: null, stage: null }).where(eq(tasks.id, taskId));
  const now = new Date().toISOString();
  await db.insert(schema.freeReviewRuns).values({
    id: "proof-review", taskId, reviewerName: "reviewer", agentType: "codex", checkMode: "logic",
    status: "reviewing", retryLimit: 0, currentRound: 1, createdAt: now, updatedAt: now,
  });
  await db.insert(schema.freeReviewRounds).values({ id: "proof-round", runId: "proof-review", round: 1, status: "reviewing", startedAt: now });
  const reviewRun = (await db.select().from(schema.freeReviewRuns).where(eq(schema.freeReviewRuns.id, "proof-review")))[0]!;
  const freeDir = freeReviewEvidenceDir(taskId, reviewRun.id, 1);
  await freeReviewPrompt(task, reviewRun, 1, repo);
  stale(freeDir);
  assert.match(await freeReviewReminder(taskId), /regression-evidence\.json/);
  refreshed(freeDir);
  writeFileSync(join(freeDir, "report.md"), "输入证明及验证结果已检查。\n");
  runs.releaseTurn(taskId);
  assert.equal(runs.claimTurn(taskId, "reviewer", { run: reviewRun.id, round: 1 }), true);
  stale(freeDir);
  await assert.rejects(reportFreeReviewConclusion(taskId, "verified"), /旧回归复用资格已撤销/);
  refreshed(freeDir);
  await reportFreeReviewConclusion(taskId, "verified");
  stale(freeDir);
  await handleFreeWorkflowSettlement(taskId, "done", false, true, "reviewer");
  const settled = (await db.select().from(schema.freeReviewRounds).where(eq(schema.freeReviewRounds.id, "proof-round")))[0]!;
  assert.equal(settled.conclusion, "verify_failed");
  assert.equal(settled.status, "failed", "自由审查消费结论时再次撤销旧授权");
  refreshed(freeDir);
  console.log("✓ regression evidence lifecycle: free/preset/legacy resume, real stage endpoint and both conclusion settlement paths");
} finally {
  await teardown();
}
