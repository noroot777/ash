import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import {
  api, db, dbClient, hits, now, runs, scenario, schema, settled, taskOf, tasks, until,
} from "./checkpoint-recovery-fixture.js";
import { advanceQueue } from "../src/scheduler.js";
import { isQueueAdvanceCanceling, requestQueueAdvance } from "../src/queue-advance-retry.js";
import { occupyResumePrompt } from "../src/task-resume-prompt.js";
import { id } from "../src/util.js";

export async function checkpointAdvanceAdmissionCases(): Promise<void> {
  {
    const test = await scenario(0);
    const queueId = id();
    await db.insert(schema.queueItems).values({ taskId: test.taskId, queueId, position: 0, createdAt: now() });
    const execute = dbClient.execute;
    let interrupted = false;
    dbClient.execute = async function (statement) {
      const result = await execute.call(dbClient, statement);
      if (!interrupted && isQueueAdvanceCanceling(test.taskId) && typeof statement !== "string"
        && /from "tasks" where/i.test(statement.sql) && Array.isArray(statement.args) && statement.args.includes(test.taskId)) {
        interrupted = true;
        await advanceQueue(queueId);
        const task = await taskOf(test.taskId);
        assert.ok(task.queueAdvanceRequest?.id);
        assert.equal(task.queueAdvanceRequest!.resumePromptGeneration, task.resumePromptGeneration);
        assert.equal(task.status, "paused");
        assert.equal(runs.isTurnClaimed(test.taskId), false);
        assert.equal(hits(test.checkpoint), 0);
      }
      return result;
    };
    try {
      assert.equal((await api.request(`/tasks/${test.taskId}/stop`, { method: "POST" })).status, 409);
      assert.equal(interrupted, true);
      assert.ok((await taskOf(test.taskId)).queueAdvanceRequest);
    } finally {
      dbClient.execute = execute;
    }
    assert.equal(isQueueAdvanceCanceling(test.taskId), false);
    await until("短暂停止窗口之后持久补推", async () => hits(test.checkpoint) === 1);
    await settled(test.taskId);
    assert.equal((await taskOf(test.taskId)).queueAdvanceRequest, null);
    await db.delete(schema.queueItems).where(eq(schema.queueItems.queueId, queueId));
    console.log("PASS: real stop returning 409 cannot discard concurrent queue advancement before it is persisted");
  }

  {
    const test = await scenario(0);
    const queueId = id();
    const replacement = `LATEST_${id()}`;
    const before = await taskOf(test.taskId);
    await db.insert(schema.queueItems).values({ taskId: test.taskId, queueId, position: 0, createdAt: now() });
    assert.ok(runs.claimTurn(test.taskId, "foreign"));
    const transaction = dbClient.transaction;
    let changed = false;
    dbClient.transaction = async function (...args) {
      if (!changed) {
        changed = true;
        await occupyResumePrompt(test.taskId, replacement, false);
      }
      return transaction.apply(dbClient, args);
    };
    try {
      await advanceQueue(queueId);
      assert.equal(changed, true);
      const task = await taskOf(test.taskId);
      assert.ok(task.resumePromptGeneration > before.resumePromptGeneration);
      assert.equal(task.queueAdvanceRequest?.resumePromptGeneration, task.resumePromptGeneration);
      assert.ok(task.queueAdvanceRequest?.id);
      assert.equal(task.resumePrompt, replacement);
      assert.equal(hits(replacement), 0);
    } finally {
      dbClient.transaction = transaction;
      runs.releaseTurn(test.taskId);
    }
    await until("选择候选后代次变化仍可持久补推", async () => hits(replacement) === 1);
    await settled(test.taskId);
    assert.equal(hits(test.checkpoint), 0);
    assert.equal((await taskOf(test.taskId)).queueAdvanceRequest, null);
    await db.delete(schema.queueItems).where(eq(schema.queueItems.queueId, queueId));
    console.log("PASS: admission persists the latest checkpoint generation instead of dropping a stale candidate snapshot");
  }

  for (const permanent of ["archive", "done", "failed", "canceled", "group-pause"]) {
    const test = await scenario(0);
    const candidate = await taskOf(test.taskId);
    const groupId = id();
    if (permanent === "archive") await db.update(tasks).set({ archived: true }).where(eq(tasks.id, test.taskId));
    else if (permanent === "group-pause") {
      await db.insert(schema.groups).values({
        id: groupId, projectId: candidate.projectId, name: permanent, mode: "serial", paused: true, createdAt: now(),
      });
      await db.update(tasks).set({ groupId }).where(eq(tasks.id, test.taskId));
    } else await db.update(tasks).set({ status: permanent }).where(eq(tasks.id, test.taskId));
    assert.equal(await requestQueueAdvance(id(), candidate), null);
    assert.equal((await taskOf(test.taskId)).queueAdvanceRequest, null);
    assert.equal(hits(test.checkpoint), 0);
    console.log(`PASS: permanent ${permanent} still refuses durable queue admission`);
  }
}
