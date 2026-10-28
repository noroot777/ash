import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import {
  api, db, dbClient, failCheckpointRestore, hits, now, pending, rowOf, runs, scenario,
  schema, settled, taskOf, tasks, until,
} from "./checkpoint-recovery-fixture.js";
import { advanceQueue, reclaimStrandedSeat } from "../src/scheduler.js";
import { serializeQueueClaims } from "../src/queue-seat.js";
import { reserveQueuedTask, taskQueueReservation } from "../src/task-queue-reservation.js";
import { cancelPendingMonitorEvents } from "../src/monitor-events.js";
import { monitorWakeCheckpoint } from "../src/monitor-checkpoint-handoff.js";
import { continueTask } from "../src/orchestrator.js";
import { setTaskStatus } from "../src/status.js";
import { id } from "../src/util.js";

async function deferred(status = "paused") {
  const test = await scenario(1);
  const queueId = id();
  await db.update(tasks).set({ status }).where(eq(tasks.id, test.taskId));
  await db.insert(schema.queueItems).values({ taskId: test.taskId, queueId, position: 0, createdAt: now() });
  assert.ok(await monitorWakeCheckpoint(await rowOf(test.messages[0]!.id)));
  const fault = failCheckpointRestore();
  try {
    await cancelPendingMonitorEvents(test.taskId);
    await advanceQueue(queueId);
    assert.ok(fault.count() > 0);
    assert.equal((await taskOf(test.taskId)).status, status);
    const request = (await taskOf(test.taskId)).queueAdvanceRequest!;
    assert.ok(request?.id);
    assert.equal(runs.isTurnClaimed(test.taskId), false);
    return { ...test, queueId, request: { ...request, taskId: test.taskId }, fault };
  } catch (error) {
    fault.restore();
    throw error;
  }
}

async function stopped(test: Awaited<ReturnType<typeof deferred>>): Promise<void> {
  await settled(test.taskId);
  await new Promise((resolve) => setTimeout(resolve, 1_250));
  assert.equal(hits(test.checkpoint), 0);
  assert.equal((await taskOf(test.taskId)).status, "canceled");
  assert.equal((await taskOf(test.taskId)).queueAdvanceRequest, null);
  assert.equal(runs.isRunning(test.taskId), false);
  assert.equal((await db.select().from(schema.sessions).where(eq(schema.sessions.taskId, test.taskId))).length, 0);
  await db.delete(schema.queueItems).where(eq(schema.queueItems.queueId, test.queueId));
}

export async function checkpointStopCases(): Promise<void> {
  for (const status of ["paused", "backlog"]) {
    const test = await deferred(status);
    try {
      const response = await api.request(`/tasks/${test.taskId}/stop`, { method: "POST" });
      assert.equal(response.status, 200);
      assert.equal((await taskOf(test.taskId)).status, "canceled");
      assert.equal((await taskOf(test.taskId)).queueAdvanceRequest, null);
    } finally {
      test.fault.restore();
    }
    await pending.deliverPendingMessages();
    await advanceQueue(test.queueId, test.request);
    await stopped(test);
    console.log(`PASS: stop natural ${status} queue request before any occupancy, timer and stale replay stay canceled`);
  }

  {
    const test = await deferred();
    const execute = dbClient.execute;
    let failed = false;
    dbClient.execute = async function (statement) {
      if (!failed && typeof statement !== "string" && Array.isArray(statement.args) && /^update "tasks" set "status" = \?/i.test(statement.sql)
        && statement.args[0] === "canceled" && statement.args.includes(test.taskId)) {
        failed = true;
        throw new Error("INJECT_PENDING_STOP_WRITE_FAILURE");
      }
      return execute.call(dbClient, statement);
    };
    try {
      const response = await api.request(`/tasks/${test.taskId}/stop`, { method: "POST" });
      assert.equal(response.status, 500);
      assert.equal(failed, true);
      assert.equal((await taskOf(test.taskId)).status, "paused");
      assert.equal((await taskOf(test.taskId)).queueAdvanceRequest?.id, test.request.id);
    } finally {
      dbClient.execute = execute;
    }
    try {
      assert.equal((await api.request(`/tasks/${test.taskId}/stop`, { method: "POST" })).status, 200);
    } finally {
      test.fault.restore();
    }
    await stopped(test);
    console.log("PASS: failed stop write retains both old status and obligation, later stop cancels atomically");
  }

  {
    const test = await deferred();
    test.fault.restore();
    const reservation = taskQueueReservation(await taskOf(test.taskId), test.request);
    const execute = dbClient.execute;
    let interrupted = false;
    dbClient.execute = async function (statement) {
      if (!interrupted && typeof statement !== "string" && Array.isArray(statement.args) && /^update "tasks" set "status" = \?/i.test(statement.sql)
        && statement.args[0] === "queued" && statement.args.includes(test.taskId)) {
        interrupted = true;
        assert.equal((await api.request(`/tasks/${test.taskId}/stop`, { method: "POST" })).status, 200);
        assert.equal((await taskOf(test.taskId)).queueAdvanceRequest, null);
      }
      return execute.call(dbClient, statement);
    };
    try {
      await advanceQueue(test.queueId, test.request);
      assert.equal(interrupted, true);
    } finally {
      dbClient.execute = execute;
    }
    await new Promise((resolve) => setImmediate(resolve));
    await serializeQueueClaims(async () => undefined);
    assert.equal((await taskOf(test.taskId)).status, "canceled");
    await setTaskStatus(test.taskId, "paused", { quietAdvance: true });
    assert.equal((await taskOf(test.taskId)).directionEpoch, reservation.epoch);
    await assert.rejects(reserveQueuedTask(reservation), /启动占位已撤销/);
    await reclaimStrandedSeat(test.taskId, test.queueId, "paused", { repush: "always", reservation });
    await new Promise((resolve) => setTimeout(resolve, 2_250));
    assert.equal((await taskOf(test.taskId)).status, "paused");
    assert.equal((await taskOf(test.taskId)).queueAdvanceRequest, null);
    assert.equal(hits(test.checkpoint), 0);
    assert.equal(runs.isTurnClaimed(test.taskId), false);
    await db.delete(schema.queueItems).where(eq(schema.queueItems.queueId, test.queueId));
    console.log("PASS: stop before stale queued write fences request identity even after same-epoch status ABA and delayed reclaim");
  }

  for (const entry of ["cancel-write", "execution-spawn", "side-spawn"]) {
    const test = await deferred();
    test.fault.restore();
    await pending.deliverPendingMessages();
    const execute = dbClient.execute;
    let interrupted = false;
    dbClient.execute = async function (statement) {
      const target = entry === "cancel-write" ? "canceled" : "running";
      if (!interrupted && typeof statement !== "string" && Array.isArray(statement.args) && /^update "tasks" set "status" = \?/i.test(statement.sql)
        && statement.args[0] === target && statement.args.includes(test.taskId)) {
        interrupted = true;
        if (entry === "cancel-write") await advanceQueue(test.queueId, test.request);
        else assert.equal((await api.request(`/tasks/${test.taskId}/stop`, { method: "POST" })).status, 200);
      }
      return execute.call(dbClient, statement);
    };
    try {
      if (entry === "cancel-write") {
        assert.equal((await api.request(`/tasks/${test.taskId}/stop`, { method: "POST" })).status, 200);
      } else if (entry === "side-spawn") {
        await continueTask(test.taskId, "SIDE_SHOULD_NOT_SPAWN", { sideTurn: true });
      } else {
        await advanceQueue(test.queueId, test.request);
        await until("停止穿过已占位但未 spawn 的回合", async () => interrupted && !runs.isTurnClaimed(test.taskId));
      }
      assert.equal(interrupted, true);
    } finally {
      dbClient.execute = execute;
    }
    await stopped(test);
    console.log(`PASS: ${entry}, in-flight stop/replay or pre-spawn work cannot resurrect the canceled request`);
  }

  const inactive = await scenario(0);
  assert.equal((await api.request(`/tasks/${inactive.taskId}/stop`, { method: "POST" })).status, 409);
  assert.equal((await taskOf(inactive.taskId)).status, "paused");
}
