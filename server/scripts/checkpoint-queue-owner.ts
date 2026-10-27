import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { requireTmpDb } from "./tmp-db.js";

requireTmpDb("checkpoint-queue-owner");
const { db, dbClient, ensureSchema } = await import("../src/db/index.js");
const { tasks } = await import("../src/db/schema.js");
const runs = await import("../src/runs.js");
const { advanceQueue, runGroup } = await import("../src/scheduler.js");
const { tick } = await import("../src/schedules.js");
const options = JSON.parse(process.argv[3]!) as {
  taskId: string; queueId: string; checkpoint: string; entry: string; expectedRun: boolean;
  followerId?: string; followerCheckpoint?: string;
};
const taskOf = async () => (await db.select().from(tasks).where(eq(tasks.id, options.taskId)))[0]!;
const hits = (text: string) => {
  const log = process.env.ASH_TEST_LEAD_LOG!;
  return (existsSync(log) ? readFileSync(log, "utf8") : "").split(text).length - 1;
};
async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!await check()) {
    assert.ok(Date.now() < deadline, "恢复进程兑现持久推进请求");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

try {
  await ensureSchema();
  if (process.argv[2] === "request") {
    const batch = dbClient.batch;
    let failures = 0;
    dbClient.batch = async function (statements, ...rest) {
      if (statements.some((statement) => typeof statement !== "string"
        && /^update "scheduled_messages" set "checkpoint_taken"/i.test(statement.sql)
        && Array.isArray(statement.args) && statement.args[0] === null)) {
        failures++;
        throw new Error("INJECT_QUEUE_OWNER_RESTORE_FAILURE");
      }
      return batch.call(dbClient, statements, ...rest);
    };
    try {
      await (await import("../src/monitor-events.js")).cancelPendingMonitorEvents(options.taskId);
      if (options.entry === "serial-group") await runGroup((await taskOf()).groupId!);
      else await advanceQueue(options.queueId);
    } finally {
      dbClient.batch = batch;
    }
    assert.ok(failures > 0);
    assert.equal((await taskOf()).status, "paused");
    assert.ok((await taskOf()).queueAdvanceRequest?.id);
    assert.equal(hits(options.checkpoint), 0);
    if (options.entry === "queued" || options.entry === "stopped") {
      const { reserveQueuedTask, taskQueueReservation } = await import("../src/task-queue-reservation.js");
      await reserveQueuedTask(taskQueueReservation(await taskOf()));
    }
    console.log("QUEUE_OWNER_EXIT", JSON.stringify({ pid: process.pid, entry: options.entry, request: (await taskOf()).queueAdvanceRequest }));
  } else {
    await (await import("../src/db/migrateQueues.js")).migrateQueues();
    await (await import("../src/task-reconcile.js")).reconcileInterrupted();
    await (await import("../src/pending-messages.js")).reclaimStaleDeliveries();
    await tick();
    if (options.expectedRun) {
      await until(() => hits(options.checkpoint) === 1 && !runs.isTurnClaimed(options.taskId));
      if (options.followerId) await until(() => hits(options.followerCheckpoint!) === 1 && !runs.isTurnClaimed(options.followerId!));
    } else {
      await new Promise((resolve) => setTimeout(resolve, 1_250));
      assert.equal(hits(options.checkpoint), 0);
    }
    await tick();
    assert.equal((await taskOf()).queueAdvanceRequest, null);
    assert.equal(hits(options.checkpoint), options.expectedRun ? 1 : 0);
    console.log("QUEUE_RECOVERY_EXIT", JSON.stringify({ pid: process.pid, entry: options.entry, expectedRun: options.expectedRun }));
  }
} finally {
  for (const taskId of [options.taskId, options.followerId].filter((taskId): taskId is string => !!taskId)) {
    runs.stopTask(taskId);
    await until(() => !runs.isRunning(taskId));
  }
  dbClient.close();
}
process.exit(0);
