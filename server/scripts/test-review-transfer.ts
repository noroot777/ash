import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { db, tasks, schema, runs, teardown, until } from "./monitors-fixture.js";
import { setupRegressionReviews } from "./regression-review-fixture.js";

const { importHandoff } = await import("../src/handoff-import.js");
const { exportWaitOrigins } = await import("../src/handoff-wait.js");
const { exportHandoffMessage } = await import("../src/handoff-messages.js");
const { resumeOrRunTask } = await import("../src/task-resume.js");
const { occupyResumePrompt } = await import("../src/task-resume-prompt.js");
const { setTaskQuestion } = await import("../src/task-question.js");
const { answerTask } = await import("../src/task-answer.js");
const { deliverPendingMessages } = await import("../src/pending-messages.js");
const row = async (taskId: string) => (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!;
const messageRow = async (messageId: string) => (await db.select().from(schema.scheduledMessages)
  .where(eq(schema.scheduledMessages.id, messageId)))[0]!;

assert.notEqual(process.env.ASH_ALLOW_REAL_AGENT, "1");
try {
  const { open } = await setupRegressionReviews();
  const source = await open("preset");
  await db.delete(schema.scheduledMessages);
  await occupyResumePrompt(source.taskId, "Continue reviewing, not implementing", false);
  await db.update(tasks).set({ status: "paused" }).where(eq(tasks.id, source.taskId));
  const before = await row(source.taskId);
  const manifest = { version: 1, sourceHost: "fixture", sourceFingerprint: "a".repeat(64),
    targetProjectId: before.projectId, transferId: "review-checkpoint", autoResume: false,
    sourceWorkspace: null, git: null, sessions: [], files: [], freeWorkflow: null,
    task: { ...before, id: "imported-review-checkpoint", waitOrigins: await exportWaitOrigins(before) } };
  for (const existingSession of [false, true]) {
    for (const kind of ["review", "unknown"] as const) {
      const imported = await importHandoff({ ...manifest, transferId: `${kind}-${existingSession}`,
        task: { ...manifest.task, id: `${kind}-${existingSession}`, waitOrigins: { checkpoint: kind } } });
      if (existingSession) await db.insert(schema.sessions).values({ id: `old-${imported.taskId}`, taskId: imported.taskId,
        role: "single", agentType: "claude", executor: "test", cliSessionId: "old-single", startedAt: new Date().toISOString() });
      const old = await row(imported.taskId);
      assert(runs.claimTurn(imported.taskId));
      await resumeOrRunTask(imported.taskId, { reason: existingSession ? "wake" : "run", turnHeld: true });
      assert.equal((await row(imported.taskId)).directionEpoch, old.directionEpoch);
      assert.equal((await row(imported.taskId)).resumePrompt, null);
      assert.equal(runs.isTurnClaimed(imported.taskId), false);
      assert.equal((await db.select().from(schema.sessions).where(eq(schema.sessions.taskId, imported.taskId))).length,
        existingSession ? 1 : 0);
    }
  }
  runs.releaseTurn(source.taskId);
  console.log("✓ imported review/unknown checkpoints never fall through to fresh or resumable implementation turns");

  const ordinary = await importHandoff({ ...manifest, transferId: "checkpoint-cas-race",
    task: { ...manifest.task, id: "checkpoint-cas-race", waitOrigins: { checkpoint: "ordinary" } } });
  const update = db.update;
  let raced = false;
  db.update = function (table: any) {
    const builder = update.call(this, table);
    const set = builder.set.bind(builder);
    builder.set = function (patch: any) {
      if (!raced && table === tasks && patch.resumePrompt === null) {
        raced = true;
        const query = set(patch);
        const where = query.where.bind(query);
        query.where = () => where(eq(tasks.id, "checkpoint-already-taken"));
        return query;
      }
      return set(patch);
    };
    return builder;
  } as typeof db.update;
  const old = await row(ordinary.taskId);
  assert(runs.claimTurn(ordinary.taskId));
  try { await resumeOrRunTask(ordinary.taskId, { reason: "run", turnHeld: true }); }
  finally { db.update = update; }
  assert(raced);
  assert.equal((await row(ordinary.taskId)).directionEpoch, old.directionEpoch);
  assert.equal(runs.isTurnClaimed(ordinary.taskId), false);
  console.log("✓ a rejected checkpoint CAS releases its own reservation without starting a different input");

  const review = await open("preset");
  await db.delete(schema.scheduledMessages);
  await setTaskQuestion({ taskId: review.taskId, question: "Review decision needed" });
  await db.update(tasks).set({ status: "paused" }).where(eq(tasks.id, review.taskId));
  const api = new Hono();
  api.post("/answer", (context) => answerTask(context, review.taskId));
  assert.equal((await api.request("/answer", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ answer: "For the reviewer only" }) })).status, 200);
  const pending = (await db.select().from(schema.scheduledMessages).where(eq(schema.scheduledMessages.taskId, review.taskId)))[0]!;
  assert(pending.origin?.startsWith("review-answer:"));
  const serialized = exportHandoffMessage(pending);
  assert.equal(serialized.origin, pending.origin);
  for (const kind of ["answer", "repair", "reviewer", "legacy", "ordinary"] as const) {
    const input = { ...serialized, origin: kind === "repair" ? pending.origin!.replace("review-answer:", "review-settlement:")
      : kind === "ordinary" || kind === "reviewer" ? null : kind === "legacy" ? undefined : pending.origin,
    sessionRole: kind === "reviewer" ? "reviewer" : null, reviewRun: kind === "reviewer" ? "source-run" : null,
    reviewRound: kind === "reviewer" ? 3 : null };
    const imported = await importHandoff({ ...manifest, transferId: `message-${kind}`,
      task: { ...manifest.task, id: `message-${kind}`, resumePrompt: null, question: null, waitOrigins: {} }, messages: [input] });
    let message = (await db.select().from(schema.scheduledMessages).where(eq(schema.scheduledMessages.taskId, imported.taskId)))[0]!;
    if (kind !== "ordinary") {
      assert(message.origin?.startsWith(`review-${kind === "repair" ? "settlement" : "answer"}:handoff-`));
      assert.notEqual(message.origin, pending.origin);
      assert.equal(message.reviewRun, null);
      if (kind === "reviewer") assert.equal(message.reviewRound, 3);
      await db.update(tasks).set({ handoff: JSON.stringify({ direction: "out", pending: false,
        peerFp: manifest.sourceFingerprint, transferId: "outbound" }) }).where(eq(tasks.id, imported.taskId));
      await importHandoff({ ...manifest, transferId: `returned-${kind}`,
        task: { ...manifest.task, id: imported.taskId, resumePrompt: null, question: null, waitOrigins: {} }, messages: [input] });
      message = (await db.select().from(schema.scheduledMessages).where(eq(schema.scheduledMessages.taskId, imported.taskId)))[0]!;
    }
    await deliverPendingMessages(imported.taskId);
    await until("imported message reaches terminal delivery state", async () =>
      (await messageRow(message.id)).status === (kind === "ordinary" ? "sent" : "canceled"));
    if (kind === "ordinary") {
      await until("ordinary imported message exits", async () => !runs.isTurnClaimed(imported.taskId));
      assert.equal((await row(imported.taskId)).waitOwnership?.turn?.origin.kind, "ordinary");
    } else {
      assert.equal((await row(imported.taskId)).directionEpoch, 0);
      assert.equal((await db.select().from(schema.sessions).where(eq(schema.sessions.taskId, imported.taskId))).length, 0);
      assert(imported.notes.some((note) => note.includes("审查来源")));
    }
  }
  await db.update(schema.scheduledMessages).set({ status: "canceled" }).where(eq(schema.scheduledMessages.id, pending.id));
  runs.releaseTurn(review.taskId);
  console.log("✓ real queued answers, repairs, reviewer rounds and legacy messages remain quarantined across import and safe return; ordinary messages deliver");

  await assert.rejects(importHandoff({ ...manifest, transferId: "malformed-message",
    task: { ...manifest.task, id: "malformed-message" }, messages: [{ ...serialized, reviewRound: "invalid" }] }), /审查来源非法/);
  assert.equal(await row("malformed-message"), undefined);
  console.log("✓ malformed message provenance is rejected before import side effects");
} finally { await teardown(); }
