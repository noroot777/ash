import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { db, dbClient, runs, schema, tasks, teardown, until } from "./monitors-fixture.js";
import { setupRegressionReviews } from "./regression-review-fixture.js";

const { reconcileRegressionSettlements, regressionSettlementConclusion } = await import("../src/regression-settlement.js");
const { setTaskQuestion } = await import("../src/task-question.js");
const { occupyResumePrompt } = await import("../src/task-resume-prompt.js");
const { answerTask } = await import("../src/task-answer.js");
const { replyToTask } = await import("../src/task-reply.js");
const { startVerifyRound } = await import("../src/review.js");
const row = async (taskId: string) => (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!;
const api = new Hono();
api.post("/tasks/:id/answer", (context) => answerTask(context, context.req.param("id")));
api.post("/tasks/:id/reply", (context) => replyToTask(context, context.req.param("id")));
const answer = (taskId: string) => api.request(`/tasks/${taskId}/answer`, { method: "POST",
  headers: { "content-type": "application/json" }, body: JSON.stringify({ answer: "Answer the obsolete question" }) });
const question = { question: "Review question", options: ["Original option"],
  items: [{ question: "Original item", options: ["Original option"] }] };

assert.notEqual(process.env.ASH_ALLOW_REAL_AGENT, "1");
try {
  const { open } = await setupRegressionReviews();
  for (const mode of ["preset", "legacy", "free", "accepted_merge"] as const) {
    const review = await open(mode);
    await setTaskQuestion({ taskId: review.ownerTaskId, ...question });
    await db.update(schema.regressionEvidence).set({ targetIdentity: null })
      .where(eq(schema.regressionEvidence.directory, review.directory));
    await db.update(tasks).set({ status: "paused" }).where(eq(tasks.id, review.ownerTaskId));
    await review.settle(true);
    runs.releaseTurn(review.ownerTaskId);
    assert.equal((await review.state()).settlement?.pending, false);
    assert.equal((await row(review.ownerTaskId)).question, null);
    if (mode === "legacy") assert.equal((await row(review.ownerTaskId)).status, "done");
    console.log(`✓ ${mode}: normal exit cannot preserve an unprovable historical question indefinitely`);
  }

  for (const mode of ["preset", "legacy", "free", "accepted_merge"] as const) {
    for (const missing of ["identity", "entire-state", "neither"] as const) {
      const review = await open(mode);
      await setTaskQuestion({ taskId: review.ownerTaskId, ...question });
      await occupyResumePrompt(review.ownerTaskId, "Original checkpoint", false);
      if (missing === "identity") await db.update(schema.regressionEvidence)
        .set({ targetIdentity: null, continuation: { phase: "waiting" } })
        .where(eq(schema.regressionEvidence.directory, review.directory));
      if (missing === "entire-state") await db.delete(schema.regressionEvidence)
        .where(eq(schema.regressionEvidence.directory, review.directory));
      await db.update(tasks).set({ status: "failed" }).where(eq(tasks.id, review.ownerTaskId));
      await review.settle(false);
      runs.releaseTurn(review.ownerTaskId);
      await reconcileRegressionSettlements(review.ownerTaskId);
      const owner = await row(review.ownerTaskId);
      assert.equal(owner.question, null);
      assert.equal(owner.questionOptions, null);
      assert.equal(owner.questionItems, null);
      assert.equal(owner.resumePrompt, null);
      assert.equal((await review.state()).settlement?.pending, false);
      assert.equal((await review.state()).finalization?.completed, true);
      const pendingBefore = await db.select().from(schema.scheduledMessages)
        .where(eq(schema.scheduledMessages.taskId, review.ownerTaskId));
      assert.equal((await answer(review.ownerTaskId)).status, 409);
      assert.deepEqual(await row(review.ownerTaskId), owner);
      assert.deepEqual(await db.select().from(schema.scheduledMessages)
        .where(eq(schema.scheduledMessages.taskId, review.ownerTaskId)), pendingBefore);
      if (mode === "preset") {
        assert.equal((await startVerifyRound(review.taskId)).round, 2);
        await until("new verification releases its test-only turn", async () =>
          !runs.isTurnClaimed(review.taskId) && (await row(review.taskId)).verifyRound === null);
      }
      console.log(`✓ ${mode} ${missing}: direct abnormal settlement atomically expires its question and checkpoint`);
    }
  }

  for (const mode of ["preset", "legacy", "free", "accepted_merge"] as const) {
    const review = await open(mode);
    await setTaskQuestion({ taskId: review.ownerTaskId, ...question });
    await occupyResumePrompt(review.ownerTaskId, "Original checkpoint", false);
    await db.update(tasks).set({ status: "paused" }).where(eq(tasks.id, review.ownerTaskId));
    await review.settle(true);
    assert.equal((await review.state()).settlement, null);
    runs.releaseTurn(review.ownerTaskId);
    await db.update(tasks).set({ directionEpoch: (await row(review.taskId)).directionEpoch + 1 })
      .where(eq(tasks.id, review.taskId));
    if (mode === "legacy") {
      await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, review.taskId));
      await setTaskQuestion({ taskId: review.ownerTaskId, ...question });
    }
    await reconcileRegressionSettlements(review.ownerTaskId);
    assert.equal((await review.state()).settlement?.pending, false);
    assert.equal((await row(review.ownerTaskId)).question, null);
    assert.equal((await row(review.ownerTaskId)).resumePrompt, null);
    assert.equal((await answer(review.ownerTaskId)).status, 409);
    if (mode === "legacy") {
      assert.equal((await row(review.ownerTaskId)).status, "failed");
      assert.equal((await startVerifyRound(review.taskId)).round, 2);
      await until("legacy terminal slot no longer blocks new verification", async () =>
        !runs.isTurnClaimed(review.taskId) && (await row(review.taskId)).verifyRound === null);
    }
    console.log(`✓ ${mode}: a superseded waiting round closes instead of preserving an impossible continuation`);
  }

  for (const newerWait of [false, true]) {
    const review = await open("free");
    await setTaskQuestion({ taskId: review.taskId, ...question });
    await occupyResumePrompt(review.taskId, "Same checkpoint text", false);
    await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, review.taskId));
    await review.settle(true);
    runs.releaseTurn(review.taskId);
    const before = await row(review.taskId);
    const reply = await api.request(`/tasks/${review.taskId}/reply`, { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "A new implementation direction" }) });
    assert.equal(reply.status, 202);
    await until("ordinary reply starts a new direction and releases its test-only turn", async () =>
      (await row(review.taskId)).directionEpoch > before.directionEpoch && !runs.isTurnClaimed(review.taskId));
    if (newerWait) {
      await setTaskQuestion({ taskId: review.taskId, ...question });
      await occupyResumePrompt(review.taskId, "Same checkpoint text", false);
      const newer = await row(review.taskId);
      await reconcileRegressionSettlements(review.taskId);
      assert.equal((await row(review.taskId)).question, newer.question);
      assert.equal((await row(review.taskId)).questionOptions, newer.questionOptions);
      assert.equal((await row(review.taskId)).questionItems, newer.questionItems);
      assert.equal((await row(review.taskId)).resumePrompt, newer.resumePrompt);
      assert.equal((await row(review.taskId)).resumePromptGeneration, newer.resumePromptGeneration);
    } else {
      assert.equal((await answer(review.taskId)).status, 409);
      assert.equal((await row(review.taskId)).question, null, "the answer rejection also closes its obsolete waiting round");
      assert.equal((await row(review.taskId)).resumePrompt, null);
      assert.equal((await answer(review.taskId)).status, 409);
    }
    const run = (await db.select().from(schema.freeReviewRuns).where(eq(schema.freeReviewRuns.id, review.runId)))[0]!;
    assert.equal(run.status, "failed");
    assert.equal((await review.state()).settlement?.pending, false);
    console.log(`✓ real reply/answer routes: stale review closes; newer same-text waiting fields ${newerWait ? "survive" : "are not fabricated"}`);
  }

  const pending = await open("free");
  await setTaskQuestion({ taskId: pending.taskId, ...question });
  await occupyResumePrompt(pending.taskId, "Original checkpoint", false);
  await regressionSettlementConclusion(pending.taskId, pending.directory, { outcome: "failed", round: pending.round,
    ownerTaskId: pending.taskId, freeRoundId: pending.roundId });
  await db.update(tasks).set({ status: "paused", directionEpoch: (await row(pending.taskId)).directionEpoch + 1 })
    .where(eq(tasks.id, pending.taskId));
  await setTaskQuestion({ taskId: pending.taskId, ...question });
  await pending.settle(false);
  runs.releaseTurn(pending.taskId);
  assert.equal((await row(pending.taskId)).question, question.question);
  assert.equal((await row(pending.taskId)).resumePrompt, null);
  assert.equal((await pending.state()).settlement?.pending, false);
  console.log("✓ a new same-text question written after the exit receipt is not erased by old terminal cleanup");

  const atomic = await open("preset");
  await setTaskQuestion({ taskId: atomic.taskId, ...question });
  await occupyResumePrompt(atomic.taskId, "Original checkpoint", false);
  await db.update(tasks).set({ status: "paused" }).where(eq(tasks.id, atomic.taskId));
  const before = await row(atomic.taskId);
  await dbClient.execute(`CREATE TEMP TRIGGER wait_clear_fault BEFORE UPDATE OF question ON tasks
    WHEN OLD.id='${atomic.taskId}' AND NEW.question IS NULL BEGIN SELECT RAISE(ABORT,'WAIT_CLEAR_FAULT'); END`);
  try { await assert.rejects(atomic.settle(false), /WAIT_CLEAR_FAULT/); }
  finally { await dbClient.execute("DROP TRIGGER wait_clear_fault"); runs.releaseTurn(atomic.taskId); }
  assert.equal((await row(atomic.taskId)).verifyRound, before.verifyRound);
  assert.equal((await row(atomic.taskId)).verifyRounds, before.verifyRounds);
  assert.equal((await row(atomic.taskId)).stage, before.stage);
  assert.equal((await row(atomic.taskId)).question, before.question);
  assert.equal((await row(atomic.taskId)).resumePrompt, before.resumePrompt);
  assert.equal((await atomic.state()).settlement?.pending, true);
  await reconcileRegressionSettlements(atomic.taskId);
  assert.equal((await row(atomic.taskId)).question, null);
  assert.equal((await row(atomic.taskId)).resumePrompt, null);
  assert.equal((await row(atomic.taskId)).verifyRound, null);
  assert.equal((await row(atomic.taskId)).verifyRounds, before.verifyRounds + 1);
  assert.equal((await atomic.state()).settlement?.pending, false);
  console.log("✓ direct terminal cleanup and round closure roll back together; the durable exit receipt retries successfully");
} finally { await teardown(); }
