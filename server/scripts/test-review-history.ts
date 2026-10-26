import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { db, dbClient, runs, schema, tasks, teardown, until } from "./monitors-fixture.js";
import { setupRegressionReviews, type ReviewMode } from "./regression-review-fixture.js";

const { reconcileRegressionSettlements } = await import("../src/regression-settlement.js");
const { regressionSettlementConclusion } = await import("../src/regression-settlement.js");
const { continueTask } = await import("../src/orchestrator.js");
const { resumeOrRunTask } = await import("../src/task-resume.js");
const { occupyResumePrompt } = await import("../src/task-resume-prompt.js");
const { sessionTranscriptPath } = await import("../src/transcript.js");
const { finishVerifyRound } = await import("../src/review-settlement.js");
const { retireHistoricalReview } = await import("../src/review-retirement.js");
const { startVerifyRound } = await import("../src/review.js");
const { answerTask } = await import("../src/task-answer.js");
const row = async (taskId: string) => (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!;
const source = (review: { mode: ReviewMode; runId: string; round: number }) =>
  review.mode === "free" || review.mode === "accepted_merge"
    ? { role: "reviewer" as const, review: { run: review.runId, round: review.round } }
    : { role: "single" as const };

assert.notEqual(process.env.ASH_ALLOW_REAL_AGENT, "1");
const api = new Hono();
api.post("/tasks/:id/answer", (context) => answerTask(context, context.req.param("id")));
try {
  const { open } = await setupRegressionReviews();
  const historical = async (mode: ReviewMode, missing: "identity" | "entire-state") => {
    const review = await open(mode);
    assert.equal((await review.stage()).status, 200);
    if (missing === "identity") await db.update(schema.regressionEvidence).set({ targetIdentity: null })
      .where(eq(schema.regressionEvidence.directory, review.directory));
    else await db.delete(schema.regressionEvidence).where(eq(schema.regressionEvidence.directory, review.directory));
    const sessionId = `history-${review.taskId}`;
    await db.insert(schema.sessions).values({ id: sessionId, taskId: review.taskId, role: "single", agentType: "codex", executor: "test",
      startedAt: new Date().toISOString() });
    return { ...review, transcript: () => readFileSync(sessionTranscriptPath(review.taskId, sessionId), "utf8") };
  };

  for (const mode of ["preset", "legacy"] as const) {
    for (const missing of ["identity", "entire-state"] as const) {
      for (const turnOk of [true, false]) {
        const review = await historical(mode, missing);
        const before = await row(review.taskId);
        await review.settle(turnOk);
        const after = await row(review.taskId);
        assert.equal(after.verifyRound, null);
        assert.equal(after.verifyRounds, mode === "preset" ? before.verifyRounds + 1 : before.verifyRounds);
        assert.equal(after.stage, before.stage);
        assert.equal(after.workflowAt, before.workflowAt);
        assert.equal(after.verifyCompletedSteps, before.verifyCompletedSteps);
        assert.equal(after.verifyStationRounds, before.verifyStationRounds);
        assert.equal((await review.state()).settlement?.pending, false);
        assert.equal((await review.state()).settlement?.target, null);
        assert.equal((await review.state()).finalization?.superseded, true);
        assert.match(review.transcript(), /本轮结论未应用/);
        await review.settle(turnOk);
        assert.equal((await row(review.taskId)).verifyRounds, after.verifyRounds);
        assert.equal(review.transcript().match(/本轮结论未应用/g)?.length, 1);
        runs.releaseTurn(review.ownerTaskId);
        await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, review.ownerTaskId));
        console.log(`✓ ${mode} ${missing} ${turnOk}: only its own round ledger closes, exactly once`);
      }
    }
  }

  for (const mode of ["preset", "legacy"] as const) {
    const review = await historical(mode, "identity");
    const stored = await regressionSettlementConclusion(review.taskId, review.directory, {
      outcome: "done", round: review.round, ownerTaskId: review.ownerTaskId,
    });
    assert(stored);
    assert.equal((await review.state()).settlement?.pending, true);
    runs.releaseTurn(review.ownerTaskId);
    await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, review.ownerTaskId));
    await reconcileRegressionSettlements(review.ownerTaskId);
    assert.equal((await review.state()).settlement?.pending, false);
    assert.equal((await row(review.taskId)).verifyRound, null);
    assert.match(review.transcript(), /本轮结论未应用/);
    console.log(`✓ ${mode}: old pending settlement is retried and releases the round`);
  }

  {
    // 轮次目录这套东西上线之前跑完的老审查:一行证据都没留下,任务自己早已终态收口。
    // 启动对账扫到它必须原样放过 —— 2026-10-26 那次重启把全库 112 条这样的审查退休成
    // failed 并把 updatedAt 顶到当下,侧栏于是被几个月前的旧行铺满(年龄闸对 failed 豁免)。
    const closed = await historical("legacy", "entire-state");
    runs.releaseTurn(closed.ownerTaskId);
    await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, closed.ownerTaskId));
    const before = await row(closed.ownerTaskId);
    await reconcileRegressionSettlements(closed.ownerTaskId);
    assert.deepEqual(await row(closed.ownerTaskId), before, "a closed historical review keeps its own terminal status and updatedAt");
    assert.equal((await db.select().from(schema.regressionEvidence)
      .where(eq(schema.regressionEvidence.directory, closed.directory))).length, 0,
      "nothing is revoked where no ledger ever existed");
    console.log("✓ legacy: a long-closed review without any ledger is not reopened by startup recovery");
  }

  for (const mode of ["preset", "legacy", "free", "accepted_merge"] as const) {
    for (const missing of ["identity", "entire-state"] as const) {
      const review = await historical(mode, missing);
      runs.releaseTurn(review.ownerTaskId);
      await db.update(tasks).set({ status: "queued", resumePrompt: "Resume this same historical review",
        resumePromptGeneration: 7 }).where(eq(tasks.id, review.ownerTaskId));
      const before = await row(review.taskId);
      await resumeOrRunTask(review.ownerTaskId, { reason: "queue" });
      const owner = await row(review.ownerTaskId);
      assert.equal(owner.resumePrompt, null);
      assert.equal(owner.resumePromptGeneration, 8);
      assert.notEqual(owner.status, "queued");
      assert.equal(owner.verifyRound, null);
      assert.equal((await review.state()).settlement?.outcome, "failed");
      assert.equal((await review.state()).settlement?.pending, false);
      assert.equal((await row(review.taskId)).stage, before.stage);
      assert.equal((await row(review.taskId)).workflowAt, before.workflowAt);
      if (mode === "legacy") {
        assert.equal(owner.status, "failed", "the legacy review's own task slot also terminates");
        assert.equal(await retireHistoricalReview(owner), false, "completed historical ledgers are not repeatedly reopened");
      }
      if (mode === "free" || mode === "accepted_merge") {
        const run = (await db.select().from(schema.freeReviewRuns).where(eq(schema.freeReviewRuns.id, review.runId)))[0]!;
        assert.equal(run.status, "failed");
      }
      assert.match(review.transcript(), /本轮结论未应用/);
      const checkpoint = { kind: "checkpoint" as const, generation: missing === "identity" ? review.basis.generation : null,
        text: "Resume this same historical review", promptGeneration: 7 };
      assert.equal(await continueTask(review.ownerTaskId, checkpoint.text, { turnSource: source(review), reviewDelivery: checkpoint }), false);
      assert.equal((await row(review.ownerTaskId)).directionEpoch, owner.directionEpoch);
      console.log(`✓ ${mode} ${missing}: unsupported checkpoint terminates without an endless queue retry`);
    }
  }

  for (const mode of ["preset", "legacy", "free", "accepted_merge"] as const) {
    const review = await historical(mode, "identity");
    runs.releaseTurn(review.ownerTaskId);
    await db.update(tasks).set({ status: "paused", question: "Historical reviewer question",
      questionOptions: JSON.stringify(["Original option"]),
      questionItems: JSON.stringify([{ question: "Original item", options: ["Original option"] }]),
    }).where(eq(tasks.id, review.ownerTaskId));
    await occupyResumePrompt(review.ownerTaskId, "Historical checkpoint", false);
    const before = await row(review.ownerTaskId);
    await reconcileRegressionSettlements();
    const after = await row(review.ownerTaskId);
    assert.equal((await review.state()).settlement?.pending, false);
    assert.equal(after.resumePrompt, null);
    assert.equal(after.question, null);
    assert.equal(after.questionOptions, null);
    assert.equal(after.questionItems, null);
    assert.equal(after.questionHistory, before.questionHistory);
    assert.equal((await row(review.taskId)).verifyRound, null);
    assert.match(review.transcript(), /本轮结论未应用/);
    assert.match(review.transcript(), /原提问随本轮终止失效/);
    console.log(`✓ ${mode}: recovery retires an unprovable historical wait instead of preserving it forever`);
  }

  for (const mode of ["preset", "legacy", "free", "accepted_merge"] as const) {
    const review = await historical(mode, "identity");
    await regressionSettlementConclusion(review.taskId, review.directory, { outcome: "done", round: review.round,
      ownerTaskId: review.ownerTaskId, ...(mode === "free" || mode === "accepted_merge" ? { freeRoundId: review.roundId } : {}),
      acceptedMerge: mode === "accepted_merge" });
    runs.releaseTurn(review.ownerTaskId);
    await db.update(tasks).set({ status: "queued", question: "Old completed question" }).where(eq(tasks.id, review.ownerTaskId));
    await occupyResumePrompt(review.ownerTaskId, "Old completed checkpoint", false);
    await resumeOrRunTask(review.ownerTaskId, { reason: "queue" });
    assert.equal((await review.state()).settlement?.outcome, "done", "retirement preserves the observed exit fact");
    assert.equal((await review.state()).settlement?.pending, false);
    assert.equal((await row(review.ownerTaskId)).resumePrompt, null);
    assert.equal((await row(review.ownerTaskId)).question, null);
    assert.equal((await row(review.taskId)).verifyRound, null);
    assert.match(review.transcript(), /原提问随本轮终止失效/);
    console.log(`✓ ${mode}: a pending historical receipt wins over obsolete wait fields and retains its real exit`);
  }

  for (const mode of ["preset", "legacy", "free", "accepted_merge"] as const) {
    for (const missing of ["identity", "entire-state"] as const) {
      const review = await historical(mode, missing);
      await db.delete(schema.scheduledMessages).where(eq(schema.scheduledMessages.taskId, review.ownerTaskId));
      await db.update(tasks).set({ status: "paused", question: "Historical review question" }).where(eq(tasks.id, review.ownerTaskId));
      const response = await api.request(`/tasks/${review.ownerTaskId}/answer`, { method: "POST",
        headers: { "content-type": "application/json" }, body: JSON.stringify({ answer: "Only continue this review" }) });
      assert.equal(response.status, 409);
      assert.equal((await row(review.ownerTaskId)).question, "Historical review question");
      assert.equal((await db.select().from(schema.scheduledMessages)
        .where(eq(schema.scheduledMessages.taskId, review.ownerTaskId))).length, 0);
      runs.releaseTurn(review.ownerTaskId);
      await reconcileRegressionSettlements();
      assert.equal((await review.state()).settlement?.pending, false);
      assert.equal((await row(review.taskId)).verifyRound, null);
      const retired = await row(review.ownerTaskId);
      const lateAnswer = await api.request(`/tasks/${review.ownerTaskId}/answer`, { method: "POST",
        headers: { "content-type": "application/json" }, body: JSON.stringify({ answer: "Answer the obsolete review question" }) });
      assert.equal(lateAnswer.status, 409);
      assert.match((await lateAnswer.json()).error, /没有待答复的问题/);
      assert.deepEqual(await row(review.ownerTaskId), retired, "an expired answer cannot change or resume the implementation task");
      assert.equal((await db.select().from(schema.scheduledMessages)
        .where(eq(schema.scheduledMessages.taskId, review.ownerTaskId))).length, 0);
      if (mode === "preset") {
        const redispatched = await startVerifyRound(review.taskId);
        assert.equal(redispatched.round, 2, "a retired historical question cannot block immediate re-dispatch");
        await until("re-dispatched historical question round settles under the test CLI guard", async () =>
          !runs.isTurnClaimed(review.taskId) && (await row(review.taskId)).verifyRound === null);
      }
      console.log(`✓ ${mode} ${missing}: HTTP answer cannot escape historical review ownership into an ordinary turn`);
    }
  }

  const replaced = await historical("preset", "identity");
  const oldRound = await row(replaced.taskId);
  await db.update(tasks).set({ verifyRound: 2, verifyRounds: 10, stage: "implemented", workflowAt: "run" })
    .where(eq(tasks.id, replaced.taskId));
  await finishVerifyRound(oldRound, false);
  assert.equal((await row(replaced.taskId)).verifyRound, 2);
  assert.equal((await row(replaced.taskId)).verifyRounds, 10);
  assert.equal((await row(replaced.taskId)).stage, "implemented");
  assert.equal((await row(replaced.taskId)).workflowAt, "run");
  runs.releaseTurn(replaced.taskId);
  console.log("✓ finishing an old ledger cannot clear or count a replacement round");

  for (const mode of ["preset", "legacy"] as const) {
    const sameDirection = await open(mode);
    assert.equal((await sameDirection.stage()).status, 200);
    const sameIdentity = await row(sameDirection.taskId);
    await db.update(tasks).set({ verifyRound: 2, workflowAt: "run" }).where(eq(tasks.id, sameDirection.taskId));
    if (mode === "preset") await finishVerifyRound(sameIdentity, true);
    else await sameDirection.settle(true);
    assert.equal((await row(sameDirection.taskId)).verifyRound, 2);
    assert.equal((await row(sameDirection.taskId)).verifyRounds, sameIdentity.verifyRounds);
    assert.equal((await row(sameDirection.taskId)).workflowAt, "run");
    assert.equal((await sameDirection.state()).finalization?.superseded, true);
    runs.releaseTurn(sameDirection.ownerTaskId);
    console.log(`✓ ${mode}: round ownership revokes old finalization even when direction tokens are unchanged`);
  }

  const newerPrompt = await historical("preset", "identity");
  runs.releaseTurn(newerPrompt.ownerTaskId);
  await db.update(tasks).set({ status: "paused" }).where(eq(tasks.id, newerPrompt.taskId));
  await occupyResumePrompt(newerPrompt.taskId, "Same checkpoint text", false);
  const oldPrompt = await row(newerPrompt.taskId);
  await occupyResumePrompt(newerPrompt.taskId, "Same checkpoint text", false);
  await db.update(tasks).set({ question: "New checkpoint question" }).where(eq(tasks.id, newerPrompt.taskId));
  assert.equal(await retireHistoricalReview(oldPrompt), false);
  assert.equal(await continueTask(newerPrompt.taskId, "Same checkpoint text", { reviewDelivery: {
    kind: "checkpoint", generation: newerPrompt.basis.generation, text: "Same checkpoint text", promptGeneration: oldPrompt.resumePromptGeneration,
  } }), false);
  assert.equal((await row(newerPrompt.taskId)).resumePrompt, "Same checkpoint text");
  assert.equal((await row(newerPrompt.taskId)).resumePromptGeneration, oldPrompt.resumePromptGeneration + 1);
  assert.equal((await row(newerPrompt.taskId)).question, "New checkpoint question");
  assert.equal((await newerPrompt.state()).settlement, null);
  console.log("✓ a stale checkpoint generation cannot retire or clear a newer same-text checkpoint");

  const ordinary = await historical("preset", "identity");
  runs.releaseTurn(ordinary.ownerTaskId);
  await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, ordinary.taskId));
  assert.equal(await continueTask(ordinary.taskId, "An ordinary user message"), false);
  assert.equal((await row(ordinary.taskId)).verifyRound, null);
  assert.match(ordinary.transcript(), /本轮结论未应用/);
  const redispatched = await startVerifyRound(ordinary.taskId);
  assert.equal(redispatched.round, 2);
  await until("new verification dispatch settles under the test CLI guard", async () =>
    !runs.isTurnClaimed(ordinary.taskId) && (await row(ordinary.taskId)).verifyRound === null);
  console.log("✓ ordinary delivery releases the historical lock and permits a genuinely new verification round");

  const atomic = await historical("preset", "identity");
  runs.releaseTurn(atomic.ownerTaskId);
  await db.update(tasks).set({ status: "queued", question: "Historical question",
    questionOptions: JSON.stringify(["Original option"]),
    questionItems: JSON.stringify([{ question: "Original item", options: ["Original option"] }]),
  }).where(eq(tasks.id, atomic.taskId));
  await occupyResumePrompt(atomic.taskId, "Historical checkpoint", false);
  const before = await row(atomic.taskId);
  await dbClient.execute(`CREATE TEMP TRIGGER history_fault BEFORE UPDATE OF resume_prompt ON tasks
    WHEN OLD.id='${atomic.taskId}' AND NEW.resume_prompt IS NULL BEGIN SELECT RAISE(ABORT,'HISTORY_FAULT'); END`);
  try { await assert.rejects(resumeOrRunTask(atomic.taskId, { reason: "queue" }), /HISTORY_FAULT/); }
  finally { await dbClient.execute("DROP TRIGGER history_fault"); }
  assert.equal((await row(atomic.taskId)).resumePrompt, before.resumePrompt);
  assert.equal((await row(atomic.taskId)).resumePromptGeneration, before.resumePromptGeneration);
  assert.equal((await row(atomic.taskId)).question, before.question);
  assert.equal((await row(atomic.taskId)).questionOptions, before.questionOptions);
  assert.equal((await row(atomic.taskId)).questionItems, before.questionItems);
  assert.equal((await atomic.state()).settlement, null);
  await resumeOrRunTask(atomic.taskId, { reason: "queue" });
  assert.equal((await row(atomic.taskId)).question, null);
  assert.equal((await row(atomic.taskId)).questionOptions, null);
  assert.equal((await row(atomic.taskId)).questionItems, null);
  assert.equal((await row(atomic.taskId)).verifyRound, null);
  console.log("✓ failed historical termination rolls back its checkpoint and receipt together, then retries");

  const interrupted = await historical("preset", "identity");
  runs.releaseTurn(interrupted.ownerTaskId);
  await db.update(tasks).set({ status: "queued" }).where(eq(tasks.id, interrupted.taskId));
  await occupyResumePrompt(interrupted.taskId, "Persist termination before closing the ledger", false);
  await dbClient.execute(`CREATE TEMP TRIGGER history_ledger_fault BEFORE UPDATE OF verify_round ON tasks
    WHEN OLD.id='${interrupted.taskId}' AND NEW.verify_round IS NULL BEGIN SELECT RAISE(ABORT,'LEDGER_FAULT'); END`);
  try { await assert.rejects(resumeOrRunTask(interrupted.taskId, { reason: "queue" }), /LEDGER_FAULT/); }
  finally { await dbClient.execute("DROP TRIGGER history_ledger_fault"); }
  assert.equal((await row(interrupted.taskId)).resumePrompt, null);
  assert.equal((await interrupted.state()).settlement?.pending, true);
  assert.notEqual((await row(interrupted.taskId)).status, "queued");
  await reconcileRegressionSettlements(interrupted.taskId);
  assert.equal((await interrupted.state()).settlement?.pending, false);
  assert.equal((await row(interrupted.taskId)).verifyRound, null);
  assert.match(interrupted.transcript(), /本轮结论未应用/);
  console.log("✓ interruption after retirement retains a durable terminal receipt and recovery finishes the ledger");
} finally { await teardown(); }
