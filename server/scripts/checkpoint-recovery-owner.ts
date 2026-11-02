import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { requireTmpDb } from "./tmp-db.js";

requireTmpDb("checkpoint-recovery-owner");
const { db, dbClient } = await import("../src/db/index.js");
const { scheduledMessages, tasks } = await import("../src/db/schema.js");
const runs = await import("../src/runs.js");
const { dispatchPendingMessage } = await import("../src/pending-dispatch.js");
const { cancelPendingMonitorEvents } = await import("../src/monitor-events.js");
const { mountTaskRunRoutes } = await import("../src/task-run-routes.js");
const { claimCheckpointForRun } = await import("../src/task-checkpoint-delivery.js");
const taskId = process.argv[3]!;
const messageId = process.argv[4]!;

try {
  if (process.argv[2] === "run-owner") {
    const task = (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!;
    const receipt = await claimCheckpointForRun(taskId, task.resumePrompt!);
    assert.ok(receipt?.deliveringSince);
    assert.equal(receipt.status, "canceled");
    assert.equal((await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!.resumePrompt, null);
    console.log("DURABLE_RUN_OWNER", receipt.id);
  } else {
    const first = (await db.select().from(scheduledMessages).where(eq(scheduledMessages.id, messageId)))[0]!;
    assert.ok(runs.claimTurn(taskId, "single"));
    const batch = dbClient.batch;
    let injected = 0;
    dbClient.batch = async function (statements, ...rest) {
      if (statements.some((statement) => typeof statement !== "string"
        && /^update "scheduled_messages" set "checkpoint_taken"/i.test(statement.sql)
        && Array.isArray(statement.args) && statement.args[0] === null)) {
        injected++;
        throw new Error("INJECT_OWNER_RESTORE_FAILURE");
      }
      return batch.call(dbClient, statements, ...rest);
    };
    await dispatchPendingMessage(first, {
      spans: { dueAt: Date.now(), busyMs: 0, queuedAt: Date.now() }, onClaim: () => {},
    });
    assert.ok(injected > 0);
    if (process.argv[2] === "single") {
      const api = new Hono();
      mountTaskRunRoutes(api);
      const response = await api.request(`/scheduled-messages/${messageId}`, { method: "DELETE" });
      assert.equal(response.status, 200);
    } else if (process.argv[2] === "batch") {
      await cancelPendingMonitorEvents(taskId, { only: [first.origin!.slice(8)] });
    } else if (process.argv[2] === "all") {
      await cancelPendingMonitorEvents(taskId);
    }
    const receipt = (await db.select().from(scheduledMessages).where(eq(scheduledMessages.id, messageId)))[0]!;
    assert.ok(receipt.checkpointTaken);
    assert.equal(receipt.deliveringSince, null);
    assert.equal((await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!.resumePrompt, null);
    if (process.argv[2] !== "none") assert.equal(receipt.status, "canceled");
    console.log("DURABLE_RESULT_OWNER", JSON.stringify({ taskId, messageId, injected, status: receipt.status }));
  }
} finally {
  dbClient.close();
}
process.exit(0);
