import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import {
  api, db, dbClient, failCheckpointRestore, hits, now, pending, rowOf, runs, scenario,
  scheduledMessages, schema, taskOf, tasks, until,
} from "./checkpoint-recovery-fixture.js";
import { hasPendingDeliveryRecovery } from "../src/pending-delivery-recovery.js";
import { seatThenStart } from "../src/queue-seat.js";
import { resumeOrRunTask } from "../src/task-resume.js";
import { tick } from "../src/schedules.js";
import { sessionTranscriptPath } from "../src/transcript.js";
import { id } from "../src/util.js";

export async function checkpointAdmissionCases(): Promise<void> {
  for (const entry of ["run", "fire", "retry", "schedule"]) {
    const test = await scenario(0);
    await db.update(tasks).set({ status: entry === "retry" ? "failed" : "backlog", resumePrompt: null })
      .where(eq(tasks.id, test.taskId));
    const scheduleId = id();
    if (entry === "schedule") await db.insert(schema.schedules).values({
      id: scheduleId, taskId: test.taskId, kind: "once", enabled: true, createdAt: now(),
      at: "2020-01-01T00:00:00.000Z",
    });
    const execute = dbClient.execute;
    let reads = 0;
    let failed = false;
    let previous: ReturnType<typeof runs.turnIdentity> = null;
    let successor: ReturnType<typeof runs.turnIdentity> = null;
    dbClient.execute = async function (statement) {
      if (typeof statement !== "string" && /"scheduled_messages"/.test(statement.sql)
        && /"checkpoint_taken" is not null/i.test(statement.sql) && Array.isArray(statement.args)
        && statement.args.includes(test.taskId) && ++reads === 3) {
        failed = true;
        previous = runs.turnIdentity(test.taskId);
        assert.ok(previous);
        runs.whenTurnIdle(test.taskId, () => {
          assert.ok(runs.claimTurn(test.taskId, "successor"));
          successor = runs.turnIdentity(test.taskId);
          assert.ok(runs.freezeStartingTurn(test.taskId, "paused"));
        });
        throw new Error("INJECT_REJECTED_START_WITH_SUCCESSOR");
      }
      return execute.call(dbClient, statement);
    };
    try {
      if (entry === "schedule") {
        await tick();
        const [schedule] = await db.select().from(schema.schedules).where(eq(schema.schedules.id, scheduleId));
        assert.equal(schedule!.lastRunAt, null);
        assert.equal(schedule!.enabled, true);
      } else {
        assert.equal((await api.request(`/tasks/${test.taskId}/${entry}`, { method: "POST" })).status, 409);
      }
      assert.equal(failed, true);
      assert.ok(successor);
      assert.equal(runs.turnIdentity(test.taskId), successor);
      runs.releaseTurn(test.taskId, previous);
      assert.equal(runs.turnIdentity(test.taskId), successor);
      assert.equal(runs.claimTurn(test.taskId, "duplicate"), false);
      assert.equal(runs.takeStartFreeze(test.taskId), "paused");
      assert.equal(runs.isRunning(test.taskId), false);
      assert.equal((await db.select().from(schema.sessions).where(eq(schema.sessions.taskId, test.taskId))).length, 0);
    } finally {
      dbClient.execute = execute;
      runs.releaseTurn(test.taskId, successor);
      await db.delete(schema.schedules).where(eq(schema.schedules.id, scheduleId));
    }
    console.log(`PASS: ${entry} rejected startup cannot release its synchronous successor or erase its pause`);
  }

  for (const failure of ["read", "blocked"]) {
    const test = await scenario(0);
    const blocker = await scenario(0);
    const queueId = id();
    if (failure === "blocked") {
      await db.update(tasks).set({ status: "running" }).where(eq(tasks.id, blocker.taskId));
      await db.insert(schema.queueItems).values([
        { taskId: blocker.taskId, queueId, position: 0, createdAt: now() },
        { taskId: test.taskId, queueId, position: 1, createdAt: now() },
      ]);
    }
    assert.ok(runs.claimTurn(test.taskId));
    let successor: ReturnType<typeof runs.turnIdentity> = null;
    runs.whenTurnIdle(test.taskId, () => {
      assert.ok(runs.claimTurn(test.taskId, "successor"));
      successor = runs.turnIdentity(test.taskId);
      assert.ok(runs.freezeStartingTurn(test.taskId, "canceled"));
    });
    const execute = dbClient.execute;
    let failed = false;
    if (failure === "read") dbClient.execute = async function (statement) {
      if (!failed && typeof statement !== "string" && /from "queue_items"/i.test(statement.sql)) {
        failed = true;
        throw new Error("INJECT_QUEUE_SEAT_READ_FAILURE");
      }
      return execute.call(dbClient, statement);
    };
    let started = false;
    try {
      assert.equal((await seatThenStart(test.taskId, async () => { started = true; })).ok, false);
      assert.equal(started, false);
      assert.ok(successor);
      assert.equal(runs.turnIdentity(test.taskId), successor);
      assert.equal(runs.takeStartFreeze(test.taskId), "canceled");
      if (failure === "read") assert.equal(failed, true);
    } finally {
      dbClient.execute = execute;
      runs.releaseTurn(test.taskId, successor);
      await db.delete(schema.queueItems).where(eq(schema.queueItems.queueId, queueId));
      await db.update(tasks).set({ status: "paused" }).where(eq(tasks.id, blocker.taskId));
    }
    console.log(`PASS: ${failure} seat refusal returns only its own turn without calling the startup delegate`);
  }

  for (const failRestore of [false, true]) {
    const test = await scenario(0);
    const sessionId = id();
    await db.insert(schema.sessions).values({
      id: sessionId, taskId: test.taskId, role: "single", agentType: "claude", executor: "claude", cwd: ".", startedAt: now(),
    });
    const transcriptPath = sessionTranscriptPath(test.taskId, sessionId);
    const transcript = () => existsSync(transcriptPath) ? readFileSync(transcriptPath, "utf8") : "";
    assert.ok(runs.claimTurn(test.taskId, "foreign"));
    const fault = failRestore ? failCheckpointRestore() : null;
    try {
      await resumeOrRunTask(test.taskId);
      if (fault) assert.ok(fault.count() > 0);
    } finally {
      fault?.restore();
      runs.releaseTurn(test.taskId);
    }
    await until("内部凭证归还完成", async () => !hasPendingDeliveryRecovery(test.taskId));
    assert.equal((await taskOf(test.taskId)).resumePrompt, test.checkpoint);
    const receipts = await db.select().from(scheduledMessages).where(eq(scheduledMessages.taskId, test.taskId));
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0]!.deliveringSince, null);
    assert.equal(receipts[0]!.checkpointTaken, null);
    assert.equal(hits(test.checkpoint), 0);
    assert.doesNotMatch(transcript(), /排队消息未发送，已取消/);
    assert.ok(!transcript().includes(test.checkpoint));
    const [message] = await db.insert(scheduledMessages).values({
      id: id(), taskId: test.taskId, text: "REAL_USER_QUEUED_MESSAGE", mode: "queued", status: "pending",
      sendAt: now(), createdAt: now(),
    }).returning();
    await pending.cancelPendingMessage(message!, "用户取消");
    assert.match(transcript(), /排队消息未发送，已取消/);
    assert.match(transcript(), /REAL_USER_QUEUED_MESSAGE/);
    assert.equal((await rowOf(message!.id)).status, "canceled");
    console.log(`PASS: internal checkpoint return${failRestore ? " after restore fault" : ""} stays out of user cancellation timeline`);
  }
}
