import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import {
  api, cleanup, db, dbClient, failCheckpointRestore, hits, input, now, pending,
  rejectedDelivery, rowOf, runs, scenario, scheduledMessages, schema, settled, taskOf, tasks, until,
} from "./checkpoint-recovery-fixture.js";
import { resumeOrRunTask } from "../src/task-resume.js";
import { continueTask, runTask } from "../src/orchestrator.js";
import { hasPendingDeliveryRecovery } from "../src/pending-delivery-recovery.js";
import { checkpointReadyTask, preparePendingCheckpointStart } from "../src/pending-checkpoint-recovery.js";
import { occupyResumePrompt, writeResumePrompt } from "../src/task-resume-prompt.js";
import { cancelPendingMonitorEvents } from "../src/monitor-events.js";
import { advanceQueue, runGroup } from "../src/scheduler.js";
import { claimCheckpointForRun } from "../src/task-checkpoint-delivery.js";
import { enterLeadDelivery, enterTurn } from "../src/turn-entry-guard.js";
import { monitorWakeCheckpoint } from "../src/monitor-checkpoint-handoff.js";
import { id } from "../src/util.js";
import { checkpointStartCases } from "./checkpoint-start-cases.js";

function owner(mode: string, taskId: string, messageId = ""): void {
  const child = spawnSync(process.execPath, [
    "--import", fileURLToPath(new URL("../../node_modules/tsx/dist/loader.mjs", import.meta.url)),
    fileURLToPath(new URL("./checkpoint-recovery-owner.ts", import.meta.url)), mode, taskId, messageId,
  ], { env: process.env, encoding: "utf8", timeout: 30_000 });
  process.stdout.write(child.stdout ?? "");
  process.stderr.write(child.stderr ?? "");
  assert.ifError(child.error);
  assert.equal(child.signal, null);
  assert.equal(child.status, 0, "真实所有者进程留下持久凭证后退出");
}

async function resultsDelivered(test: Awaited<ReturnType<typeof scenario>>): Promise<void> {
  await until("旧补偿闭包退出", async () => !hasPendingDeliveryRecovery(test.taskId));
  await pending.deliverPendingMessages(test.taskId);
  await until("有效结果送达", async () => {
    const rows = await db.select().from(scheduledMessages).where(eq(scheduledMessages.taskId, test.taskId));
    return rows.filter((row) => row.origin?.startsWith("monitor:")).every((row) => row.status === "sent");
  });
  await settled(test.taskId);
}

try {
  await checkpointStartCases();
  for (const size of [1, 2]) {
    for (const route of ["run", "retry"] as const) {
      const test = await scenario(size);
      const fault = failCheckpointRestore();
      try {
        await rejectedDelivery(test);
        if (route === "retry") await db.update(tasks).set({ status: "failed" }).where(eq(tasks.id, test.taskId));
        const generation = (await taskOf(test.taskId)).resumePromptGeneration;
        const response = await api.request(`/tasks/${test.taskId}/${route}`, { method: "POST" });
        assert.equal(response.status, 409);
        assert.equal((await response.json()).checkpoint, true);
        assert.equal(runs.isTurnClaimed(test.taskId), false);
        assert.equal(hits(test.checkpoint), 0);
        assert.equal(await writeResumePrompt(test.taskId, "NEW_AUTOMATIC_WAIT", true), false);
        assert.equal((await taskOf(test.taskId)).resumePromptGeneration, generation);
        assert.ok(fault.count() > 0);
      } finally {
        fault.restore();
      }
      const response = await api.request(`/tasks/${test.taskId}/${route}`, { method: "POST" });
      assert.equal(response.status, 202);
      await until("手动续跑收到原交代", async () => hits(test.checkpoint) === 1);
      await settled(test.taskId);
      await resultsDelivered(test);
      assert.equal(hits(test.checkpoint), 1);
      for (const message of test.messages) assert.equal(hits(message.text), 1);
      console.log(`PASS: ${size} result(s), real /${route}, durable refusal and checkpoint takeover`);
    }
  }

  for (const reason of ["queue", "group", "wake"] as const) {
    const test = await scenario(2);
    const fault = failCheckpointRestore();
    try {
      await rejectedDelivery(test);
      assert.ok(runs.claimTurn(test.taskId));
      await assert.rejects(resumeOrRunTask(test.taskId, { reason, turnHeld: true }), /续跑交代/);
      assert.equal(runs.isTurnClaimed(test.taskId), false);
      assert.equal(await continueTask(test.taskId, "BYPASS_INPUT", { system: reason }), false);
      assert.ok(runs.claimTurn(test.taskId));
      await runTask(test.taskId, { turnHeld: true });
      assert.equal(runs.isTurnClaimed(test.taskId), false);
      assert.equal(input().includes("BYPASS_INPUT"), false);
      assert.equal(hits(test.checkpoint), 0);
      assert.equal((await rowOf(test.messages[0]!.id)).checkpointTaken, test.checkpoint);
      assert.equal(await checkpointReadyTask(test.taskId), null);
      const retry = await api.request(`/tasks/${test.taskId}/retry-turn`, { method: "POST" });
      assert.equal(retry.status, 409);
      assert.equal((await retry.json()).checkpoint, true);
      const fire = await api.request(`/tasks/${test.taskId}/fire`, { method: "POST" });
      assert.equal(fire.status, 409);
    } finally {
      fault.restore();
    }
    await resumeOrRunTask(test.taskId, { reason });
    await until("公共续跑入口带回交代", async () => hits(test.checkpoint) === 1);
    await settled(test.taskId);
    await resultsDelivered(test);
    assert.equal(hits(test.checkpoint), 1);
  }
  console.log("PASS: queue/group/wake admission, direct continuation, fresh start and retry-turn cannot bypass ownership");

  for (const mode of ["single", "team"]) {
    const test = await scenario(2, mode);
    const fault = failCheckpointRestore();
    try {
      await rejectedDelivery(test);
      await cancelPendingMonitorEvents(test.taskId);
      assert.equal((await rowOf(test.messages[0]!.id)).status, "canceled");
      assert.equal((await rowOf(test.messages[0]!.id)).checkpointTaken, test.checkpoint);
      assert.equal(await enterTurn({ taskId: test.taskId, source: { role: "single" } }), false);
      assert.equal(await enterLeadDelivery({ taskId: test.taskId }), null);
      assert.equal(runs.isTurnClaimed(test.taskId), false);
    } finally {
      fault.restore();
    }
    await pending.deliverPendingMessages();
    assert.equal((await taskOf(test.taskId)).resumePrompt, test.checkpoint);
    assert.equal((await taskOf(test.taskId)).resumePromptAuto, false);
    assert.equal((await rowOf(test.messages[0]!.id)).checkpointTaken, null);
    await until("取消后补偿退出", async () => !hasPendingDeliveryRecovery(test.taskId));
  }
  console.log("PASS: canceled-only recovery for single/team, both low-level admission gates and periodic scan");

  for (const mode of ["none", "single", "batch", "all"]) {
    for (const size of mode === "all" ? [1, 2] : [2]) {
      const test = await scenario(size);
      owner(mode, test.taskId, test.messages[0]!.id);
      assert.equal(hasPendingDeliveryRecovery(test.taskId), false);
      const fault = failCheckpointRestore();
      try {
        await pending.reclaimStaleDeliveries();
        const blocked = await api.request(`/tasks/${test.taskId}/run`, { method: "POST" });
        assert.equal(blocked.status, 409);
        assert.equal(hits(test.checkpoint), 0);
      } finally {
        fault.restore();
      }
      await pending.deliverPendingMessages();
      if (mode === "all") {
        assert.equal((await taskOf(test.taskId)).resumePrompt, test.checkpoint);
        assert.equal((await rowOf(test.messages[0]!.id)).checkpointTaken, null);
        const response = await api.request(`/tasks/${test.taskId}/run`, { method: "POST" });
        assert.equal(response.status, 202);
      }
      await until("重启后的原交代实际进 stdin", async () => hits(test.checkpoint) === 1);
      await settled(test.taskId);
      assert.equal(hits(test.checkpoint), 1);
      for (const [index, message] of test.messages.entries()) {
        const canceled = mode === "all" || (mode !== "none" && index === 0);
        await until("取消/投递状态收敛", async () => (await rowOf(message.id)).status === (canceled ? "canceled" : "sent"));
        assert.equal(hits(message.text), canceled ? 0 : 1);
      }
      console.log(`PASS: process exit, ${mode} cancellation, ${size} result(s), failed startup recovery then periodic takeover`);
    }
  }

  {
    const test = await scenario(0);
    owner("run-owner", test.taskId);
    assert.equal((await taskOf(test.taskId)).resumePrompt, null);
    assert.ok(await preparePendingCheckpointStart(test.taskId));
    await pending.reclaimStaleDeliveries();
    assert.equal((await taskOf(test.taskId)).resumePrompt, test.checkpoint);
    assert.equal((await checkpointReadyTask(test.taskId))?.resumePrompt, test.checkpoint);
    const response = await api.request(`/tasks/${test.taskId}/run`, { method: "POST" });
    assert.equal(response.status, 202);
    await until("恢复手动交接的持久凭证", async () => hits(test.checkpoint) === 1);
    await settled(test.taskId);
    assert.equal(hits(test.checkpoint), 1);
    console.log("PASS: manual takeover keeps its own durable receipt across a real owner process exit");
  }

  {
    const test = await scenario(0);
    const transaction = dbClient.transaction;
    dbClient.transaction = async function (...args) {
      const active = await transaction.apply(dbClient, args);
      const execute = active.execute.bind(active);
      active.execute = async (statement) => {
        const sql = typeof statement === "string" ? statement : statement.sql;
        if (/^insert into "scheduled_messages"/i.test(sql)) throw new Error("INJECT_RUN_RECEIPT_INSERT_FAILURE");
        return execute(statement);
      };
      return active;
    };
    try {
      assert.ok(runs.claimTurn(test.taskId));
      await assert.rejects(resumeOrRunTask(test.taskId, { turnHeld: true }), /INJECT_RUN_RECEIPT_INSERT_FAILURE/);
      assert.equal(runs.isTurnClaimed(test.taskId), false);
      assert.equal((await taskOf(test.taskId)).resumePrompt, test.checkpoint);
    } finally {
      dbClient.transaction = transaction;
    }
    const receipt = await claimCheckpointForRun(test.taskId, test.checkpoint);
    assert.ok(receipt);
    await pending.reclaimStaleDeliveries();
    assert.equal((await taskOf(test.taskId)).resumePrompt, test.checkpoint);
    console.log("PASS: manual checkpoint transfer rolls back atomically and releases the caller's turn on insert failure");
  }

  {
    const test = await scenario(2);
    const fault = failCheckpointRestore();
    try {
      await rejectedDelivery(test);
      const queueId = id();
      await db.insert(schema.queueItems).values({ taskId: test.taskId, queueId, position: 0, createdAt: now() });
      await advanceQueue(queueId);
      assert.equal((await taskOf(test.taskId)).status, "paused");
      assert.equal(runs.isTurnClaimed(test.taskId), false);
      await db.delete(schema.queueItems).where(eq(schema.queueItems.taskId, test.taskId));
      const groupId = id();
      await db.insert(schema.groups).values({
        id: groupId, projectId: (await taskOf(test.taskId)).projectId, name: "checkpoint", mode: "parallel", createdAt: now(),
      });
      await db.update(tasks).set({ groupId }).where(eq(tasks.id, test.taskId));
      await runGroup(groupId);
      assert.equal((await taskOf(test.taskId)).status, "paused");
      assert.equal(hits(test.checkpoint), 0);
    } finally {
      fault.restore();
    }
    await resultsDelivered(test);
    assert.equal(hits(test.checkpoint), 1);
    console.log("PASS: real queue/group entry points do not strand queued seats during checkpoint recovery");
  }

  {
    const test = await scenario(1);
    const fault = failCheckpointRestore();
    try {
      await rejectedDelivery(test);
      await occupyResumePrompt(test.taskId, "EXPLICIT_NEW_INSTRUCTION", false);
    } finally {
      fault.restore();
    }
    assert.equal(await preparePendingCheckpointStart(test.taskId), null);
    assert.equal((await taskOf(test.taskId)).resumePrompt, "EXPLICIT_NEW_INSTRUCTION");
    assert.equal((await rowOf(test.messages[0]!.id)).checkpointTaken, null);
    await until("被新意图替换的补偿退出", async () => !hasPendingDeliveryRecovery(test.taskId));
    await db.update(tasks).set({ archived: true }).where(eq(tasks.id, test.taskId));
    console.log("PASS: explicit user/agent replacement still supersedes an old generation without resurrecting it");
  }
  {
    const test = await scenario(1);
    const previous = await monitorWakeCheckpoint(await rowOf(test.messages[0]!.id));
    assert.ok(previous);
    await previous.restore();
    await occupyResumePrompt(test.taskId, test.checkpoint, false);
    const generation = (await taskOf(test.taskId)).resumePromptGeneration;
    const current = await monitorWakeCheckpoint(await rowOf(test.messages[0]!.id));
    assert.ok(current);
    await previous.restore();
    assert.equal((await rowOf(test.messages[0]!.id)).checkpointTaken, test.checkpoint);
    assert.equal((await rowOf(test.messages[0]!.id)).checkpointGeneration, generation);
    await current.restore();
    assert.equal((await taskOf(test.taskId)).resumePrompt, test.checkpoint);
    assert.equal((await taskOf(test.taskId)).resumePromptGeneration, generation);
    console.log("PASS: a stale recovery snapshot cannot clear a later same-text receipt on the same message");
  }
  console.log("PASS: durable checkpoint recovery suite");
} finally {
  await cleanup();
}
