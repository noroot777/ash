import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { makeStep } from "@ash/shared/workflow";
import { db, tasks, schema, runs, until, isPidAlive, killTree, teardown } from "./monitors-fixture.js";
import { setupRegressionReviews } from "./regression-review-fixture.js";

const { beginDelivery, reclaimStaleDeliveries, deliverPendingMessages } = await import("../src/pending-messages.js");
const { reconcileInterrupted } = await import("../src/task-reconcile.js");
const { reattachRunningTasks } = await import("../src/reattach.js");
const { reconcileRegressionSettlements } = await import("../src/regression-settlement.js");
const { reconcileFreeReviews } = await import("../src/free-workflow.js");
const { mountTaskStageRoutes } = await import("../src/task-stage.js");
const { reviewDeliveryFrom, reviewDeliveryBlocked } = await import("../src/review-ownership.js");
const { commitReviewTurnDelivery } = await import("../src/review-continuation.js");
const worker = fileURLToPath(new URL("./review-delivery-worker.ts", import.meta.url));
const row = async (taskId: string) => (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!;
const execute = (input: unknown, fault: string, marker: string) => new Promise<{ code: number | null; output: string }>((resolve, reject) => {
  const child = spawn(process.execPath, ["--import", "tsx/esm", worker, JSON.stringify(input), fault, marker], { env: process.env });
  let output = "";
  child.stdout.on("data", (data) => { output += data; });
  child.stderr.on("data", (data) => { output += data; });
  child.on("error", reject);
  child.on("close", (code) => resolve({ code, output }));
});
const ownedPids = new Set<number>();

try {
  const { open, repo } = await setupRegressionReviews();
  const api = new Hono();
  mountTaskStageRoutes(api);
  for (const mode of ["preset", "free", "accepted-tail", "preset-live"] as const) {
    const review = await open(mode === "free" ? "free" : "preset");
    await db.delete(schema.scheduledMessages);
    if (mode === "free") await db.update(schema.freeReviewRuns).set({ retryLimit: 1 })
      .where(eq(schema.freeReviewRuns.id, review.runId));
    else await db.update(tasks).set({ workflow: JSON.stringify({ workspace: "shared", steps: mode === "accepted-tail"
      ? [makeStep("run", "run"), makeStep("human", "human"), makeStep("verify", "verify"), makeStep("accept", "accept"),
        { ...makeStep("command", "post-accept"), fail: { mode: "back", max: 2 }, p: { where: "repo", cmd: "exit 9" } }]
      : [makeStep("run", "run"), { ...makeStep("verify", "verify"), fail: { mode: "back", max: 2 } }] }) })
      .where(eq(tasks.id, review.taskId));
    if (mode === "accepted-tail") assert.equal((await review.stage()).status, 200);
    else assert.equal((await api.request(`/tasks/${review.taskId}/stage`, { method: "POST",
      headers: { "content-type": "application/json", "x-ash-turn-token": `turn-${review.ownerTaskId}`,
        "x-ash-source-task-id": review.ownerTaskId }, body: JSON.stringify({ stage: "verify_failed" }) })).status, 200);
    await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, review.taskId));
    if (mode === "accepted-tail") runs.releaseTurn(review.ownerTaskId);
    await review.settle(true);
    runs.releaseTurn(review.ownerTaskId);
    const message = (await db.select().from(schema.scheduledMessages).where(eq(schema.scheduledMessages.taskId, review.taskId)))
      .find((message) => message.origin?.startsWith("review-settlement:"))!;
    assert(message);
    assert(await beginDelivery(message.id));
    const marker = join(repo, `repair-${mode}`);
    const input = { taskId: review.taskId, text: message.text, message };
    const first = await execute(input, mode === "preset-live" ? "committed-live" : "committed", marker);
    assert.equal(first.code, 86, first.output);
    const receipt = (await row(review.taskId)).waitOwnership?.deliveredReview;
    assert(receipt);
    assert.equal(receipt?.input?.kind === "checkpoint" ? undefined : receipt?.input?.messageId, message.id);
    assert.equal((await db.select().from(schema.scheduledMessages).where(eq(schema.scheduledMessages.id, message.id)))[0]!.status, "sent");
    await assert.rejects(commitReviewTurnDelivery(review.taskId, { ...receipt, delivery: receipt.input }, undefined,
      async () => { assert.fail("stale receipt must not persist a runner"); }), { name: "Error", message: /审查所属/ });
    if (receipt?.pid) ownedPids.add(receipt.pid);
    const adopted = await reattachRunningTasks();
    if (mode === "preset-live") {
      assert(receipt?.pid && isPidAlive(receipt.pid));
      assert(adopted.has(review.taskId));
      assert(runs.isRunning(review.taskId));
    }
    await reconcileInterrupted();
    await reconcileFreeReviews();
    await reconcileRegressionSettlements();
    await reclaimStaleDeliveries();
    assert.equal(await beginDelivery(message.id), null);
    assert(await reviewDeliveryBlocked(reviewDeliveryFrom(message), review.taskId));
    await db.update(schema.scheduledMessages).set({ status: "pending", deliveringSince: null }).where(eq(schema.scheduledMessages.id, message.id));
    assert(await reviewDeliveryBlocked(reviewDeliveryFrom(message), review.taskId));
    await deliverPendingMessages(review.taskId);
    const retry = await execute(input, "none", marker);
    assert.equal(retry.code, 0, retry.output);
    assert.match(retry.output, /CONTINUE_RESULT false/);
    assert.equal(readFileSync(marker, "utf8"), "delivered\n");
    if (mode === "preset-live") {
      assert(runs.stopTask(review.taskId));
      await until("reattached repair settles", async () => !runs.isRunning(review.taskId));
    }
    console.log(`✓ ${mode}: confirmed repair cannot replay before ack; session ownership survives delivery commit`);
  }
} finally {
  for (const pid of ownedPids) if (isPidAlive(pid)) killTree(pid, "SIGKILL");
  await teardown();
}
