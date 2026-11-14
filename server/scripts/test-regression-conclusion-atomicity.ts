import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { db, root, schema, tasks, teardown } from "./monitors-fixture.js";
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
      server: "ash", tool: "report_stage", arguments: { taskId: review.taskId, stage: "verified" },
      result: null, error: { message: "Transport closed" }, status: "failed" } }) + "\n");
    const task = (await db.select().from(tasks).where(eq(tasks.id, review.taskId)))[0]!;
    await db.update(tasks).set({ activeDirectionToken: "new-direction" }).where(eq(tasks.id, review.taskId));
    if (free) await assert.rejects(reportFreeReviewConclusion(review.taskId, "verified",
      { expectedTask: task }), /方向身份/);
    else await assert.rejects(reportTaskStage(review.taskId, "verified",
      { expectedTask: task }), /方向身份/);
    assert.equal(await review.conclusion(), before);
    assert.deepEqual(events, [], `${mode}: rejected report emits no event or timeline`);
    await db.update(tasks).set({ activeDirectionToken: null }).where(eq(tasks.id, review.taskId));
    const staleEpoch = { ...task, directionEpoch: task.directionEpoch - 1 };
    if (free) await assert.rejects(reportFreeReviewConclusion(review.taskId, "verified",
      { expectedTask: staleEpoch }), /方向身份/);
    else await assert.rejects(reportTaskStage(review.taskId, "verified",
      { expectedTask: staleEpoch }), /方向身份/);
    if (mode === "legacy") {
      const source = (await db.select().from(tasks).where(eq(tasks.id, review.ownerTaskId)))[0]!;
      await db.update(tasks).set({ activeDirectionToken: "new-review-direction" }).where(eq(tasks.id, review.ownerTaskId));
      await assert.rejects(reportTaskStage(review.taskId, "verified", { expectedTask: task,
        sourceTaskId: source.id, expectedSourceTask: source }), /方向身份/);
      await db.update(tasks).set({ activeDirectionToken: null }).where(eq(tasks.id, review.ownerTaskId));
    }
    const checked = await checkRegressionConclusion(review.taskId, review.directory, "verified");
    await db.update(schema.regressionEvidence).set({ generation: "changed-generation" })
      .where(eq(schema.regressionEvidence.directory, review.directory));
    let attempted = false;
    await assert.rejects(commitRegressionConclusion(checked, async () => { attempted = true; }), /代次/);
    assert.equal(attempted, false);
    await db.update(schema.regressionEvidence).set({ generation: review.generation })
      .where(eq(schema.regressionEvidence.directory, review.directory));
    assert.equal(await replayUndeliveredMcpCalls({ taskId: review.taskId, sessId: sessionId,
      turnStart: replayAt, agentType: "codex" }), 1, `${mode}: replay commits the undelivered conclusion`);
    assert.equal(await review.conclusion(), "verified");
    unsubscribe();
    const concurrent = await Promise.all([review.stage(), review.stage()]);
    assert(concurrent.every((response) => response.status === 200 || response.status === 409));
    assert(concurrent.some((response) => response.status === 200));
    await Promise.all([review.settle(true), review.settle(true)]);
    assert.equal(await review.conclusion(), "verified", `${mode}: successful retry is not downgraded`);
    assert.equal((await review.state()).settlement?.pending, false);
    if (mode === "preset") assert.equal((await db.select().from(tasks).where(eq(tasks.id, review.taskId)))[0]!.verifyRounds, 1);
    console.log(`✓ ${mode}: no phantom events, direction/generation guards, replay, retry and settlement`);
  }
} finally { await teardown(); }
