import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import {
  db, dbClient, hits, now, runs, scenario, schema, settled, taskOf, tasks, until,
} from "./checkpoint-recovery-fixture.js";
import { advanceQueue, pauseGroup } from "../src/scheduler.js";
import { requestQueueAdvance } from "../src/queue-advance-retry.js";
import { occupyResumePrompt } from "../src/task-resume-prompt.js";
import { setTaskStatus } from "../src/status.js";
import { id } from "../src/util.js";

function failRequestWrites(taskId: string, limit = 1) {
  const transaction = dbClient.transaction;
  let failures = 0;
  dbClient.transaction = async function (...args) {
    const active = await transaction.apply(dbClient, args);
    const execute = active.execute.bind(active);
    active.execute = async (statement) => {
      if (failures < limit && typeof statement !== "string" && Array.isArray(statement.args)
        && /^update "tasks" set "queue_advance_request" =/i.test(statement.sql) && statement.args.includes(taskId)) {
        failures++;
        throw new Error("INJECT_ADVANCE_REQUEST_WRITE_FAILURE");
      }
      return execute(statement);
    };
    return active;
  };
  return { count: () => failures, restore: () => { dbClient.transaction = transaction; } };
}

export async function checkpointAdvanceFailureCases(): Promise<void> {
  for (const entry of ["terminal", "direct", "read", "begin"]) {
    const test = await scenario(0);
    const queueId = id();
    await db.insert(schema.queueItems).values({ taskId: test.taskId, queueId, position: 1, createdAt: now() });
    const previous = entry === "terminal" ? await scenario(0) : null;
    if (previous) await db.insert(schema.queueItems).values({ taskId: previous.taskId, queueId, position: 0, createdAt: now() });
    const execute = dbClient.execute;
    const transaction = dbClient.transaction;
    const fault = entry === "terminal" || entry === "direct" ? failRequestWrites(test.taskId, 2) : null;
    let failures = 0;
    if (entry === "read") dbClient.execute = async function (statement) {
      if (!failures && typeof statement !== "string" && /from "queue_items"/i.test(statement.sql)
        && Array.isArray(statement.args) && statement.args.includes(queueId)) {
        failures++;
        throw new Error("INJECT_QUEUE_MEMBERS_READ_FAILURE");
      }
      return execute.call(dbClient, statement);
    };
    if (entry === "begin") dbClient.transaction = async function (...args) {
      if (!failures++) throw new Error("INJECT_ADVANCE_TRANSACTION_BEGIN_FAILURE");
      return transaction.apply(dbClient, args);
    };
    try {
      if (previous) {
        await setTaskStatus(previous.taskId, "done");
        await until("终态钩子的首次推进写失败", async () => fault!.count() > 0);
      } else await advanceQueue(queueId);
      assert.equal((await taskOf(test.taskId)).queueAdvanceRequest, null);
      assert.equal(hits(test.checkpoint), 0);
      assert.equal(runs.isTurnClaimed(test.taskId), false);
      if (fault) {
        await until("重复写失败仍保留退避", async () => fault.count() === 2);
        fault.restore();
      }
      await until("不再手动触发也能重入完整临界区", async () => hits(test.checkpoint) === 1);
      await settled(test.taskId);
      assert.equal((await taskOf(test.taskId)).queueAdvanceRequest, null);
      assert.equal((await taskOf(test.taskId)).queueSeatToken, null);
      if (!fault) assert.ok(failures > 0);
    } finally {
      dbClient.execute = execute;
      dbClient.transaction = transaction;
      await db.delete(schema.queueItems).where(eq(schema.queueItems.queueId, queueId));
    }
    console.log(`PASS: ${entry} queue critical-section failure retries before any durable request exists`);
  }

  for (const revocation of ["group-pause", "checkpoint-replaced"]) {
    const test = await scenario(0);
    const task = await taskOf(test.taskId);
    const queueId = id();
    const groupId = id();
    await db.insert(schema.groups).values({ id: groupId, projectId: task.projectId, name: revocation, mode: "serial", createdAt: now() });
    await db.update(tasks).set({ groupId }).where(eq(tasks.id, test.taskId));
    await db.insert(schema.queueItems).values({ taskId: test.taskId, queueId, position: 0, createdAt: now() });
    const fault = failRequestWrites(test.taskId);
    try {
      await advanceQueue(queueId);
      assert.equal(fault.count(), 1);
    } finally {
      fault.restore();
    }
    if (revocation === "group-pause") {
      await pauseGroup(groupId);
      await db.update(schema.groups).set({ paused: false }).where(eq(schema.groups.id, groupId));
    } else await occupyResumePrompt(test.taskId, "REPLACED_AFTER_FAILED_ADMISSION", false);
    await new Promise((resolve) => setTimeout(resolve, 1_250));
    assert.equal((await taskOf(test.taskId)).queueAdvanceRequest, null);
    assert.equal(hits(test.checkpoint), 0);
    assert.equal(hits("REPLACED_AFTER_FAILED_ADMISSION"), 0);
    assert.equal(runs.isTurnClaimed(test.taskId), false);
    await db.delete(schema.queueItems).where(eq(schema.queueItems.queueId, queueId));
    console.log(`PASS: failed admission retry respects later ${revocation} instead of resurrecting canceled intent`);
  }

  {
    const test = await scenario(0);
    const queueId = id();
    await db.insert(schema.queueItems).values({ taskId: test.taskId, queueId, position: 0, createdAt: now() });
    const request = await requestQueueAdvance(queueId, await taskOf(test.taskId));
    assert.ok(request);
    await occupyResumePrompt(test.taskId, "KEEP_NEW_CHECKPOINT_PAUSED", false);
    const execute = dbClient.execute;
    let failed = false;
    dbClient.execute = async function (statement) {
      if (!failed && typeof statement !== "string" && /^update "tasks" set "queue_advance_request" =/i.test(statement.sql)
        && Array.isArray(statement.args) && statement.args[0] === null && statement.args.includes(test.taskId)) {
        failed = true;
        throw new Error("INJECT_STALE_ADVANCE_CLEAR_FAILURE");
      }
      return execute.call(dbClient, statement);
    };
    try {
      await advanceQueue(queueId, request);
      assert.equal(failed, true);
    } finally {
      dbClient.execute = execute;
    }
    await until("旧请求异常收口仍携带旧身份清账", async () => (await taskOf(test.taskId)).queueAdvanceRequest === null);
    assert.equal((await taskOf(test.taskId)).resumePrompt, "KEEP_NEW_CHECKPOINT_PAUSED");
    assert.equal(hits("KEEP_NEW_CHECKPOINT_PAUSED"), 0);
    await db.delete(schema.queueItems).where(eq(schema.queueItems.queueId, queueId));
    console.log("PASS: failed stale-request cleanup replays the same identity, not a fresh unscoped queue advance");
  }
}
