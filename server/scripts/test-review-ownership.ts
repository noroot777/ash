import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { makeStep } from "@ash/shared/workflow";
import { db, dbClient, root, runs, schema, tasks, teardown, until } from "./monitors-fixture.js";
import { setupRegressionReviews } from "./regression-review-fixture.js";
import { testReviewAcceptanceOwnership } from "./test-review-ownership-acceptance.js";

const { reconcileRegressionSettlements } = await import("../src/regression-settlement.js");
const { answerTask } = await import("../src/task-answer.js");
const { beginDelivery, deliveryOptions, deliveryVerdict, deliverPendingMessages, monitorWakeGuard } = await import("../src/pending-messages.js");
const { reviewDeliveryBlocked, reviewDeliveryFrom } = await import("../src/review-ownership.js");
const { beginReviewContinuation, commitReviewTurnDelivery, preserveReviewWait } = await import("../src/review-continuation.js");
const { directionIdentityCleared, turnDirectionStart } = await import("../src/task-direction-epoch.js");
const { continueTask } = await import("../src/orchestrator.js");
const { setTaskQuestion } = await import("../src/task-question.js");
const { occupyResumePrompt, takeResumePrompt } = await import("../src/task-resume-prompt.js");
const { resumeOrRunTask } = await import("../src/task-resume.js");
const { startVerifyRound } = await import("../src/review.js");
const { reviewRoundDir } = await import("../src/review-evidence.js");
const row = async (taskId: string) => (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!;
const messages = (taskId: string) => db.select().from(schema.scheduledMessages).where(eq(schema.scheduledMessages.taskId, taskId));
const clearMessages = (taskId: string) => db.delete(schema.scheduledMessages).where(eq(schema.scheduledMessages.taskId, taskId));
const api = new Hono();
assert.notEqual(process.env.ASH_ALLOW_REAL_AGENT, "1");
api.post("/tasks/:id/answer", (context) => answerTask(context, context.req.param("id")));

try {
  const { open } = await setupRegressionReviews();
  for (const mode of ["preset", "legacy"] as const) {
    const review = await open(mode);
    assert.equal((await review.stage()).status, 200);
    await dbClient.execute(`CREATE TEMP TRIGGER stale_fault BEFORE UPDATE OF stage ON tasks
      WHEN OLD.id='${review.taskId}' AND NEW.stage IS NULL BEGIN SELECT RAISE(ABORT,'STAGE_FAULT'); END`);
    try { await assert.rejects(review.settle(false), /STAGE_FAULT/); }
    finally { await dbClient.execute("DROP TRIGGER stale_fault"); }
    await clearMessages(review.ownerTaskId);
    runs.releaseTurn(review.ownerTaskId);
    await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, review.ownerTaskId));
    await db.update(tasks).set({ status: "running", stage: "verified", ...turnDirectionStart("new-turn", "new-direction") })
      .where(eq(tasks.id, review.taskId));
    if (mode === "legacy") assert(runs.claimTurn(review.taskId, "single"));
    const before = await row(review.taskId);
    await reconcileRegressionSettlements(review.ownerTaskId);
    if (mode === "preset") {
      assert.equal((await review.state()).settlement?.pending, true);
      await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, review.taskId));
      await reconcileRegressionSettlements(review.ownerTaskId);
    }
    const after = await row(review.taskId);
    assert.equal(after.stage, "verified");
    assert.equal(after.directionEpoch, before.directionEpoch);
    assert.equal(after.verifyRounds, before.verifyRounds + (mode === "preset" ? 1 : 0));
    assert.equal(after.verifyRound, null);
    assert.equal((await review.state()).settlement?.pending, false);
    assert.equal((await review.state()).finalization?.superseded, true);
    runs.releaseTurn(review.taskId);
    await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, review.taskId));
    console.log(`✓ ${mode}: old receipt closes only its own ledger, not a newer target direction`);
  }

  for (const missing of ["identity", "entire-state"] as const) {
    const review = await open("legacy");
    assert.equal((await review.stage()).status, 200);
    if (missing === "identity") await db.update(schema.regressionEvidence).set({ targetIdentity: null }).where(eq(schema.regressionEvidence.directory, review.directory));
    else await db.delete(schema.regressionEvidence).where(eq(schema.regressionEvidence.directory, review.directory));
    await review.settle(false);
    assert.equal((await row(review.taskId)).stage, "verified");
    assert.equal((await review.state()).settlement?.target, null);
    assert.equal((await review.state()).finalization?.superseded, true);
    runs.releaseTurn(review.ownerTaskId);
    console.log(`✓ historical ${missing}: recovery cannot sample a new target identity`);
  }

  for (const mode of ["preset", "legacy"] as const) {
    const review = await open(mode);
    const ready = join(root, `${mode}-ready`), release = join(root, `${mode}-release`), effect = join(root, `${mode}-effect`);
    const script = join(root, `${mode}-hold.cjs`);
    writeFileSync(script, `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(ready)},'ready');const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)}))clearInterval(timer)},10)`);
    const hold = { ...makeStep("command", "hold"), p: { cmd: `node ${JSON.stringify(script)}`, where: "workspace" } };
    const next = { ...makeStep("command", "next"), p: { cmd: `node -e 'require("fs").writeFileSync(${JSON.stringify(effect)},"old")'`, where: "workspace" } };
    await db.update(tasks).set({ workflow: JSON.stringify({ workspace: "shared", steps: [makeStep("run", "run"),
      makeStep("verify", "verify"), hold, next, makeStep("human", "human")] }) }).where(eq(tasks.id, review.taskId));
    assert.equal((await review.stage()).status, 200);
    const settling = review.settle(true);
    try {
      await until("first command running", async () => existsSync(ready));
      await db.update(tasks).set({ stage: "implemented", workflowAt: "run", ...turnDirectionStart("later-turn", "later-direction") })
        .where(eq(tasks.id, review.taskId));
    } finally { writeFileSync(release, "release"); }
    await settling;
    assert.equal(existsSync(effect), false);
    assert.equal((await row(review.taskId)).stage, "implemented");
    assert.equal((await row(review.taskId)).workflowAt, "run");
    assert.equal((await review.state()).finalization?.superseded, true);
    assert.equal((await review.state()).finalization?.runningStep, "hold");
    runs.releaseTurn(review.ownerTaskId);
    console.log(`✓ ${mode}: changing direction during a real command revokes all later stations`);
  }

  for (const mode of ["preset", "legacy", "free"] as const) {
    const review = await open(mode);
    await clearMessages(review.taskId);
    if (mode === "free") await db.update(schema.freeReviewRounds).set({ conclusion: "verify_failed" }).where(eq(schema.freeReviewRounds.id, review.roundId));
    else {
      const verify = { ...makeStep("verify", "verify"), fail: { mode: "back", max: 2 } };
      await db.update(tasks).set({ stage: "verify_failed", workflow: JSON.stringify({ workspace: "shared", steps: [makeStep("run", "run"), verify] }) })
        .where(eq(tasks.id, review.taskId));
    }
    if (mode === "free") await db.update(schema.freeReviewRuns).set({ retryLimit: 1 }).where(eq(schema.freeReviewRuns.id, review.runId));
    await review.settle(true);
    const repair = (await messages(review.taskId)).find((message) => message.origin?.startsWith("review-settlement:"));
    assert(repair, `${mode} should persist a repair`);
    runs.releaseTurn(review.ownerTaskId);
    await db.update(tasks).set({ status: "done", ...directionIdentityCleared() }).where(eq(tasks.id, review.ownerTaskId));
    assert.equal(await reviewDeliveryBlocked(reviewDeliveryFrom(repair), review.taskId), null);
    assert(await beginDelivery(repair.id));
    await db.update(tasks).set({ stage: "accepted", ...turnDirectionStart("accepted-turn", "accepted-direction") }).where(eq(tasks.id, review.taskId));
    const before = await row(review.taskId);
    assert(await monitorWakeGuard(repair)!());
    assert.equal(await continueTask(review.taskId, repair.text, { ...deliveryOptions(repair), wakeGuard: monitorWakeGuard(repair) }), false);
    assert.equal((await row(review.taskId)).directionEpoch, before.directionEpoch);
    await db.update(schema.scheduledMessages).set({ deliveringSince: null }).where(eq(schema.scheduledMessages.id, repair.id));
    await deliverPendingMessages(review.taskId);
    assert.equal((await messages(review.taskId)).find((message) => message.id === repair.id)?.status, "canceled");
    console.log(`✓ ${mode}: queued and already-leased repair guards reach the real continuation entry`);
  }

  const dispatch = await open("preset");
  assert.equal((await dispatch.stage()).status, 200);
  await dispatch.settle(true);
  runs.releaseTurn(dispatch.taskId);
  await clearMessages(dispatch.taskId);
  await db.update(tasks).set({ status: "done", ...directionIdentityCleared() }).where(eq(tasks.id, dispatch.taskId));
  const nextDirectory = reviewRoundDir(dispatch.taskId, 2);
  const dispatchState = async () => (await db.select().from(schema.regressionEvidence).where(eq(schema.regressionEvidence.directory, nextDirectory)))[0]!;
  symlinkSync(root, nextDirectory, "dir");
  try { await assert.rejects(startVerifyRound(dispatch.taskId, {}, { holdTurn: true }), /证据|目录|EEXIST|symlink/); }
  finally { rmSync(nextDirectory); }
  const prepared = await dispatchState();
  assert.equal((await row(dispatch.taskId)).verifyRound, null);
  await db.update(tasks).set({ stage: "implemented", ...turnDirectionStart("retry-turn", "retry-direction") }).where(eq(tasks.id, dispatch.taskId));
  assert.equal((await startVerifyRound(dispatch.taskId, {}, { holdTurn: true })).round, 2);
  await until("retried explicit dispatch settles", async () => !(await row(dispatch.taskId)).verifyRound && !runs.isTurnClaimed(dispatch.taskId));
  assert.notEqual((await dispatchState()).generation, prepared.generation);
  assert.equal((await dispatchState()).targetIdentity?.directionEpoch, (await row(dispatch.taskId)).directionEpoch);
  assert.equal((await dispatchState()).settlement?.outcome, "failed");
  assert.equal((await dispatchState()).finalization?.superseded, undefined);
  assert.equal((await row(dispatch.taskId)).verifyRounds, 2);
  console.log("✓ explicit dispatch after failed protocol preparation initializes a new identity instead of reusing the abandoned attempt");

  await testReviewAcceptanceOwnership(open);

  for (const mode of ["preset", "legacy", "free", "accepted_merge"] as const) {
    for (const submitted of [false, true]) {
      const review = await open(mode);
      await clearMessages(review.ownerTaskId);
      if (submitted) assert.equal((await review.stage()).status, 200);
      const owner = await row(review.ownerTaskId);
      assert(await setTaskQuestion({ taskId: owner.id, question: "Continue this review?", currentTurn: { token: owner.activeTurnToken } }));
      await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, owner.id));
      await review.settle(true);
      assert.equal((await review.state()).settlement, null);
      await db.insert(schema.sessions).values({ id: `answer-${owner.id}`, taskId: owner.id,
        role: mode === "free" || mode === "accepted_merge" ? "reviewer" : "single", agentType: "codex", executor: "test", startedAt: new Date().toISOString() });
      const response = await api.request(`/tasks/${owner.id}/answer`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ answer: "Continue the same round" }) });
      assert.equal(response.status, 200, await response.text());
      const answer = (await messages(owner.id)).find((message) => message.origin?.startsWith("review-answer:"));
      assert(answer);
      assert.equal(deliveryOptions(answer).byBackend, undefined, "a user answer is not backend-authored text");
      assert.equal(deliveryVerdict(answer, { mode: "single", status: "paused", archived: false, queueBlocked: true }, new Date()).action,
        "deliver", "a review answer is a side turn, not a task execution seat");
      await preserveReviewWait(owner);
      assert.equal((await review.state()).continuation?.phase, "delivery");
      runs.releaseTurn(owner.id);
      assert(await beginDelivery(answer.id));
      await reconcileRegressionSettlements();
      assert.equal((await review.state()).settlement, null, "a pending lease is a durable review handoff, even after a conclusion");
      assert.equal((await row(review.taskId)).verifyRound, mode === "preset" ? 1 : null);
      assert(runs.claimTurn(owner.id));
      const resuming = db.transaction(async (transaction) => {
        const current = (await transaction.select().from(tasks).where(eq(tasks.id, owner.id)))[0]!;
        const receipt = await beginReviewContinuation(transaction, current, mode === "free" || mode === "accepted_merge"
          ? { role: "reviewer", review: { run: review.runId, round: 1 } } : { role: "single" }, "answer-turn", "answer-direction", reviewDeliveryFrom(answer));
        await transaction.update(tasks).set({ status: "running", ...turnDirectionStart("answer-turn", "answer-direction") }).where(eq(tasks.id, owner.id));
        await transaction.update(schema.scheduledMessages).set({ status: "sent" }).where(eq(schema.scheduledMessages.id, answer.id));
        return receipt;
      }, { behavior: "immediate" });
      const [receipt] = await Promise.all([resuming, reconcileRegressionSettlements()]);
      await commitReviewTurnDelivery(owner.id, receipt);
      assert(await reviewDeliveryBlocked(reviewDeliveryFrom(answer), owner.id), "an already-consumed answer cannot start another turn");
      assert.equal((await review.state()).settlement, null);
      assert.equal((await review.state()).continuation?.phase, "running");
      await db.update(tasks).set({ status: "done", ...directionIdentityCleared() }).where(eq(tasks.id, owner.id));
      await review.settle(true);
      runs.releaseTurn(owner.id);
      assert.equal((await review.state()).settlement?.outcome, "done");
      assert.equal((await review.state()).settlement?.pending, false);
      if (mode === "accepted_merge") assert.equal((await row(review.taskId)).stage, "accepted");
      await clearMessages(review.taskId);
      console.log(`✓ ${mode} ${submitted ? "with" : "without"} conclusion: HTTP answer, lease, recovery and resumption retain the same round`);
    }
  }

  const atomic = await open("preset");
  await clearMessages(atomic.taskId);
  await setTaskQuestion({ taskId: atomic.taskId, question: "Preserve the accepted answer atomically" });
  await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, atomic.taskId));
  await atomic.settle(true);
  const beforeAnswer = await row(atomic.taskId);
  await dbClient.execute(`CREATE TEMP TRIGGER answer_fault BEFORE INSERT ON scheduled_messages
    WHEN NEW.origin LIKE 'review-answer:%' BEGIN SELECT RAISE(ABORT,'ANSWER_QUEUE_FAULT'); END`);
  try {
    const failed = await api.request(`/tasks/${atomic.taskId}/answer`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ answer: "continue" }) });
    assert.equal(failed.status, 500);
  } finally { await dbClient.execute("DROP TRIGGER answer_fault"); }
  assert.equal((await row(atomic.taskId)).question, beforeAnswer.question);
  assert.equal((await row(atomic.taskId)).questionHistory, beforeAnswer.questionHistory);
  assert.equal((await atomic.state()).continuation?.phase, "waiting");
  assert.equal((await messages(atomic.taskId)).length, 0);
  const retried = await api.request(`/tasks/${atomic.taskId}/answer`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ answer: "continue" }) });
  assert.equal(retried.status, 200);
  assert.equal((await messages(atomic.taskId)).length, 1);
  assert.equal((await atomic.state()).continuation?.phase, "delivery");
  await db.update(schema.scheduledMessages).set({ deliveringSince: new Date().toISOString() }).where(eq(schema.scheduledMessages.taskId, atomic.taskId));
  runs.releaseTurn(atomic.taskId);
  await reconcileRegressionSettlements();
  assert.equal((await atomic.state()).settlement, null);
  console.log("✓ answer history, cleared question and durable delivery roll back and retry together");

  const racing = await open("preset");
  await clearMessages(racing.taskId);
  await setTaskQuestion({ taskId: racing.taskId, question: "Race answer and recovery" });
  await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, racing.taskId));
  await racing.settle(true);
  const response = await api.request(`/tasks/${racing.taskId}/answer`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ answer: "continue" }) });
  assert.equal(response.status, 200);
  await db.update(schema.scheduledMessages).set({ deliveringSince: new Date().toISOString() }).where(and(eq(schema.scheduledMessages.taskId, racing.taskId), eq(schema.scheduledMessages.status, "pending")));
  runs.releaseTurn(racing.taskId);
  await reconcileRegressionSettlements();
  assert.equal((await racing.state()).settlement, null);
  assert.equal((await row(racing.taskId)).verifyRound, 1);
  assert.match(readFileSync(join(racing.directory, "report.md"), "utf8"), /Independent/);
  console.log("✓ durable answer acceptance and recovery serialize without terminating the round");
  const queued = (await messages(racing.taskId)).find((message) => message.origin?.startsWith("review-answer:"))!;
  let delivered = false;
  assert.equal(await continueTask(racing.taskId, queued.text, { ...deliveryOptions(queued), wakeGuard: monitorWakeGuard(queued),
    onDelivered: async () => {
      delivered = true;
      await db.update(schema.scheduledMessages).set({ status: "sent", deliveringSince: null }).where(eq(schema.scheduledMessages.id, queued.id));
    },
  }), true);
  assert.equal(delivered, true);
  assert.equal((await row(racing.taskId)).verifyRound, null);
  assert.equal((await row(racing.taskId)).verifyRounds, 1);
  assert.equal((await racing.state()).settlement?.pending, false);
  assert.equal((await racing.state()).settlement?.outcome, "failed", "the CLI spawn guard yields a real failed execution, not a recovery-generated failure");
  console.log("✓ actual continuation entry consumes the original review answer exactly once; CLI spawn remains blocked by the test guard");
  for (const mode of ["preset", "legacy", "free", "accepted_merge"] as const) {
    const review = await open(mode);
    await clearMessages(review.ownerTaskId);
    assert(await occupyResumePrompt(review.ownerTaskId, "Resume this same review", false));
    const generation = (await row(review.ownerTaskId)).resumePromptGeneration;
    assert(await occupyResumePrompt(review.ownerTaskId, "Resume this same review", false));
    assert.equal(await takeResumePrompt(review.ownerTaskId, "Resume this same review", generation), null);
    await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, review.ownerTaskId));
    await review.settle(true);
    assert.equal((await review.state()).settlement, null);
    runs.releaseTurn(review.ownerTaskId);
    const checkpoint = { kind: "checkpoint" as const, generation: (await review.state()).generation,
      text: "Resume this same review", promptGeneration: (await row(review.ownerTaskId)).resumePromptGeneration };
    await Promise.all([resumeOrRunTask(review.ownerTaskId, { reason: "run" }), reconcileRegressionSettlements()]);
    assert.equal((await row(review.ownerTaskId)).resumePrompt, null);
    assert.equal((await review.state()).settlement?.outcome, "failed");
    assert.equal((await review.state()).settlement?.pending, false);
    const completed = await row(review.ownerTaskId);
    assert.equal(await continueTask(review.ownerTaskId, checkpoint.text, { reviewDelivery: checkpoint }), false);
    assert.equal((await row(review.ownerTaskId)).directionEpoch, completed.directionEpoch, "a stale checkpoint cannot start an ordinary turn after the review ends");
    if (mode === "preset") assert.equal((await row(review.taskId)).verifyRounds, 1);
    if (mode === "accepted_merge") assert.equal((await row(review.taskId)).stage, "accepted");
    console.log(`✓ ${mode}: checkpoint stays durable until real delivery and races recovery without losing the round`);
  }
} finally { await teardown(); }
