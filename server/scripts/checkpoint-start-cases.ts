import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import {
  api, db, dbClient, failCheckpointRestore, hits, now, pending, rowOf, runs, scenario,
  scheduledMessages, schema, settled, taskOf, tasks, until,
} from "./checkpoint-recovery-fixture.js";
import { tick } from "../src/schedules.js";
import { advanceQueue, pauseGroup, runGroup } from "../src/scheduler.js";
import { cancelPendingMonitorEvents } from "../src/monitor-events.js";
import { monitorWakeCheckpoint } from "../src/monitor-checkpoint-handoff.js";
import { preparePendingCheckpointStart } from "../src/pending-checkpoint-recovery.js";
import { occupyResumePrompt } from "../src/task-resume-prompt.js";
import { reserveQueuedTask, restoreQueuedTask, taskQueueReservation } from "../src/task-queue-reservation.js";
import { setTaskStatus } from "../src/status.js";
import { sweepLaunchRequests } from "../src/launch-request.js";
import { id } from "../src/util.js";

function failAdmission(taskId: string, at = 3) {
  const execute = dbClient.execute;
  let reads = 0;
  let failures = 0;
  dbClient.execute = async function (statement) {
    if (typeof statement !== "string" && /"scheduled_messages"/.test(statement.sql)
      && /"checkpoint_taken" is not null/i.test(statement.sql) && Array.isArray(statement.args) && statement.args.includes(taskId)) {
      if (++reads === at) {
        failures++;
        throw new Error("INJECT_INNER_START_ADMISSION_FAILURE");
      }
    }
    return execute.call(dbClient, statement);
  };
  return { count: () => failures, restore: () => { dbClient.execute = execute; } };
}

async function freshTask(status = "backlog") {
  const test = await scenario(0);
  await db.update(tasks).set({ status, resumePrompt: null, body: "保持运行等待引导" }).where(eq(tasks.id, test.taskId));
  return test;
}

export async function checkpointStartCases(): Promise<void> {
  for (const kind of ["once", "cron"]) {
    const test = await freshTask();
    const scheduleId = id();
    await db.insert(schema.schedules).values({
      id: scheduleId, taskId: test.taskId, kind, enabled: true, createdAt: now(),
      ...(kind === "once" ? { at: "2020-01-01T00:00:00.000Z" } : { cron: "* * * * *" }),
    });
    const fault = failAdmission(test.taskId);
    try {
      await tick();
      assert.equal(fault.count(), 1);
      const schedule = (await db.select().from(schema.schedules).where(eq(schema.schedules.id, scheduleId)))[0]!;
      assert.equal(schedule.enabled, true);
      assert.equal(schedule.lastRunAt, null);
      assert.equal((await taskOf(test.taskId)).status, "backlog");
      assert.equal(runs.isTurnClaimed(test.taskId), false);
      assert.equal((await db.select().from(schema.sessions).where(eq(schema.sessions.taskId, test.taskId))).length, 0);
    } finally {
      fault.restore();
    }
    await tick();
    const schedule = (await db.select().from(schema.schedules).where(eq(schema.schedules.id, scheduleId)))[0]!;
    assert.ok(schedule.lastRunAt);
    assert.equal(schedule.enabled, kind !== "once");
    assert.equal(runs.isRunning(test.taskId), true, "启动握手不等待整轮执行完成");
    runs.stopTask(test.taskId);
    await settled(test.taskId);
    await db.delete(schema.schedules).where(eq(schema.schedules.id, scheduleId));
    console.log(`PASS: ${kind} rejected inner startup remains due, later startup acknowledged before completion`);
  }

  for (const route of ["run", "fire", "retry"]) {
    const test = await freshTask(route === "retry" ? "failed" : "backlog");
    const fault = failAdmission(test.taskId);
    try {
      const response = await api.request(`/tasks/${test.taskId}/${route}`, { method: "POST" });
      assert.equal(fault.count(), 1);
      assert.equal(response.status, 409);
      assert.equal(runs.isTurnClaimed(test.taskId), false);
      assert.equal(runs.isRunning(test.taskId), false);
      assert.equal((await db.select().from(schema.sessions).where(eq(schema.sessions.taskId, test.taskId))).length, 0);
    } finally {
      fault.restore();
    }
    console.log(`PASS: /${route} reports rejection instead of accepting an unstarted task`);
  }

  {
    const test = await freshTask();
    const fault = failAdmission(test.taskId, 1);
    try {
      const reason = await preparePendingCheckpointStart(test.taskId);
      assert.match(reason!, /无法确认/);
      assert.doesNotMatch(reason!, /原文仍保存/);
    } finally {
      fault.restore();
    }
  }

  {
    // 运行分组起到一半（回合已经认领、续跑交代的准入检查读失败）时用户点了停止：那一次起跑冻住、请求撤回、
    // 落 canceled。没起来的那一下不算「起不来」去退避重试 —— 请求已经没了，之后再扫、腾出名额都不会再起它。
    const test = await freshTask();
    const groupId = id();
    const task = await taskOf(test.taskId);
    await db.insert(schema.groups).values({ id: groupId, projectId: task.projectId, name: "stop-race", mode: "parallel", createdAt: now() });
    await db.update(tasks).set({ groupId }).where(eq(tasks.id, test.taskId));
    const execute = dbClient.execute;
    let stopped = false;
    dbClient.execute = async function (statement) {
      if (!stopped && typeof statement !== "string" && /"scheduled_messages"/.test(statement.sql)
        && /"checkpoint_taken" is not null/i.test(statement.sql) && Array.isArray(statement.args)
        && statement.args.includes(test.taskId) && runs.isTurnClaimed(test.taskId)) {
        stopped = true;
        const response = await api.request(`/tasks/${test.taskId}/stop`, { method: "POST" });
        assert.equal(response.status, 200);
        assert.equal((await taskOf(test.taskId)).status, "canceled");
        throw new Error("INJECT_INNER_START_ADMISSION_FAILURE");
      }
      return execute.call(dbClient, statement);
    };
    try {
      await runGroup(groupId);
      assert.equal(stopped, true);
      await until("停下的那一次起跑收口", async () => !runs.isTurnClaimed(test.taskId));
      await sweepLaunchRequests();
      await new Promise((resolve) => setTimeout(resolve, 300));
      const launch = (await db.select().from(schema.taskPrerequisiteLaunches)
        .where(eq(schema.taskPrerequisiteLaunches.taskId, test.taskId))).at(0);
      assert.equal(launch?.requestedAt ?? null, null);
      assert.equal(launch?.startFailures ?? 0, 0, "停下不算一次起不来");
      assert.equal((await taskOf(test.taskId)).status, "canceled");
      assert.equal((await taskOf(test.taskId)).queueSeatToken, null);
      assert.equal(runs.isTurnClaimed(test.taskId), false);
      assert.equal(runs.isRunning(test.taskId), false);
    } finally {
      dbClient.execute = execute;
    }
    console.log("PASS: real stop during a group start stays canceled and the withdrawn request never starts it later");
  }

  {
    const test = await freshTask();
    const previous = taskQueueReservation(await taskOf(test.taskId));
    await reserveQueuedTask(previous);
    await setTaskStatus(test.taskId, "backlog");
    const current = taskQueueReservation(await taskOf(test.taskId));
    await reserveQueuedTask(current);
    assert.equal(await restoreQueuedTask(previous), false);
    assert.equal((await taskOf(test.taskId)).queueSeatToken, current.token);
    assert.equal((await taskOf(test.taskId)).status, "queued");
    assert.equal(await restoreQueuedTask(current), true);
    console.log("PASS: a stale reservation cannot roll back a later queued occupancy in the same direction epoch");
  }

  for (const entry of ["queue", "serial-group", "paused-group", "new-checkpoint"]) {
    const test = await scenario(1);
    const follower = await scenario(0);
    const queueId = id();
    const groupId = id();
    const task = await taskOf(test.taskId);
    await db.insert(schema.groups).values({ id: groupId, projectId: task.projectId, name: entry, mode: "serial", createdAt: now() });
    for (const member of [test, follower]) await db.update(tasks).set({ groupId }).where(eq(tasks.id, member.taskId));
    await db.insert(schema.queueItems).values([
      { taskId: test.taskId, queueId, position: 0, createdAt: now() },
      { taskId: follower.taskId, queueId, position: 1, createdAt: now() },
    ]);
    assert.ok(await monitorWakeCheckpoint(await rowOf(test.messages[0]!.id)));
    const fault = failCheckpointRestore();
    try {
      await cancelPendingMonitorEvents(test.taskId);
      if (entry === "serial-group") await runGroup(groupId);
      else await advanceQueue(queueId);
      assert.ok(fault.count() > 0);
      assert.equal((await taskOf(test.taskId)).status, "paused");
      assert.equal((await rowOf(test.messages[0]!.id)).status, "canceled");
      assert.equal(hits(test.checkpoint), 0);
      if (entry === "paused-group") await pauseGroup(groupId);
      if (entry === "new-checkpoint") await occupyResumePrompt(test.taskId, "EXPLICIT_REPLACEMENT", false);
    } finally {
      fault.restore();
    }
    await pending.deliverPendingMessages();
    if (entry === "paused-group" || entry === "new-checkpoint") {
      await new Promise((resolve) => setTimeout(resolve, 1_250));
      assert.equal(hits(test.checkpoint), 0);
      assert.equal(hits(follower.checkpoint), 0);
      assert.equal((await taskOf(test.taskId)).status, "paused");
      if (entry === "new-checkpoint") {
        assert.equal((await taskOf(test.taskId)).resumePrompt, "EXPLICIT_REPLACEMENT");
        continue;
      }
      await db.update(schema.groups).set({ paused: false }).where(eq(schema.groups.id, groupId));
      await runGroup(groupId);
    }
    await until("已请求的队列推进在归还后自动补办", async () => hits(test.checkpoint) === 1);
    await settled(test.taskId);
    await until("后项接到真实推进", async () => hits(follower.checkpoint) === 1);
    await settled(follower.taskId);
    assert.equal(hits(test.messages[0]!.text), 0);
    assert.equal((await rowOf(test.messages[0]!.id)).checkpointTaken, null);
    await db.delete(schema.queueItems).where(eq(schema.queueItems.queueId, queueId));
    console.log(`PASS: ${entry}, canceled-only recovery retries the requested advance without overriding explicit waits`);
  }
  assert.equal((await db.select().from(scheduledMessages)).some((row) => row.deliveringSince), false);
}
