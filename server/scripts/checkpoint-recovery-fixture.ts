import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import {
  db, dbClient, makeTask, monitors, now, pending, root, runs,
  scheduledMessages, schema, tasks, teardown, until,
} from "./monitors-fixture.js";
import { installFakeClaude } from "./scheduled-messages-fixture.js";
import { appendMonitorWake } from "@ash/shared/monitor-wake";
import { occupyResumePrompt } from "../src/task-resume-prompt.js";
import { dispatchPendingMessage } from "../src/pending-dispatch.js";
import { hasPendingDeliveryRecovery } from "../src/pending-delivery-recovery.js";
import { mountTaskRunRoutes } from "../src/task-run-routes.js";
import { id } from "../src/util.js";

export { db, dbClient, monitors, now, pending, root, runs, scheduledMessages, schema, tasks, until };
export type Row = typeof scheduledMessages.$inferSelect;
export const api = new Hono();
mountTaskRunRoutes(api);
const log = join(root, "checkpoint-input.log");
const environment = { path: process.env.PATH, allow: process.env.ASH_ALLOW_REAL_AGENT, log: process.env.ASH_TEST_LEAD_LOG };
process.env.PATH = `${installFakeClaude(root)}${delimiter}${environment.path ?? ""}`;
process.env.ASH_ALLOW_REAL_AGENT = "1";
process.env.ASH_TEST_LEAD_LOG = log;
const created: string[] = [];
export const input = () => existsSync(log) ? readFileSync(log, "utf8") : "";
export const hits = (text: string) => input().split(text).length - 1;
export const taskOf = async (taskId: string) => (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!;
export const rowOf = async (messageId: string) => (await db.select().from(scheduledMessages)
  .where(eq(scheduledMessages.id, messageId)))[0]!;
export const settled = (taskId: string) => until("检查点回合退出", async () => !runs.isTurnClaimed(taskId));

export async function scenario(size: number, mode = "single") {
  const taskId = await makeTask({ status: mode === "team" ? "idle" : "paused", mode });
  created.push(taskId);
  const checkpoint = `REQUIRED_${id()}`;
  await occupyResumePrompt(taskId, checkpoint, false);
  const messages: Row[] = [];
  for (let index = 0; index < size; index++) {
    const monitorId = id();
    await db.insert(monitors).values({
      id: monitorId, taskId, command: "checkpoint fixture", cwd: root,
      logPath: join(root, `${monitorId}.log`), sourceRole: "single", status: "exited", exitCode: 0,
      startedAt: now(), endedAt: now(), expiresAt: new Date(Date.now() + 600_000).toISOString(),
    });
    const text = `RESULT_${monitorId}`;
    messages.push(await pending.enqueueMessage({
      taskId, text, origin: `monitor:${monitorId}`, turnSource: { role: "single" },
      sendAt: new Date(Date.now() - 60_000 + index),
      monitorWake: appendMonitorWake(null, { kind: "ended", monitorId, source: text, body: text }),
    }));
  }
  return { taskId, checkpoint, messages, mode };
}

export function failCheckpointRestore() {
  const batch = dbClient.batch;
  let failures = 0;
  dbClient.batch = async function (statements, ...rest) {
    if (statements.some((statement) => typeof statement !== "string"
      && /^update "scheduled_messages" set "checkpoint_taken"/i.test(statement.sql)
      && Array.isArray(statement.args) && statement.args[0] === null)) {
      failures++;
      throw new Error("INJECT_CHECKPOINT_RESTORE_FAILURE");
    }
    return batch.call(dbClient, statements, ...rest);
  };
  return { count: () => failures, restore: () => { dbClient.batch = batch; } };
}

/**
 * 定点让**送达确认**那一笔写失败(`markSent` 的 `status = 'sent'`),原文照旧送出去。
 *
 * 这一笔跟 failCheckpointRestore 注入的不是同一个窗口:那个打的是「取走了、一个字没送出去」
 * 的回填,这个打的是「已经喂给 agent 了、只差记这一笔账」—— 后者没有补偿时会把任务永久钉死
 * (第 1 轮审查必须修 3)。`disarm` 只停止注入、不还原钩子,给「库恢复了,补办自己会成功」
 * 那一段用。
 */
export function failCheckpointAck() {
  const execute = dbClient.execute;
  let failures = 0;
  let armed = true;
  dbClient.execute = async function (statement, ...rest) {
    if (armed && typeof statement !== "string" && /^update "scheduled_messages" set/i.test(statement.sql)
      && /"status"/i.test(statement.sql) && Array.isArray(statement.args) && statement.args[0] === "sent") {
      failures++;
      throw new Error("INJECT_CHECKPOINT_ACK_FAILURE");
    }
    return execute.call(dbClient, statement, ...rest);
  };
  return {
    count: () => failures,
    disarm: () => { armed = false; },
    restore: () => { armed = false; dbClient.execute = execute; },
  };
}

export async function rejectedDelivery(test: Awaited<ReturnType<typeof scenario>>): Promise<void> {
  const release = test.mode === "team" ? runs.claimWakeTurn(test.taskId) : (() => {
    assert.ok(runs.claimTurn(test.taskId, "single"));
    return () => runs.releaseTurn(test.taskId);
  })();
  assert.ok(release);
  try {
    await dispatchPendingMessage(test.messages[0]!, {
      spans: { dueAt: Date.now(), busyMs: 0, queuedAt: Date.now() },
      team: test.mode === "team", onClaim: () => {},
    });
  } finally {
    release();
  }
  assert.equal(hasPendingDeliveryRecovery(test.taskId), true);
  assert.equal((await rowOf(test.messages[0]!.id)).checkpointTaken, test.checkpoint);
  assert.equal((await taskOf(test.taskId)).resumePrompt, null);
}

export async function cleanup(): Promise<void> {
  try {
    for (const taskId of created) {
      runs.stopTask(taskId);
      await until("夹具执行器退出", async () => !runs.isRunning(taskId));
      runs.releaseTurn(taskId);
    }
  } finally {
    try {
      await teardown();
    } finally {
      if (environment.path === undefined) delete process.env.PATH;
      else process.env.PATH = environment.path;
      if (environment.allow === undefined) delete process.env.ASH_ALLOW_REAL_AGENT;
      else process.env.ASH_ALLOW_REAL_AGENT = environment.allow;
      if (environment.log === undefined) delete process.env.ASH_TEST_LEAD_LOG;
      else process.env.ASH_TEST_LEAD_LOG = environment.log;
    }
  }
}
