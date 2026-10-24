import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { db, dbClient, ensureSchema, runs, schema, tasks, teardown, until } from "./monitors-fixture.js";
import { setupRegressionReviews } from "./regression-review-fixture.js";

const { occupyResumePrompt, takeResumePrompt, restoreResumePrompt } = await import("../src/task-resume-prompt.js");
const { setTaskQuestion } = await import("../src/task-question.js");
const { reconcileRegressionSettlements, regressionSettlementConclusion, completeRegressionSettlement } = await import("../src/regression-settlement.js");
const { pendingMessageRow, deliverPendingMessages } = await import("../src/pending-messages.js");
const { startFreeReview } = await import("../src/free-workflow.js");
const { replyToTask } = await import("../src/task-reply.js");
const { answerTask } = await import("../src/task-answer.js");
const { resumeOrRunTask } = await import("../src/task-resume.js");
const { claimQuestionAnswer, prepareQuestionRecord } = await import("../src/task-question-record.js");
const row = async (taskId: string) => (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!;
const api = new Hono();
api.post("/tasks/:id/reply", (context) => replyToTask(context, context.req.param("id")));
api.post("/tasks/:id/answer", (context) => answerTask(context, context.req.param("id")));
const post = (taskId: string, action: "reply" | "answer", body: object) => api.request(`/tasks/${taskId}/${action}`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});

assert.notEqual(process.env.ASH_ALLOW_REAL_AGENT, "1");
try {
  const { open } = await setupRegressionReviews();
  const columns = await dbClient.execute("PRAGMA table_info(tasks)");
  assert(columns.rows.some((column) => column.name === "wait_ownership"));
  for (const mode of ["preset", "legacy", "free", "accepted_merge"] as const) {
    const review = await open(mode);
    await occupyResumePrompt(review.ownerTaskId, "Borrowed reviewer checkpoint", false);
    const before = await row(review.ownerTaskId);
    const receipt = await takeResumePrompt(review.ownerTaskId, before.resumePrompt!, before.resumePromptGeneration);
    assert(receipt);
    await review.settle(false);
    runs.releaseTurn(review.ownerTaskId);
    assert.equal((await review.state()).settlement?.pending, false);
    assert((await row(review.ownerTaskId)).resumePromptGeneration > receipt.generation);
    assert.equal(await restoreResumePrompt(review.ownerTaskId, receipt), false);
    assert.equal((await row(review.ownerTaskId)).resumePrompt, null);
    console.log(`✓ ${mode}: terminal settlement invalidates a checkpoint even while its slot is borrowed`);
  }

  const detached = await open("preset");
  await setTaskQuestion({ taskId: detached.taskId, question: "Wait belonging to the old round" });
  await occupyResumePrompt(detached.taskId, "Checkpoint belonging to the old round", false);
  const slot = await row(detached.taskId);
  const detachedReceipt = await takeResumePrompt(detached.taskId, slot.resumePrompt!, slot.resumePromptGeneration);
  assert(detachedReceipt);
  await db.update(tasks).set({ status: "done", verifyRound: null, directionEpoch: slot.directionEpoch + 1 })
    .where(eq(tasks.id, detached.taskId));
  runs.releaseTurn(detached.taskId);
  const detachedExit = await regressionSettlementConclusion(detached.taskId, detached.directory,
    { outcome: "failed", round: detached.round, ownerTaskId: detached.taskId });
  assert(detachedExit);
  assert(await completeRegressionSettlement(detached.directory, detachedExit));
  assert.equal((await row(detached.taskId)).question, null);
  assert.equal(await restoreResumePrompt(detached.taskId, detachedReceipt), false);
  console.log("✓ a closed round revokes its stored waits even after the task stops advertising that round");

  const inflight = await open("free");
  await occupyResumePrompt(inflight.taskId, "Continue the review after its monitor finishes", false);
  await db.update(tasks).set({ status: "paused" }).where(eq(tasks.id, inflight.taskId));
  await inflight.settle(true);
  runs.releaseTurn(inflight.taskId);
  const before = await row(inflight.taskId);
  await db.delete(schema.scheduledMessages).where(eq(schema.scheduledMessages.taskId, inflight.taskId));
  const message = pendingMessageRow({ taskId: inflight.taskId, text: "Monitor finished", origin: `monitor:${inflight.monitor.id}`,
    turnSource: { role: "reviewer", review: { run: inflight.runId, round: inflight.round } } });
  await db.insert(schema.scheduledMessages).values(message);
  const transaction = db.transaction;
  let injected = false;
  db.transaction = async function (...args) {
    if (!injected && String(args[0]).includes("beginReviewContinuation")) {
      injected = true;
      throw new Error("ONCE_REVIEW_WAIT_HANDOFF_FAULT");
    }
    return transaction.apply(this, args);
  };
  try {
    await deliverPendingMessages(inflight.taskId);
    await until("failed review closes before failed-delivery restoration", async () => injected
      && !runs.isTurnClaimed(inflight.taskId) && (await inflight.state()).settlement?.pending === false);
  } finally { db.transaction = transaction; }
  await reconcileRegressionSettlements(inflight.taskId);
  assert.equal((await row(inflight.taskId)).resumePrompt, null);
  assert((await row(inflight.taskId)).resumePromptGeneration > before.resumePromptGeneration);
  assert.equal((await db.select().from(schema.scheduledMessages).where(eq(schema.scheduledMessages.id, message.id)))[0]!.checkpointTaken, null);
  const at = new Date().toISOString();
  await db.insert(schema.reviewerProfiles).values({ id: "wait-storage-reviewer", name: "wait storage reviewer",
    agentType: "codex", createdAt: at, updatedAt: at });
  await startFreeReview(inflight.taskId, { reviewerId: "wait-storage-reviewer", checkMode: "logic", retryLimit: 0 });
  await until("redispatched review finishes its test-only turn", () => !runs.isTurnClaimed(inflight.taskId));
  console.log("✓ real monitor delivery: startup failure cannot restore a terminated review's checkpoint or block redispatch");

  for (const missing of [false, true]) {
    const review = await open("free");
    await setTaskQuestion({ taskId: review.taskId, question: "Old reviewer question" });
    await occupyResumePrompt(review.taskId, "Old reviewer checkpoint", false);
    await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, review.taskId));
    await review.settle(true);
    runs.releaseTurn(review.taskId);
    const oldCheckpoint = await row(review.taskId);
    const oldReceipt = await takeResumePrompt(review.taskId, oldCheckpoint.resumePrompt!, oldCheckpoint.resumePromptGeneration);
    assert(oldReceipt);
    if (missing) await db.delete(schema.regressionEvidence).where(eq(schema.regressionEvidence.directory, review.directory));
    const previous = await row(review.taskId);
    assert.equal((await post(review.taskId, "reply", { text: "New ordinary implementation request" })).status, 202);
    await until("ordinary reply leaves its direction marker", async () => (await row(review.taskId)).directionEpoch > previous.directionEpoch
      && !runs.isTurnClaimed(review.taskId));
    await setTaskQuestion({ taskId: review.taskId, question: "New ordinary question" });
    await occupyResumePrompt(review.taskId, "New ordinary checkpoint", false);
    const written = await row(review.taskId);
    assert.equal(written.waitOwnership?.question?.origin.kind, "ordinary");
    assert.equal(written.waitOwnership?.checkpoint?.origin.kind, "ordinary");
    const newReceipt = await takeResumePrompt(review.taskId, written.resumePrompt!, written.resumePromptGeneration);
    assert(newReceipt);
    await reconcileRegressionSettlements(review.taskId);
    const after = await row(review.taskId);
    assert.equal(after.question, written.question);
    assert.equal(after.resumePrompt, null);
    assert.equal(after.resumePromptGeneration, written.resumePromptGeneration);
    assert.equal((await review.state()).settlement?.pending, false);
    assert.equal(await restoreResumePrompt(review.taskId, oldReceipt), false);
    assert.equal(await restoreResumePrompt(review.taskId, newReceipt), true);
    assert.equal((await row(review.taskId)).resumePrompt, written.resumePrompt);
    console.log(`✓ evidence ${missing ? "missing" : "present"}: independent slot ownership preserves newer ordinary waits`);
  }

  for (const missing of [false, true]) {
    const closed = await open("free");
    await closed.settle(false);
    runs.releaseTurn(closed.taskId);
    await db.update(tasks).set({ status: "done", waitOwnership: null, question: "Already-closed legacy question",
      resumePrompt: "Already-closed legacy checkpoint" }).where(eq(tasks.id, closed.taskId));
    if (missing) await db.delete(schema.regressionEvidence).where(eq(schema.regressionEvidence.directory, closed.directory));
    const epoch = (await row(closed.taskId)).directionEpoch;
    const slot = await row(closed.taskId);
    assert.equal(await takeResumePrompt(closed.taskId, slot.resumePrompt!, slot.resumePromptGeneration), null);
    assert.equal((await post(closed.taskId, "answer", { answer: "Must not become ordinary input" })).status, 409);
    assert.equal((await row(closed.taskId)).question, null);
    assert.equal((await row(closed.taskId)).resumePrompt, null);
    assert.equal((await row(closed.taskId)).directionEpoch, epoch);
    const empty = await row(closed.taskId);
    await db.update(tasks).set({ waitOwnership: null }).where(eq(tasks.id, closed.taskId));
    assert.equal(await restoreResumePrompt(closed.taskId, {
      text: "Unknown in-flight legacy checkpoint", auto: false, generation: empty.resumePromptGeneration,
    }), false);
    console.log(`✓ already-closed legacy waits (${missing ? "missing evidence" : "saved receipt"}) are quarantined, never ordinary answers`);
  }

  for (const mode of ["preset", "legacy", "free", "accepted_merge"] as const) {
    const unknown = await open(mode);
    await db.update(tasks).set({ status: "paused", waitOwnership: null, question: "Unknown pre-upgrade live question" })
      .where(eq(tasks.id, unknown.ownerTaskId));
    await unknown.settle(true);
    runs.releaseTurn(unknown.ownerTaskId);
    assert.equal((await unknown.state()).settlement?.pending, false);
    assert.equal((await row(unknown.ownerTaskId)).question, null);
    console.log(`✓ ${mode}: an unknown wait cannot protect a round merely because its target direction is still valid`);
  }

  for (const mode of ["preset", "legacy", "free", "accepted_merge"] as const) {
    const unknown = await open(mode);
    const previous = await row(unknown.ownerTaskId);
    await db.update(tasks).set({ status: "paused", waitOwnership: null, resumePrompt: "Unknown pre-upgrade checkpoint" })
      .where(eq(tasks.id, unknown.ownerTaskId));
    runs.releaseTurn(unknown.ownerTaskId);
    await resumeOrRunTask(unknown.ownerTaskId, { reason: "run" });
    assert.equal((await row(unknown.ownerTaskId)).resumePrompt, null);
    assert.equal((await row(unknown.ownerTaskId)).directionEpoch, previous.directionEpoch);
    assert.equal((await unknown.state()).settlement?.pending, false);
    assert.equal(runs.isTurnClaimed(unknown.ownerTaskId), false);
    console.log(`✓ ${mode}: manual resume rejects an unknown checkpoint before starting another review turn`);
  }

  for (const mode of ["preset", "legacy", "free", "accepted_merge"] as const) {
    const review = await open(mode);
    const previous = await row(review.ownerTaskId);
    await db.update(schema.regressionEvidence).set({ continuation: { phase: "waiting" } })
      .where(eq(schema.regressionEvidence.directory, review.directory));
    await db.update(tasks).set({ status: "done", question: "Pre-upgrade unknown question", resumePrompt: "Pre-upgrade unknown checkpoint",
      waitOwnership: null }).where(eq(tasks.id, review.ownerTaskId));
    await db.update(tasks).set({ directionEpoch: (await row(review.taskId)).directionEpoch + 1 }).where(eq(tasks.id, review.taskId));
    runs.releaseTurn(review.ownerTaskId);
    await reconcileRegressionSettlements(review.ownerTaskId);
    const expired = await row(review.ownerTaskId);
    assert.equal(expired.question, null);
    assert.equal(expired.resumePrompt, null);
    assert(expired.resumePromptGeneration > previous.resumePromptGeneration);
    assert.equal((await review.state()).settlement?.pending, false);
    assert.equal((await post(review.ownerTaskId, "answer", { answer: "Do not start an ordinary turn" })).status, 409);
    assert.equal((await row(review.ownerTaskId)).directionEpoch, expired.directionEpoch);
    console.log(`✓ ${mode}: pre-upgrade unknown waits expire without becoming ordinary answers`);
  }

  const changed = await open("free");
  await setTaskQuestion({ taskId: changed.taskId, question: "Identical text" });
  const first = await row(changed.taskId);
  await setTaskQuestion({ taskId: changed.taskId, question: "Identical text" });
  const second = await row(changed.taskId);
  assert.notEqual(first.waitOwnership?.question?.occupancy, second.waitOwnership?.question?.occupancy);
  assert.equal(await claimQuestionAnswer(first, prepareQuestionRecord(first, "Stale answer", {})), false);
  await ensureSchema();
  assert.deepEqual((await row(changed.taskId)).waitOwnership, second.waitOwnership);
  runs.releaseTurn(changed.taskId);
  console.log("✓ question occupancy survives schema re-bootstrap and rejects an answer to a replaced same-text question");
} finally { await teardown(); }
