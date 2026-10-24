import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db, root, runs, schema, tasks, teardown } from "./monitors-fixture.js";
import { setupRegressionReviews, type ReviewMode } from "./regression-review-fixture.js";

const { reconcileFreeReviews } = await import("../src/free-workflow.js");
const { reconcileRegressionSettlements, regressionSettlementConclusion, completeRegressionSettlement } = await import("../src/regression-settlement.js");
const { mountReviewRoutes } = await import("../src/review.js");
const { reportTaskStage } = await import("../src/task-stage.js");
const { checkRegressionConclusion } = await import("../src/regression-evidence-lifecycle.js");
const { reopenFailedFreeReview } = await import("../src/free-review-round.js");
const { createClient } = await import("../src/db/node-sqlite-client.js");
const { ensureRegressionEvidenceSchema } = await import("../src/db/schema-regression-evidence.js");
let restricted: string | null = null;
try {
  const legacyDb = createClient({ url: join(root, "evidence-upgrade.db") });
  try {
    await legacyDb.execute("CREATE TABLE regression_evidence (directory TEXT PRIMARY KEY, task_id TEXT NOT NULL, generation TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, excluded_monitors TEXT NOT NULL, accepted_basis TEXT, unavailable TEXT)");
    await legacyDb.execute("INSERT INTO regression_evidence VALUES ('old-round','old-task','old-generation',1,'[]',NULL,'EACCES')");
    await ensureRegressionEvidenceSchema(legacyDb);
    await ensureRegressionEvidenceSchema(legacyDb);
    const migrated = (await legacyDb.execute("SELECT * FROM regression_evidence")).rows[0]!;
    assert.equal(migrated.generation, "old-generation");
    assert.equal(migrated.revoked, 1);
    assert.equal(migrated.unavailable, "EACCES");
    assert.equal(migrated.settlement, null);
    assert.equal(migrated.target_identity, null);
    assert.equal(migrated.continuation, null);
  } finally { legacyDb.close(); }
  const { open } = await setupRegressionReviews();
  const api = new Hono();
  mountReviewRoutes(api);
  for (const mode of ["free", "accepted_merge", "preset", "legacy"] as ReviewMode[]) {
    for (const turnOk of [false, true]) {
      const review = await open(mode);
      assert.equal((await review.stage()).status, 200);
      chmodSync(review.monitor.logPath, 0o000);
      restricted = review.monitor.logPath;
      await review.settle(turnOk);
      const deferred = await review.state();
      assert.equal(deferred.settlement?.outcome, turnOk ? "done" : "failed");
      assert.equal(deferred.settlement?.pending, turnOk, `${mode}: failed reviewer needs no evidence to fail`);
      if (turnOk) {
        if (mode === "preset" || mode === "legacy") await assert.rejects(reportTaskStage(review.taskId, "verifying"), /进入结算/);
        const snapshot = await regressionSettlementConclusion(review.taskId, review.directory, {
          outcome: "done", round: review.round, ownerTaskId: review.ownerTaskId,
          ...(mode === "free" || mode === "accepted_merge" ? { freeRoundId: review.roundId } : {}),
          acceptedMerge: mode === "accepted_merge",
        });
        assert.equal(snapshot, null, "repeated unreadable evidence preserves pending result");
      }
      chmodSync(review.monitor.logPath, 0o600);
      restricted = null;
      runs.releaseTurn(review.ownerTaskId);
      await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, review.ownerTaskId));
      if (review.ownerTaskId !== review.taskId) await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, review.taskId));
      const recoveryUrl = new URL("../src/regression-settlement.ts", import.meta.url).href;
      const freeUrl = new URL("../src/free-workflow.ts", import.meta.url).href;
      execFileSync(process.execPath, ["--import", "tsx/esm", "--input-type=module", "-e", `
        const {reconcileFreeReviews}=await import(${JSON.stringify(freeUrl)});
        const {reconcileRegressionSettlements}=await import(${JSON.stringify(recoveryUrl)});
        await reconcileFreeReviews(); await reconcileRegressionSettlements();
      `], { env: process.env, stdio: "pipe" });
      await reconcileFreeReviews();
      await reconcileRegressionSettlements();
      const final = await review.state();
      assert.equal(final.settlement?.outcome, turnOk ? "done" : "failed", "restart cannot infer success from task done");
      assert.equal(final.settlement?.pending, false);
      if (mode === "free" || mode === "accepted_merge") {
        const round = (await db.select().from(schema.freeReviewRounds).where(eq(schema.freeReviewRounds.id, review.roundId)))[0]!;
        const run = (await db.select().from(schema.freeReviewRuns).where(eq(schema.freeReviewRuns.id, review.runId)))[0]!;
        assert.equal(round.status, turnOk ? "passed" : "error");
        assert.equal(run.status, turnOk ? "passed" : "failed");
        if (mode === "accepted_merge") assert.equal((await db.select().from(tasks).where(eq(tasks.id, review.taskId)))[0]!.stage, "accepted");
      } else {
        const target = (await db.select().from(tasks).where(eq(tasks.id, review.taskId)))[0]!;
        assert.equal(target.verifyRound, null);
        assert.equal(target.stage, turnOk ? "verified" : null);
        if (!turnOk) assert.equal(target.workflowAt, "verify", "failed review never advances workflow");
        const info = await (await api.request(`/tasks/${review.taskId}/review`)).json() as {
          rounds: Array<{ round: number; reviewTaskStatus: string; conclusion: string | null }>;
        };
        const presented = info.rounds.find((round) => round.round === review.round)!;
        assert.equal(presented.reviewTaskStatus, turnOk ? "done" : "failed");
        assert.equal(presented.conclusion, turnOk ? "verified" : null, "round presentation uses actual exit, not task done");
      }
      console.log(`✓ ${mode}: ${turnOk ? "successful" : "failed"} exit survives EACCES, retry and separate-process recovery`);
    }
    const stopped = await open(mode);
    assert.equal((await stopped.stage()).status, 200);
    chmodSync(stopped.monitor.logPath, 0o000);
    restricted = stopped.monitor.logPath;
    await stopped.settle(true);
    assert.equal((await stopped.state()).settlement?.pending, true);
    await stopped.settle(false);
    chmodSync(stopped.monitor.logPath, 0o600);
    restricted = null;
    await stopped.settle(true);
    assert.equal((await stopped.state()).settlement?.outcome, "failed", "later retry cannot overwrite observed failure");
    assert.equal((await stopped.state()).settlement?.pending, false);
    runs.releaseTurn(stopped.ownerTaskId);
  }
  const unknown = await open("free");
  assert.equal((await unknown.stage()).status, 200);
  assert.equal(await regressionSettlementConclusion(unknown.taskId, unknown.directory,
    { round: unknown.round, freeRoundId: unknown.roundId }), null, "recovery rechecks the live reviewer inside its transaction");
  assert.equal((await unknown.state()).settlement, null, "live reviewer cannot acquire a guessed recovery outcome");
  runs.releaseTurn(unknown.taskId);
  await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, unknown.taskId));
  await reconcileFreeReviews();
  assert.equal((await unknown.state()).settlement?.outcome, "failed", "no durable exit fact means no inferred success");
  const previous = await unknown.state();
  assert(runs.claimTurn(unknown.taskId, "dispatch"));
  await reopenFailedFreeReview(unknown.taskId);
  assert(runs.isTurnClaimed(unknown.taskId), "restart delivery remains parked behind the caller's turn reservation");
  const restarted = await unknown.state();
  assert.notEqual(restarted.generation, previous.generation);
  assert.equal(restarted.revoked, previous.revoked, "explicit restart never clears revocation");
  assert.equal(restarted.settlement, null, "explicit restart separates a new attempt from the old exit");
  assert.equal(restarted.acceptedBasis, null);
  assert(restarted.excludedMonitors.includes(unknown.monitor.id));
  let consumedOldAttempt = false;
  assert.equal(await completeRegressionSettlement(unknown.directory, { conclusion: "verified", outcome: "failed", generation: previous.generation }, async () => {
    consumedOldAttempt = true;
    return true;
  }), false);
  assert.equal(consumedOldAttempt, false, "old attempt cannot consume a new epoch");
  await assert.rejects(checkRegressionConclusion(unknown.taskId, unknown.directory, "verified", false, unknown.basis), /依据无效/);
} finally {
  if (restricted) chmodSync(restricted, 0o600);
  await teardown();
}
