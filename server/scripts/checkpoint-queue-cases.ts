import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import {
  api, db, hits, now, pending, rowOf, runs, scenario, schema, settled, taskOf, tasks, until,
} from "./checkpoint-recovery-fixture.js";
import { pauseGroup } from "../src/scheduler.js";
import { continueTask } from "../src/orchestrator.js";
import { monitorWakeCheckpoint } from "../src/monitor-checkpoint-handoff.js";
import { occupyResumePrompt } from "../src/task-resume-prompt.js";
import { replayQueueAdvances } from "../src/queue-advance-retry.js";
import { id } from "../src/util.js";

function owner(phase: string, options: object): void {
  const child = spawnSync(process.execPath, [
    "--import", fileURLToPath(new URL("../../node_modules/tsx/dist/loader.mjs", import.meta.url)),
    fileURLToPath(new URL("./checkpoint-queue-owner.ts", import.meta.url)), phase, JSON.stringify(options),
  ], { env: process.env, encoding: "utf8", timeout: 35_000 });
  process.stdout.write(child.stdout ?? "");
  process.stderr.write(child.stderr ?? "");
  assert.ifError(child.error);
  assert.equal(child.signal, null);
  assert.equal(child.status, 0, "独立进程保存/重放推进请求");
}

export async function checkpointQueueCases(): Promise<void> {
  const untouched = await scenario(0);
  for (const entry of ["queue", "serial-group", "queued", "paused-group", "stopped", "stopped-backlog", "new-checkpoint"]) {
    const test = await scenario(1);
    if (entry === "stopped-backlog") await db.update(tasks).set({ status: "backlog" }).where(eq(tasks.id, test.taskId));
    const expectedRun = ["queue", "serial-group", "queued"].includes(entry);
    const follower = expectedRun ? await scenario(0) : null;
    const queueId = id();
    const groupId = id();
    const task = await taskOf(test.taskId);
    await db.insert(schema.groups).values({ id: groupId, projectId: task.projectId, name: entry, mode: "serial", createdAt: now() });
    await db.update(tasks).set({ groupId }).where(eq(tasks.id, test.taskId));
    await db.insert(schema.queueItems).values({ taskId: test.taskId, queueId, position: 0, createdAt: now() });
    if (follower) {
      await db.update(tasks).set({ groupId }).where(eq(tasks.id, follower.taskId));
      await db.insert(schema.queueItems).values({ taskId: follower.taskId, queueId, position: 1, createdAt: now() });
    }
    assert.ok(await monitorWakeCheckpoint(await rowOf(test.messages[0]!.id)));
    const options = { ...test, queueId, entry, expectedRun, followerId: follower?.taskId, followerCheckpoint: follower?.checkpoint };
    owner("request", options);
    assert.ok((await taskOf(test.taskId)).queueAdvanceRequest);
    if (entry === "paused-group") {
      await pauseGroup(groupId);
      assert.equal((await taskOf(test.taskId)).queueAdvanceRequest, null);
      await db.update(schema.groups).set({ paused: false }).where(eq(schema.groups.id, groupId));
    } else if (entry === "stopped" || entry === "stopped-backlog") {
      const response = await api.request(`/tasks/${test.taskId}/stop`, { method: "POST" });
      assert.equal(response.status, 200);
      assert.equal((await taskOf(test.taskId)).status, "canceled");
      assert.equal((await taskOf(test.taskId)).queueAdvanceRequest, null);
    } else if (entry === "new-checkpoint") {
      await occupyResumePrompt(test.taskId, "REPLACED_AFTER_REQUEST", false);
    }
    owner("recover", options);
    assert.equal(hits(test.checkpoint), expectedRun ? 1 : 0);
    if (follower) assert.equal(hits(follower.checkpoint), 1);
    if (entry === "new-checkpoint") assert.equal((await taskOf(test.taskId)).resumePrompt, "REPLACED_AFTER_REQUEST");
    await db.delete(schema.queueItems).where(eq(schema.queueItems.queueId, queueId));
    console.log(`PASS: ${entry}, durable queue request survives owner exit or respects its explicit revocation`);
  }

  for (const entry of ["busy-side", "finished-native"]) {
    const test = await scenario(1);
    const queueId = id();
    await db.insert(schema.queueItems).values({ taskId: test.taskId, queueId, position: 0, createdAt: now() });
    assert.ok(await monitorWakeCheckpoint(await rowOf(test.messages[0]!.id)));
    owner("request", { ...test, queueId, entry, expectedRun: true });
    await pending.deliverPendingMessages();
    const before = await taskOf(test.taskId);
    assert.equal(before.resumePrompt, test.checkpoint);
    if (entry === "busy-side") {
      const side = continueTask(test.taskId, "等待本轮完成确认", { sideTurn: true });
      await until("旁路回合已启动", async () => (await taskOf(test.taskId)).status === "running");
      await replayQueueAdvances();
      assert.equal((await taskOf(test.taskId)).queueAdvanceRequest?.id, before.queueAdvanceRequest?.id);
      assert.equal(hits(test.checkpoint), 0);
      await side;
    } else {
      await continueTask(test.taskId, "/compact");
    }
    await settled(test.taskId);
    const after = await taskOf(test.taskId);
    assert.ok(after.directionEpoch > before.directionEpoch);
    assert.equal(after.resumePromptGeneration, before.resumePromptGeneration);
    assert.equal(after.resumePrompt, test.checkpoint);
    await replayQueueAdvances();
    await until("旁路结束后兑现原推进", async () => hits(test.checkpoint) === 1);
    await settled(test.taskId);
    assert.equal((await taskOf(test.taskId)).queueAdvanceRequest, null);
    assert.equal(runs.isRunning(test.taskId), false);
    await db.delete(schema.queueItems).where(eq(schema.queueItems.queueId, queueId));
    console.log(`PASS: ${entry}, unchanged checkpoint obligation survives a different direction epoch`);
  }
  assert.equal(hits(untouched.checkpoint), 0);
  assert.equal((await taskOf(untouched.taskId)).status, "paused");
}
