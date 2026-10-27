import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { makeStep } from "@ash/shared/workflow";
import { db, tasks, schema, runs, teardown } from "./monitors-fixture.js";
import { setupRegressionReviews, type ReviewMode } from "./regression-review-fixture.js";

const { mountTaskStageRoutes } = await import("../src/task-stage.js");
const { mountTaskArchiveRoutes } = await import("../src/task-archive-routes.js");
const { continueTask } = await import("../src/orchestrator.js");
const { deliveryOptions, monitorWakeGuard } = await import("../src/pending-verdict.js");
const { beginDelivery } = await import("../src/pending-messages.js");
const { reconcileRegressionSettlements } = await import("../src/regression-settlement.js");
const { reviewTargetIdentity } = await import("../src/review-ownership.js");
const { withdrawReviewStart } = await import("../src/review-start-withdrawal.js");
const { reviewDeliveryBlocked, reviewDeliveryFrom } = await import("../src/review-ownership.js");
const row = async (taskId: string) => (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!;
const api = new Hono();
mountTaskStageRoutes(api);
mountTaskArchiveRoutes(api);

function holdArchive(taskId: string) {
  let release!: () => void;
  let reached!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const ready = new Promise<void>((resolve) => { reached = resolve; });
  const update = db.update;
  db.update = function (table: any) {
    const builder = update.call(this, table);
    const set = builder.set.bind(builder);
    builder.set = function (patch: any) {
      const query = set(patch);
      if (table === tasks && patch.archived === true) {
        const where = query.where.bind(query);
        query.where = function (...conditions: any[]) {
          const operation = where(...conditions);
          const then = operation.then.bind(operation);
          operation.then = (resolve: any, reject: any) => gate.then(() => then(resolve, reject));
          reached();
          return operation;
        };
      }
      return query;
    };
    return builder;
  } as typeof db.update;
  const response = api.request(`/tasks/${taskId}/archive`, { method: "POST" });
  return { release, ready, response, restore: () => { db.update = update; } };
}

assert.notEqual(process.env.ASH_ALLOW_REAL_AGENT, "1");
try {
  const { open } = await setupRegressionReviews();
  const repair = async (mode: ReviewMode) => {
    const review = await open(mode);
    await db.delete(schema.scheduledMessages);
    if (mode === "free") await db.update(schema.freeReviewRuns).set({ retryLimit: 1 })
      .where(eq(schema.freeReviewRuns.id, review.runId));
    else await db.update(tasks).set({ workflow: JSON.stringify({ workspace: "shared", steps: [makeStep("run", "run"),
      { ...makeStep("verify", "verify"), fail: { mode: "back", max: 2 } }] }) }).where(eq(tasks.id, review.taskId));
    const result = await api.request(`/tasks/${review.taskId}/stage`, { method: "POST",
      headers: { "content-type": "application/json", "x-ash-turn-token": `turn-${review.ownerTaskId}`,
        "x-ash-source-task-id": review.ownerTaskId }, body: JSON.stringify({ stage: "verify_failed" }) });
    assert.equal(result.status, 200, await result.text());
    await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, review.taskId));
    await review.settle(true);
    const message = (await db.select().from(schema.scheduledMessages).where(eq(schema.scheduledMessages.taskId, review.taskId)))[0]!;
    assert(message?.origin?.startsWith("review-settlement:"), `${mode}: real settlement must produce a guarded repair`);
    assert(await beginDelivery(message.id));
    runs.releaseTurn(review.ownerTaskId);
    return { review, message };
  };

  for (const mode of ["free", "preset", "legacy"] as const) {
    for (const fault of mode === "free" ? [false, true] : [false]) {
      const { review, message } = await repair(mode);
      const settlement = (await review.state()).settlement;
      const archive = holdArchive(review.taskId);
      await archive.ready;
      archive.restore();
      const transaction = db.transaction;
      let revoked = false;
      let writeFailed = false;
      let archiveStatus = 0;
      db.transaction = async function (...args) {
        if (!revoked && new Error().stack?.includes("assertReviewTurnStart")) {
          revoked = true;
          await reconcileRegressionSettlements(review.taskId);
          assert.equal((await row(review.taskId)).status, "running", "recovery cannot withdraw an active startup");
          assert.equal((await row(review.taskId)).waitOwnership?.start?.repair, true);
          archive.release();
          archiveStatus = (await archive.response).status;
        }
        if (fault && !writeFailed && new Error().stack?.includes("withdrawRepairStart")) {
          writeFailed = true;
          throw new Error("ONCE_REPAIR_WITHDRAWAL_FAILURE");
        }
        return transaction.apply(this, args);
      };
      try {
        const start = () => continueTask(review.taskId, message.text, { ...deliveryOptions(message), wakeGuard: monitorWakeGuard(message) });
        if (fault) {
          await assert.rejects(start(), /ONCE_REPAIR_WITHDRAWAL_FAILURE/);
          assert.equal((await row(review.taskId)).status, "running");
          assert.equal((await row(review.taskId)).waitOwnership?.start?.repair, true);
        } else assert.equal(await start(), false);
      } finally { archive.release(); archive.restore(); db.transaction = transaction; }
      assert(revoked);
      assert.equal(archiveStatus, 200);
      await reconcileRegressionSettlements(review.taskId);
      const withdrawn = await row(review.taskId);
      assert.equal(withdrawn.status, "done");
      assert.equal(withdrawn.archived, true);
      assert.equal(withdrawn.activeTurnToken, null);
      assert.equal(withdrawn.activeDirectionToken, null);
      assert.equal(withdrawn.waitOwnership?.start, undefined);
      assert.equal(runs.isTurnClaimed(review.taskId), false);
      assert.deepEqual((await review.state()).settlement, settlement);
      assert.equal((await api.request(`/tasks/${review.taskId}/unarchive`, { method: "POST" })).status, 200);
      await reconcileRegressionSettlements(review.taskId);
      assert.equal((await row(review.taskId)).status, "done");
      console.log(`✓ ${mode}: real archive/repair startup race releases durable running state${fault ? " after a storage failure and recovery" : ""}`);
    }
  }

  for (const outcome of ["replacement", "accepted", "freeze", "early"] as const) {
    const { review, message } = await repair("free");
    const before = await row(review.taskId);
    let replacement: typeof before | undefined;
    let receipt: NonNullable<typeof before.waitOwnership>["start"];
    const transaction = db.transaction;
    let injected = false;
    if (outcome === "early") assert.equal((await api.request(`/tasks/${review.taskId}/archive`, { method: "POST" })).status, 200);
    db.transaction = async function (...args) {
      if (!injected && new Error().stack?.includes("assertReviewTurnStart")) {
        injected = true;
        const current = await row(review.taskId);
        receipt = current.waitOwnership?.start;
        assert(receipt?.repair);
        if (outcome === "replacement") {
          await db.update(tasks).set({ status: "paused", directionEpoch: current.directionEpoch + 1,
            activeTurnToken: "new-turn", activeDirectionToken: "new-direction" }).where(eq(tasks.id, review.taskId));
          replacement = await row(review.taskId);
        } else if (outcome === "accepted") await db.update(tasks).set({ stage: "accepted" }).where(eq(tasks.id, review.taskId));
        else runs.freezeStartingTurn(review.taskId, "paused");
      }
      return transaction.apply(this, args);
    };
    try { assert.equal(await continueTask(review.taskId, message.text,
      { ...deliveryOptions(message), wakeGuard: monitorWakeGuard(message) }), false); }
    finally { db.transaction = transaction; }
    const after = await row(review.taskId);
    if (outcome === "early") {
      assert(!injected);
      assert.equal(after.directionEpoch, before.directionEpoch);
      assert.equal(after.waitOwnership?.start, undefined);
    } else if (outcome === "replacement") {
      assert(receipt);
      await withdrawReviewStart(review.taskId, receipt, "done");
      await reconcileRegressionSettlements(review.taskId);
      assert.deepEqual(reviewTargetIdentity(await row(review.taskId)), reviewTargetIdentity(replacement!));
      assert.equal((await row(review.taskId)).status, "paused");
    } else {
      assert.equal(after.waitOwnership?.start, undefined);
      assert.equal(after.activeTurnToken, null);
      assert.equal(after.status, "done");
      if (outcome === "accepted") assert.equal(after.stage, "accepted");
      else {
        assert.equal(await reviewDeliveryBlocked(reviewDeliveryFrom(message), review.taskId), null);
        assert.equal(await continueTask(review.taskId, message.text,
          { ...deliveryOptions(message), wakeGuard: monitorWakeGuard(message) }), true);
        await db.update(schema.scheduledMessages).set({ status: "sent" }).where(eq(schema.scheduledMessages.id, message.id));
        assert(await reviewDeliveryBlocked(reviewDeliveryFrom(message), review.taskId));
      }
    }
    assert.equal(runs.isTurnClaimed(review.taskId), false);
    console.log(`✓ repair ${outcome}: startup ownership cannot overwrite a replacement, undo acceptance, leak a freeze or claim before authorization`);
  }
} finally { await teardown(); }
