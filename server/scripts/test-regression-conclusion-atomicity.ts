import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { db, dbClient, root, schema, tasks, teardown } from "./monitors-fixture.js";
import { setupRegressionReviews, type ReviewMode } from "./regression-review-fixture.js";

const { bus } = await import("../src/bus.js");
const { reportTaskStage } = await import("../src/task-stage.js");
const { reportFreeReviewConclusion } = await import("../src/free-workflow.js");
const { commitRegressionConclusion } = await import("../src/regression-conclusion-commit.js");
const { checkRegressionConclusion } = await import("../src/regression-evidence-lifecycle.js");
const { replayUndeliveredMcpCalls } = await import("../src/mcp-handoff.js");
const { detachedPathsFor } = await import("../src/executors/detached.js");

try {
  const { open } = await setupRegressionReviews();
  for (const mode of ["free", "accepted_merge", "preset", "legacy"] as ReviewMode[]) {
    const review = await open(mode);
    const free = mode === "free" || mode === "accepted_merge";
    const events: string[] = [];
    const unsubscribe = bus.subscribe((event) => {
      if (event.taskId === review.taskId && (event.type === "task.stage" || event.type === "task.review"
        || (event.type === "agent.event" && event.event.kind === "system" && event.event.text.includes("验收阶段更新")))) {
        events.push(event.type);
      }
    });
    const before = await review.conclusion();
    const replayAt = new Date().toISOString(), sessionId = `atomic-${mode}`;
    await db.insert(schema.sessions).values({ id: sessionId, taskId: review.ownerTaskId, role: free ? "reviewer" : "single",
      agentType: "codex", executor: "test", cwd: root, startedAt: replayAt });
    const { out } = detachedPathsFor(join(root, "runs", review.taskId), sessionId, replayAt);
    writeFileSync(out, JSON.stringify({ type: "item.completed", item: { id: sessionId, type: "mcp_tool_call",
      server: "ash", tool: "report_stage", arguments: { taskId: review.taskId, stage: "verified", verificationBasis: review.basis },
      result: null, error: { message: "Transport closed" }, status: "failed" } }) + "\n");
    await dbClient.execute("CREATE TEMP TRIGGER basis_fault BEFORE UPDATE OF accepted_basis ON regression_evidence BEGIN SELECT RAISE(ABORT,'INJECTED_BASIS_WRITE_FAILURE'); END");
    try {
      const response = await review.stage();
      assert.equal(response.status, 409);
      assert.match((await response.json() as { error: string }).error, /INJECTED_BASIS_WRITE_FAILURE/);
      assert.equal(await review.conclusion(), before, `${mode}: HTTP failure rolls back conclusion`);
      assert.equal((await review.state()).acceptedBasis, null);
      assert.deepEqual(events, [], `${mode}: no event or timeline before atomic commit`);
      assert.equal(await replayUndeliveredMcpCalls({ taskId: review.taskId, sessId: sessionId,
        turnStart: replayAt, agentType: "codex" }), 0);
      assert.equal(await review.conclusion(), before, `${mode}: replay failure rolls back conclusion`);
      assert.equal((await review.state()).acceptedBasis, null);
      assert.deepEqual(events, []);
    } finally { await dbClient.execute("DROP TRIGGER basis_fault"); }
    const task = (await db.select().from(tasks).where(eq(tasks.id, review.taskId)))[0]!;
    await db.update(tasks).set({ activeDirectionToken: "new-direction" }).where(eq(tasks.id, review.taskId));
    if (free) await assert.rejects(reportFreeReviewConclusion(review.taskId, "verified",
      { verificationBasis: review.basis, expectedTask: task }), /方向身份/);
    else await assert.rejects(reportTaskStage(review.taskId, "verified",
      { verificationBasis: review.basis, expectedTask: task }), /方向身份/);
    assert.equal(await review.conclusion(), before);
    assert.equal((await review.state()).acceptedBasis, null);
    await db.update(tasks).set({ activeDirectionToken: null }).where(eq(tasks.id, review.taskId));
    const staleEpoch = { ...task, directionEpoch: task.directionEpoch - 1 };
    if (free) await assert.rejects(reportFreeReviewConclusion(review.taskId, "verified",
      { verificationBasis: review.basis, expectedTask: staleEpoch }), /方向身份/);
    else await assert.rejects(reportTaskStage(review.taskId, "verified",
      { verificationBasis: review.basis, expectedTask: staleEpoch }), /方向身份/);
    if (mode === "legacy") {
      const source = (await db.select().from(tasks).where(eq(tasks.id, review.ownerTaskId)))[0]!;
      await db.update(tasks).set({ activeDirectionToken: "new-review-direction" }).where(eq(tasks.id, review.ownerTaskId));
      await assert.rejects(reportTaskStage(review.taskId, "verified", { verificationBasis: review.basis, expectedTask: task,
        sourceTaskId: source.id, expectedSourceTask: source }), /方向身份/);
      await db.update(tasks).set({ activeDirectionToken: null }).where(eq(tasks.id, review.ownerTaskId));
    }
    const checked = await checkRegressionConclusion(review.taskId, review.directory, "verified", mode === "accepted_merge", review.basis);
    await db.update(schema.regressionEvidence).set({ generation: "changed-generation" })
      .where(eq(schema.regressionEvidence.directory, review.directory));
    let attempted = false;
    await assert.rejects(commitRegressionConclusion(checked, async () => { attempted = true; }), /代次/);
    assert.equal(attempted, false);
    await db.update(schema.regressionEvidence).set({ generation: review.basis.generation })
      .where(eq(schema.regressionEvidence.directory, review.directory));
    assert.equal(await replayUndeliveredMcpCalls({ taskId: review.taskId, sessId: sessionId,
      turnStart: replayAt, agentType: "codex" }), 1, `${mode}: retry atomically commits original proof`);
    assert.equal(await review.conclusion(), "verified");
    assert.deepEqual((await review.state()).acceptedBasis?.monitors.map((monitor) => monitor.id), [review.monitor.id]);
    const acceptedBasis = (await review.state()).acceptedBasis;
    events.length = 0;
    await dbClient.execute("CREATE TEMP TRIGGER basis_fault BEFORE UPDATE OF accepted_basis ON regression_evidence BEGIN SELECT RAISE(ABORT,'INJECTED_BASIS_WRITE_FAILURE'); END");
    try {
      await assert.rejects(free ? reportFreeReviewConclusion(review.taskId, "verify_failed")
        : reportTaskStage(review.taskId, "verify_failed"), /INJECTED_BASIS_WRITE_FAILURE/);
      assert.equal(await review.conclusion(), "verified", "failed replacement retains previously committed pair");
      assert.deepEqual((await review.state()).acceptedBasis, acceptedBasis);
      assert.deepEqual(events, []);
    } finally { await dbClient.execute("DROP TRIGGER basis_fault"); }
    unsubscribe();
    const concurrent = await Promise.all([review.stage(), review.stage()]);
    assert(concurrent.every((response) => response.status === 200 || response.status === 409));
    assert(concurrent.some((response) => response.status === 200));
    await Promise.all([review.settle(true), review.settle(true)]);
    assert.equal(await review.conclusion(), "verified", `${mode}: successful retry is not downgraded`);
    assert.equal((await review.state()).settlement?.pending, false);
    if (mode === "preset") assert.equal((await db.select().from(tasks).where(eq(tasks.id, review.taskId)))[0]!.verifyRounds, 1);
    console.log(`✓ ${mode}: atomic HTTP/replay rollback, no phantom events, direction/generation guards, retry and settlement`);
  }
} finally { await teardown(); }
