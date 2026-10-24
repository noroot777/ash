import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { eq } from "drizzle-orm";
import { TEAM_DEFAULTS } from "@ash/shared";
import { appendMonitorWake } from "@ash/shared/monitor-wake";
import {
  db, dbClient, makeTask, monitorEvents, monitors, now, pending,
  pendingOf, reviewInFlight, root, runs, scheduledMessages, schema, sessions, tasks,
  teardown, until,
} from "./monitors-fixture.js";
import { installFakeClaude } from "./scheduled-messages-fixture.js";
import { beginPendingBatch, batchMonitorWake } from "../src/pending-monitor-batch.js";
import { dispatchPendingMessage } from "../src/pending-dispatch.js";
import { forgetRedelivery, retryBlocked, scheduleRedelivery } from "../src/pending-redelivery.js";
import { bus } from "../src/bus.js";
import { monitorsBlockingComplete } from "../src/task-complete-monitors.js";
import { sessionTranscriptPath, TURN_SENTINEL } from "../src/transcript.js";
import { id } from "../src/util.js";

type Row = typeof scheduledMessages.$inferSelect;
const log = join(root, "batch-input.log");
const originalPath = process.env.PATH;
process.env.PATH = `${installFakeClaude(root)}${delimiter}${originalPath ?? ""}`;
process.env.ASH_ALLOW_REAL_AGENT = "1";
process.env.ASH_TEST_LEAD_LOG = log;
let sequence = 0;
const running: string[] = [];
const off = bus.subscribe((event) => {
  if (event.type === "task.status" && event.status === "running") running.push(event.taskId);
});
const rowOf = async (message: Row) => (await db.select().from(scheduledMessages)
  .where(eq(scheduledMessages.id, message.id))).at(0)!;
const hits = (text: string) => existsSync(log) ? readFileSync(log, "utf8").split(text).length - 1 : 0;
const taskOf = async (taskId: string) => (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0)!;
const settled = (taskId: string) => until(`回合 ${taskId} 退出`, async () => !runs.isTurnClaimed(taskId));
async function eventMessage(taskId: string, text: string, overrides: Partial<Row> = {}): Promise<Row> {
  const monitorId = id();
  await db.insert(monitors).values({
    id: monitorId, taskId, command: "batch fixture", cwd: root,
    logPath: join(root, `${monitorId}.log`), startedAt: now(),
    expiresAt: new Date(Date.now() + 600_000).toISOString(), sourceRole: "single",
  });
  const stamp = new Date(Date.now() - 60_000 + sequence++).toISOString();
  const message = pending.pendingMessageRow({
    taskId, text, origin: `monitor:${monitorId}`, sendAt: new Date(stamp),
    turnSource: { role: "single" },
    monitorWake: appendMonitorWake(null, { kind: "output", monitorId, source: text, body: text }),
  });
  Object.assign(message, overrides);
  await db.insert(scheduledMessages).values(message);
  return message;
}
async function dispatch(message: Row, onClaim = () => {}): Promise<void> {
  await dispatchPendingMessage(message, {
    spans: { dueAt: Date.now(), busyMs: 0, queuedAt: Date.now() }, onClaim,
  });
  await settled(message.taskId);
}
async function cancelTaskMessages(taskId: string): Promise<void> {
  for (const message of await pendingOf(taskId)) await pending.cancelPendingMessage(message, "测试已收尾");
}

try {
  {
    const taskId = await makeTask();
    const first = await eventMessage(taskId, "BATCH_FIRST");
    const second = await eventMessage(taskId, "BATCH_FAILED_END");
    const ended = appendMonitorWake(second.monitorWake, {
      kind: "ended", monitorId: second.origin!.slice(8), source: "失败套件", body: "退出码 7；FAILED；命令结束",
    });
    await db.update(scheduledMessages).set({ monitorWake: ended, text: `${second.text}\n退出码 7；FAILED；命令结束` })
      .where(eq(scheduledMessages.id, second.id));
    const monitor = (await db.select().from(monitors).where(eq(monitors.id, first.origin!.slice(8)))).at(0)!;
    await monitorEvents.mergeOrEnqueueMonitorEvent(monitor, "SAME_MONITOR_MORE", first, undefined, {
      kind: "output", monitorId: monitor.id, source: "同哨兵追加", body: "SAME_MONITOR_MORE",
    });
    await db.update(tasks).set({ status: "paused", resumePrompt: "BATCH_CHECKPOINT" }).where(eq(tasks.id, taskId));
    await Promise.all(Array.from({ length: 6 }, () => pending.deliverPendingMessages(taskId)));
    await until("两条结果一起确认送达", async () => (await rowOf(first)).status === "sent" && (await rowOf(second)).status === "sent");
    await settled(taskId);
    assert.equal(running.filter((current) => current === taskId).length, 1);
    for (const text of ["BATCH_FIRST", "BATCH_FAILED_END", "SAME_MONITOR_MORE", "退出码 7；FAILED；命令结束", "BATCH_CHECKPOINT"]) {
      assert.equal(hits(text), 1, `${text} 恰好进入一次真实执行器 stdin`);
    }
    const [session] = await db.select().from(sessions).where(eq(sessions.taskId, taskId));
    const transcript = readFileSync(sessionTranscriptPath(taskId, session!.id), "utf8");
    const turns = transcript.split("\n").filter((line) => line.startsWith(TURN_SENTINEL))
      .map((line) => JSON.parse(line.slice(TURN_SENTINEL.length)))
      .filter((entry) => entry.t === "user");
    assert.equal(turns.length, 1, "持久会话中只有一次实际输入");
    assert.deepEqual(turns[0].monitorWake.events.map((event: { body: string }) => event.body),
      ["BATCH_FIRST", "SAME_MONITOR_MORE", "BATCH_FAILED_END", "退出码 7；FAILED；命令结束"]);
    assert.equal(turns[0].monitorWake.checkpoint, "BATCH_CHECKPOINT");
    assert.ok(transcript.indexOf("BATCH_FIRST") < transcript.indexOf("BATCH_FAILED_END"));
    assert.equal((await rowOf(first)).checkpointTaken, "BATCH_CHECKPOINT");
    assert.equal((await rowOf(second)).checkpointTaken, null);
    await pending.deliverPendingMessages(taskId);
    assert.equal(hits("BATCH_FIRST"), 1);
    console.log("PASS: real scanner + concurrent wake, one stdin/turn, complete failure/end content, same-monitor merge and checkpoint");
  }
  {
    const firstTask = await makeTask({ status: "paused" });
    const secondTask = await makeTask({ status: "paused" });
    const first = await eventMessage(firstTask, "TASK_ISOLATION_A");
    const second = await eventMessage(secondTask, "TASK_ISOLATION_B");
    await pending.deliverPendingMessages();
    await until("不同任务各自送达", async () => (await rowOf(first)).status === "sent" && (await rowOf(second)).status === "sent");
    await Promise.all([settled(firstTask), settled(secondTask)]);
    for (const [taskId, own, other] of [[firstTask, first.text, second.text], [secondTask, second.text, first.text]]) {
      const [session] = await db.select().from(sessions).where(eq(sessions.taskId, taskId));
      const text = readFileSync(sessionTranscriptPath(taskId!, session!.id), "utf8");
      assert.ok(text.includes(own!));
      assert.ok(!text.includes(other!));
    }
    console.log("PASS: different tasks produce separate real session deliveries; singleton unchanged");
  }
  {
    const taskId = await makeTask({ status: "paused" });
    const first = await eventMessage(taskId, "LATE_FIRST");
    const second = await eventMessage(taskId, "LATE_SECOND");
    let later: Promise<Row> | undefined;
    const offLate = bus.subscribe((event) => {
      if (event.type === "conversation.turn" && event.taskId === taskId && event.text.includes(first.text)) {
        offLate();
        later = eventMessage(taskId, "LATE_AFTER_CLAIM");
      }
    });
    await pending.deliverPendingMessages(taskId);
    await until("第一批真实送达", async () => (await rowOf(first)).status === "sent");
    await settled(taskId);
    const late = await later!;
    assert.equal((await rowOf(second)).status, "sent");
    assert.equal((await rowOf(late)).status, "pending");
    assert.equal(hits("LATE_AFTER_CLAIM"), 0);
    await dispatch(late);
    await until("后到结果实际进入执行器", async () => hits("LATE_AFTER_CLAIM") === 1);
    assert.equal(hits("LATE_AFTER_CLAIM"), 1);
    assert.equal(hits("LATE_FIRST"), 1);
    console.log("PASS: output arriving after claim remains pending and triggers the next delivery without duplication");
  }
  {
    const taskId = await makeTask({ status: "paused" });
    const first = await eventMessage(taskId, "ORDER_MONITOR_BEFORE");
    const human = await pending.enqueueMessage({ taskId, text: "ORDER_HUMAN", sendAt: new Date(first.sendAt) });
    const last = await eventMessage(taskId, "ORDER_MONITOR_AFTER");
    await db.update(scheduledMessages).set({ sendAt: new Date(new Date(first.sendAt).getTime() + 1).toISOString() })
      .where(eq(scheduledMessages.id, human.id));
    await db.update(scheduledMessages).set({ sendAt: new Date(new Date(first.sendAt).getTime() + 2).toISOString() })
      .where(eq(scheduledMessages.id, last.id));
    await pending.deliverPendingMessages(taskId);
    await until("普通输入前的哨兵结果送达", async () => (await rowOf(first)).status === "sent");
    await settled(taskId);
    assert.equal((await rowOf(human)).status, "pending");
    assert.equal((await rowOf(last)).status, "pending");
    await dispatch(human);
    await dispatch(last);
    assert.equal(hits(first.text), 1);
    assert.equal(hits(human.text), 1);
    assert.equal(hits(last.text), 1);
    const text = readFileSync(log, "utf8");
    assert.ok(text.indexOf(first.text) < text.indexOf(human.text));
    assert.ok(text.indexOf(human.text) < text.indexOf(last.text));
    console.log("PASS: normal user input stays a separate real turn between monitor batches, FIFO preserved");
  }
  {
    const changes: Array<Partial<Row>> = [
      { sessionRole: "reviewer", reviewRun: "other-review", reviewRound: 1 },
      { reviewRun: "other-review", sessionRole: "reviewer", reviewRound: 2 },
      { agent: "codex" }, { executorId: "other-executor" }, { model: "other-model" },
      { reasoningEffort: "high" }, { ownerUserId: "other-user" }, { execution: true },
      { attachments: '["other-file"]' }, { mode: "timed" }, { origin: null, sessionRole: "reviewer" },
    ];
    for (const change of changes) {
      const taskId = await makeTask();
      const first = await eventMessage(taskId, "ISOLATION_FIRST");
      const boundary = await eventMessage(taskId, "ISOLATION_BOUNDARY", change);
      const last = await eventMessage(taskId, "ISOLATION_LAST");
      assert.deepEqual((await beginPendingBatch(first)).map((message) => message.id), [first.id]);
      assert.equal((await rowOf(boundary)).deliveringSince, null);
      assert.equal((await rowOf(last)).deliveringSince, null);
      await pending.abortDelivery(first);
      await cancelTaskMessages(taskId);
    }
    const taskId = await makeTask();
    const first = await eventMessage(taskId, "REVIEW_ROUND_ONE", { sessionRole: "reviewer", reviewRun: "same-run", reviewRound: 1 });
    await eventMessage(taskId, "REVIEW_ROUND_TWO", { sessionRole: "reviewer", reviewRun: "same-run", reviewRound: 2 });
    assert.equal((await beginPendingBatch(first)).length, 1);
    await pending.abortDelivery(first);
    await cancelTaskMessages(taskId);
    console.log("PASS: role, review run/round, executor configuration, owner, attachments, timed and human-review boundaries");
  }
  {
    const taskId = await makeTask();
    const first = await eventMessage(taskId, "CLAIM_FIRST");
    const second = await eventMessage(taskId, "CLAIM_SECOND");
    const attempts = await Promise.all(Array.from({ length: 8 }, () => beginPendingBatch(first)));
    assert.equal(attempts.filter((batch) => batch.length).length, 1);
    assert.deepEqual(attempts.flat().map((message) => message.id), [first.id, second.id]);
    await monitorEvents.cancelPendingMonitorEvents(taskId);
    assert.equal((await rowOf(first)).status, "pending", "批次内的已领取消息仍由投递者负责");
    await pending.abortDelivery([first, second]);
    const canceled = await eventMessage(taskId, "CLAIM_CANCELLED");
    await monitorEvents.cancelPendingMonitorEvents(taskId, { only: [canceled.origin!.slice(8)] });
    assert.equal((await rowOf(canceled)).status, "canceled");
    const retried = await beginPendingBatch(first);
    assert.deepEqual(retried.map((message) => message.id), [first.id, second.id]);
    await pending.abortDelivery(retried);
    const leased = await pending.beginDelivery(second.id);
    assert.ok(leased);
    assert.deepEqual((await beginPendingBatch(first)).map((message) => message.id), [first.id]);
    await pending.reclaimStaleDeliveries();
    assert.equal((await beginPendingBatch(first)).length, 2);
    await pending.abortDelivery([first, second]);
    scheduleRedelivery(second, "定向测试：暂未到重试窗口");
    assert.ok(retryBlocked(second.id, Date.now()));
    assert.equal((await beginPendingBatch(first)).length, 1);
    forgetRedelivery(second.id);
    await pending.abortDelivery(first);
    const transaction = dbClient.transaction;
    let injected = 0;
    dbClient.transaction = async function (...args) {
      const active = await transaction.apply(dbClient, args);
      const execute = active.execute;
      active.execute = async function (statement) {
        const result = await execute.call(active, statement);
        const sql = typeof statement === "string" ? statement : statement.sql;
        if (!injected && /^update "scheduled_messages" set "delivering_since"/i.test(sql)) {
          injected += 1;
          throw new Error("injected claim rollback");
        }
        return result;
      };
      return active;
    };
    try {
      await assert.rejects(beginPendingBatch(first), /injected claim rollback/);
      assert.equal(injected, 1);
    } finally {
      dbClient.transaction = transaction;
    }
    assert.equal((await rowOf(first)).deliveringSince, null);
    assert.equal((await rowOf(second)).deliveringSince, null);
    const afterRollback = await beginPendingBatch(first);
    assert.equal(afterRollback.length, 2);
    await pending.abortDelivery(afterRollback);
    await cancelTaskMessages(taskId);
    console.log("PASS: atomic concurrent claims, leased/cancelled barriers, retry readiness, transaction rollback and crash lease recovery");
  }
  {
    const taskId = await makeTask({ status: "paused" });
    const first = await eventMessage(taskId, "RETRY_BATCH_FIRST");
    const second = await eventMessage(taskId, "RETRY_BATCH_SECOND");
    await db.update(tasks).set({ resumePrompt: "RETRY_BATCH_CHECKPOINT" }).where(eq(tasks.id, taskId));
    assert.ok(runs.claimTurn(taskId, "single"));
    await dispatchPendingMessage(first, { spans: { dueAt: Date.now(), busyMs: 0, queuedAt: Date.now() }, onClaim: () => {} });
    for (const message of [first, second]) {
      assert.equal((await rowOf(message)).status, "pending");
      assert.equal((await rowOf(message)).deliveringSince, null);
      assert.equal((await rowOf(message)).checkpointTaken, null);
    }
    assert.equal((await taskOf(taskId)).resumePrompt, "RETRY_BATCH_CHECKPOINT");
    assert.equal(hits(first.text), 0);
    runs.releaseTurn(taskId);
    await until("同一批重试自动送达", async () => (await rowOf(first)).status === "sent" && (await rowOf(second)).status === "sent");
    await settled(taskId);
    assert.equal(hits(first.text), 1);
    assert.equal(hits(second.text), 1);
    assert.equal(hits("RETRY_BATCH_CHECKPOINT"), 1);
    console.log("PASS: busy-turn rejection restores every lease/checkpoint; automatic retry delivers the entire batch once");
  }
  {
    for (const fault of ["checkpoint", "guard"] as const) {
      const taskId = await makeTask({ status: "paused" });
      const first = await eventMessage(taskId, `FAULT_${fault}_FIRST`);
      const second = await eventMessage(taskId, `FAULT_${fault}_SECOND`);
      const checkpoint = `FAULT_${fault}_CHECKPOINT`;
      await db.update(tasks).set({ resumePrompt: checkpoint }).where(eq(tasks.id, taskId));
      const execute = dbClient.execute;
      let injected = 0;
      dbClient.execute = (async function (statement, ...rest) {
        const sql = typeof statement === "string" ? statement : statement.sql;
        const selected = fault === "checkpoint" ? /^select "resume_prompt",/i : /^select "status", "archived" from/i;
        if (!injected && selected.test(sql)) {
          injected += 1;
          throw new Error(`injected ${fault} read failure`);
        }
        return execute.call(dbClient, statement, ...rest);
      }) as typeof dbClient.execute;
      try {
        await dispatch(first);
        assert.equal(injected, 1);
        assert.equal((await rowOf(first)).status, "pending");
        assert.equal((await rowOf(second)).status, "pending");
        assert.equal((await rowOf(first)).deliveringSince, null);
        assert.equal((await rowOf(second)).deliveringSince, null);
        assert.equal((await taskOf(taskId)).resumePrompt, checkpoint);
      } finally {
        dbClient.execute = execute;
      }
      await until("短暂读故障后整批重投", async () => (await rowOf(first)).status === "sent" && (await rowOf(second)).status === "sent");
      await settled(taskId);
      assert.equal(hits(first.text), 1);
      assert.equal(hits(second.text), 1);
      assert.equal(hits(checkpoint), 1);
    }
    console.log("PASS: transient checkpoint/guard reads restore the whole batch and retry once without losing input");
  }
  {
    const taskId = await makeTask({ status: "paused" });
    await reviewInFlight(taskId, "batch-stale-source", { live: false });
    const first = await eventMessage(taskId, "GUARD_VALID");
    const stale = await eventMessage(taskId, "GUARD_STALE");
    await db.update(monitors).set({ sourceReviewRun: "batch-stale-source", sourceReviewRound: 1 })
      .where(eq(monitors.id, stale.origin!.slice(8)));
    await db.update(schema.freeReviewRuns).set({ status: "done" }).where(eq(schema.freeReviewRuns.id, "batch-stale-source"));
    await dispatch(first);
    assert.equal((await rowOf(stale)).status, "canceled");
    assert.equal((await rowOf(first)).status, "pending");
    await until("有效成员重投，失效来源不混入", async () => (await rowOf(first)).status === "sent");
    await settled(taskId);
    assert.equal(hits(first.text), 1);
    assert.equal(hits(stale.text), 0);
    console.log("PASS: final guards check every member; one stale result cannot cancel a valid peer or leak into stdin");
  }
  {
    const taskId = await makeTask({ status: "paused" });
    const first = await eventMessage(taskId, "COMPLETE_GATE_A");
    const second = await eventMessage(taskId, "COMPLETE_GATE_B");
    await db.update(monitors).set({ status: "exited" }).where(eq(monitors.taskId, taskId));
    await beginPendingBatch(first);
    assert.match((await monitorsBlockingComplete(taskId))!, /2 条哨兵结果/);
    await pending.markSent([first, second]);
    assert.equal(await monitorsBlockingComplete(taskId), null);
    console.log("PASS: completion gate sees every claimed result until the batch is acknowledged");
  }
  {
    const taskId = await makeTask({ mode: "team", status: "idle" });
    await db.update(tasks).set({ team: JSON.stringify({ ...TEAM_DEFAULTS, lead: "claude" }) }).where(eq(tasks.id, taskId));
    const first = await eventMessage(taskId, "TEAM_BATCH_FIRST");
    const second = await eventMessage(taskId, "TEAM_BATCH_SECOND");
    await pending.deliverPendingMessages(taskId);
    await until("调度台批次实际写入 stdin", async () => hits(first.text) === 1 && hits(second.text) === 1);
    assert.equal((await rowOf(first)).status, "sent");
    assert.equal((await rowOf(second)).status, "sent");
    const { teamIsLive } = await import("../src/team/session.js");
    await until("临时调度台退出", async () => !teamIsLive(taskId));
    console.log("PASS: team lead receives the batch in one resident input");
  }
  {
    const taskId = await makeTask({ mode: "team", status: "idle" });
    await db.update(tasks).set({ team: JSON.stringify({ ...TEAM_DEFAULTS, lead: "claude" }) }).where(eq(tasks.id, taskId));
    const first = await eventMessage(taskId, "TEAM_CANCEL_BEFORE_CLAIM");
    const second = await eventMessage(taskId, "TEAM_DELIVER_AFTER_CANCEL");
    const transaction = dbClient.transaction;
    let canceled = 0;
    dbClient.transaction = async function (...args) {
      if (!canceled) {
        canceled += 1;
        await pending.cancelPendingMessage(first, "测试：扫描之后、领取之前取消");
      }
      return transaction.apply(dbClient, args);
    };
    try {
      await pending.deliverPendingMessages(taskId);
    } finally {
      dbClient.transaction = transaction;
    }
    assert.equal(canceled, 1);
    assert.equal((await rowOf(first)).status, "canceled");
    assert.equal((await rowOf(second)).status, "sent", "首条取消不能吃掉本次扫描的投递窗口");
    await until("取消后剩余结果进入调度台", async () => hits(second.text) === 1);
    assert.equal(hits(first.text), 0);
    const { teamIsLive } = await import("../src/team/session.js");
    await until("取消边界的临时调度台退出", async () => !teamIsLive(taskId));
    console.log("PASS: canceled team anchor does not postpone the next ready result to another scan");
  }
  {
    const taskId = await makeTask();
    const first = await eventMessage(taskId, "LEGACY_TEXT_A", { monitorWake: null });
    const second = await eventMessage(taskId, "LEGACY_TEXT_B");
    const claimed = await beginPendingBatch(first);
    assert.equal(batchMonitorWake(claimed, []), undefined);
    const large = { ...second, monitorWake: {
      version: 1 as const, omittedEvents: 3,
      events: Array.from({ length: 110 }, () => ({ kind: "ended" as const, monitorId: "large", source: "large", body: "FAIL".repeat(400) })),
    } };
    const data = batchMonitorWake([large, large], ["CHECKPOINT"]);
    assert.equal(data!.events.length, 220, "跨哨兵合批不再次套用单哨兵截断预算");
    assert.equal(data!.omittedEvents, 6);
    assert.equal(data!.checkpoint, "CHECKPOINT");
    await pending.abortDelivery(claimed);
    await cancelTaskMessages(taskId);
    console.log("PASS: legacy fallback and large failure batches add no new truncation or omissions");
  }
  console.log("monitor delivery batch: all targeted cases passed");
} finally {
  off();
  process.env.PATH = originalPath;
  await teardown();
}
