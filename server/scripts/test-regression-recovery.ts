import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { makeStep } from "@ash/shared/workflow";
import { db, dbClient, root, runs, schema, status, tasks, teardown } from "./monitors-fixture.js";
import { setupRegressionReviews, type ReviewMode } from "./regression-review-fixture.js";

const { reconcileInterruptedTask } = await import("../src/task-reconcile.js");
const { reconcileRegressionSettlements } = await import("../src/regression-settlement.js");
const { reconcileFreeReviews } = await import("../src/free-workflow.js");
const { mountTaskStageRoutes } = await import("../src/task-stage.js");
const { replayUndeliveredMcpCalls } = await import("../src/mcp-handoff.js");
const { detachedPathsFor } = await import("../src/executors/detached.js");
const api = new Hono();
mountTaskStageRoutes(api);
const recoveryUrl = new URL("../src/regression-settlement.ts", import.meta.url).href;
const recoveryProcess = () => execFileSync(process.execPath, ["--import", "tsx/esm", "--input-type=module", "-e",
  `await (await import(${JSON.stringify(recoveryUrl)})).reconcileRegressionSettlements();`], { env: process.env, stdio: "pipe" });
const taskRow = async (taskId: string) => (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!;
const clearNotices = async (taskId: string) => db.delete(schema.scheduledMessages).where(eq(schema.scheduledMessages.taskId, taskId));
const ordinaryStage = (taskId: string) => api.request(`/tasks/${taskId}/stage`, { method: "POST",
  headers: { "content-type": "application/json", "x-ash-turn-token": `next-${taskId}`, "x-ash-direction-token": "next-direction", "x-ash-source-task-id": taskId },
  body: JSON.stringify({ stage: "implemented" }) });

try {
  const { open } = await setupRegressionReviews();
  for (const mode of ["preset", "legacy"] as const) {
    const review = await open(mode);
    assert.equal((await review.stage()).status, 200);
    await dbClient.execute(`CREATE TEMP TRIGGER stage_fault BEFORE UPDATE OF stage ON tasks
      WHEN OLD.id='${review.taskId}' AND NEW.stage IS NULL BEGIN SELECT RAISE(ABORT,'INJECTED_STAGE_CLEAR_FAILURE'); END`);
    try { await assert.rejects(review.settle(false), /INJECTED_STAGE_CLEAR_FAILURE/); }
    finally { await dbClient.execute("DROP TRIGGER stage_fault"); }
    assert.equal((await review.state()).settlement?.pending, true);
    assert.equal((await taskRow(review.taskId)).verifyRound, mode === "preset" ? 1 : null);
    await clearNotices(review.ownerTaskId);
    runs.releaseTurn(review.ownerTaskId);
    await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, review.ownerTaskId));
    recoveryProcess();
    await reconcileRegressionSettlements();
    assert.equal((await taskRow(review.taskId)).stage, null);
    assert.equal((await taskRow(review.taskId)).verifyRound, null);
    assert.equal((await taskRow(review.taskId)).verifyRounds, mode === "preset" ? 1 : 0);
    assert.equal((await review.state()).finalization?.completed, true);
    console.log(`✓ ${mode}: stage rollback and round closure commit together, restart finishes once`);
  }
  for (const mode of ["preset", "legacy", "free", "accepted_merge"] as ReviewMode[]) {
    for (const submitted of [false, true]) {
      const review = await open(mode);
      if (submitted) assert.equal((await review.stage()).status, 200);
      assert.equal((await review.state()).settlement, null);
      await clearNotices(review.taskId); await clearNotices(review.ownerTaskId);
      runs.releaseTurn(review.ownerTaskId);
      await db.update(tasks).set({ status: "running", followUpFrom: mode === "legacy" ? null : "done" })
        .where(eq(tasks.id, review.ownerTaskId));
      if (mode === "legacy") await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, review.taskId));
      assert.equal(await reconcileInterruptedTask(review.ownerTaskId), true);
      await reconcileFreeReviews(); await reconcileRegressionSettlements();
      assert.equal((await review.state()).settlement?.outcome, "failed");
      assert.equal((await review.state()).settlement?.pending, false);
      assert.equal((await review.state()).finalization?.completed, true);
      const target = await taskRow(review.taskId);
      assert.equal(target.verifyRound, null);
      assert.equal(target.stage, mode === "accepted_merge" ? "accepted" : null);
      console.log(`✓ ${mode}: interrupted before receipt ${submitted ? "with" : "without"} conclusion is discovered without inventing success`);
    }
  }
  for (const mode of ["preset", "legacy", "free", "accepted_merge"] as ReviewMode[]) {
    const review = await open(mode);
    assert.equal((await review.stage()).status, 200);
    await dbClient.execute(`CREATE TEMP TRIGGER tail_fault BEFORE UPDATE OF finalization ON regression_evidence
      WHEN OLD.directory='${review.directory}' AND OLD.finalization IS NOT NULL BEGIN SELECT RAISE(ABORT,'INJECTED_OUTBOX_ACK_FAILURE'); END`);
    try { await assert.rejects(review.settle(true), /INJECTED_OUTBOX_ACK_FAILURE/); }
    finally { await dbClient.execute("DROP TRIGGER tail_fault"); }
    assert.equal((await review.state()).settlement?.pending, false);
    assert.equal((await review.state()).finalization?.completed, undefined);
    await clearNotices(review.ownerTaskId);
    runs.releaseTurn(review.ownerTaskId);
    await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, review.ownerTaskId));
    recoveryProcess(); await reconcileRegressionSettlements();
    assert.equal((await review.state()).finalization?.completed, true);
    assert.equal((await review.state()).settlement?.outcome, "done");
    console.log(`✓ ${mode}: committed receipt cannot hide unfinished durable effects`);
  }
  const fileReview = await open("preset");
  assert.equal((await fileReview.stage()).status, 200);
  mkdirSync(join(fileReview.directory, "conclusion.json"));
  await assert.rejects(fileReview.settle(true), /结论文件/);
  assert.equal((await fileReview.state()).settlement?.pending, false);
  assert.equal((await fileReview.state()).finalization?.completed, undefined);
  rmSync(join(fileReview.directory, "conclusion.json"), { recursive: true });
  runs.releaseTurn(fileReview.ownerTaskId);
  await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, fileReview.taskId));
  await reconcileRegressionSettlements();
  assert.equal((await fileReview.state()).finalization?.completed, true);
  console.log("✓ conclusion file failure retains a retryable outbox after round closure");

  const timeline = await open("free");
  const timelineSession = `timeline-${timeline.taskId}`;
  await db.insert(schema.sessions).values({ id: timelineSession, taskId: timeline.taskId, role: "reviewer", agentType: "codex",
    executor: "test", startedAt: new Date().toISOString() });
  assert.equal((await timeline.stage()).status, 200);
  await dbClient.execute(`CREATE TEMP TRIGGER timeline_fault BEFORE UPDATE OF finalization ON regression_evidence
    WHEN OLD.directory='${timeline.directory}'
    AND EXISTS(SELECT 1 FROM json_each(NEW.finalization,'$.done') WHERE value='timeline')
    AND NOT EXISTS(SELECT 1 FROM json_each(OLD.finalization,'$.done') WHERE value='timeline')
    BEGIN SELECT RAISE(ABORT,'INJECTED_TIMELINE_ACK_FAILURE'); END`);
  try { await assert.rejects(timeline.settle(true), /INJECTED_TIMELINE_ACK_FAILURE/); }
  finally { await dbClient.execute("DROP TRIGGER timeline_fault"); }
  await clearNotices(timeline.taskId); runs.releaseTurn(timeline.taskId);
  await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, timeline.taskId));
  recoveryProcess(); await reconcileRegressionSettlements();
  const timelineEvents = readFileSync(join(root, "runs", timeline.taskId, `${timelineSession}.md`), "utf8").split("\n")
    .filter((line) => line.startsWith("\x1e")).map((line) => JSON.parse(line.slice(1)) as { eventKey?: string });
  assert.equal(timelineEvents.filter((event) => event.eventKey === `${timeline.basis.generation}:timeline`).length, 1);
  assert.equal((await timeline.state()).finalization?.completed, true);
  console.log("✓ timeline acknowledgement failure reuses the durable event identity without duplicate messages");

  const partial = await open("accepted_merge");
  await db.delete(schema.freeReviewRounds).where(eq(schema.freeReviewRounds.id, partial.roundId));
  await clearNotices(partial.taskId); runs.releaseTurn(partial.taskId);
  await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, partial.taskId));
  await reconcileRegressionSettlements();
  assert.equal((await partial.state()).settlement?.outcome, "failed");
  assert.equal((await partial.state()).finalization?.completed, true);
  assert.equal((await taskRow(partial.taskId)).stage, "accepted");
  console.log("✓ a run interrupted before its round row exists still reaches durable abnormal finalization");

  const repair = await open("free");
  await db.update(schema.freeReviewRuns).set({ retryLimit: 1 }).where(eq(schema.freeReviewRuns.id, repair.runId));
  const rejected = await api.request(`/tasks/${repair.taskId}/stage`, { method: "POST",
    headers: { "content-type": "application/json", "x-ash-turn-token": `turn-${repair.taskId}` },
    body: JSON.stringify({ stage: "verify_failed" }) });
  assert.equal(rejected.status, 200);
  await dbClient.execute("CREATE TEMP TRIGGER repair_fault BEFORE INSERT ON scheduled_messages WHEN NEW.origin LIKE 'review-settlement:%' BEGIN SELECT RAISE(ABORT,'INJECTED_REPAIR_INSERT_FAILURE'); END");
  try { await assert.rejects(repair.settle(true), /INJECTED_REPAIR_INSERT_FAILURE/); }
  finally { await dbClient.execute("DROP TRIGGER repair_fault"); }
  const slot = (await db.select().from(schema.freeWorkflowStates).where(eq(schema.freeWorkflowStates.taskId, repair.taskId)))[0];
  assert(!slot?.reviewArmed, "reservation rolls back if durable delivery cannot be recorded");
  await clearNotices(repair.taskId);
  runs.releaseTurn(repair.taskId);
  await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, repair.taskId));
  await reconcileRegressionSettlements(); await reconcileRegressionSettlements();
  const messages = await db.select().from(schema.scheduledMessages).where(and(eq(schema.scheduledMessages.taskId, repair.taskId),
    eq(schema.scheduledMessages.origin, `review-settlement:${repair.basis.generation}`)));
  assert.equal(messages.length, 1);
  assert.equal((await db.select().from(schema.freeWorkflowStates).where(eq(schema.freeWorkflowStates.taskId, repair.taskId)))[0]!.reviewRunId, repair.runId);
  assert.equal((await repair.state()).finalization?.completed, true);
  console.log("✓ automatic reservation and exactly one durable repair message survive delivery-write failure");

  const outdated = await open("free");
  await db.update(schema.freeReviewRuns).set({ retryLimit: 1 }).where(eq(schema.freeReviewRuns.id, outdated.runId));
  assert.equal((await api.request(`/tasks/${outdated.taskId}/stage`, { method: "POST",
    headers: { "content-type": "application/json", "x-ash-turn-token": `turn-${outdated.taskId}` },
    body: JSON.stringify({ stage: "verify_failed" }) })).status, 200);
  await clearNotices(outdated.taskId);
  await status.setTaskStatus(outdated.taskId, "done");
  assert.equal((await taskRow(outdated.taskId)).activeTurnToken, null);
  await dbClient.execute("CREATE TEMP TRIGGER outdated_fault BEFORE INSERT ON scheduled_messages WHEN NEW.origin LIKE 'review-settlement:%' BEGIN SELECT RAISE(ABORT,'INJECTED_OUTDATED_REPAIR_FAILURE'); END");
  try { await assert.rejects(outdated.settle(true), /INJECTED_OUTDATED_REPAIR_FAILURE/); }
  finally { await dbClient.execute("DROP TRIGGER outdated_fault"); }
  runs.releaseTurn(outdated.taskId);
  const previousEpoch = (await taskRow(outdated.taskId)).directionEpoch;
  await db.update(tasks).set({ directionEpoch: previousEpoch + 1 }).where(eq(tasks.id, outdated.taskId));
  await db.insert(schema.freeWorkflowStates).values({ taskId: outdated.taskId, reviewArmed: true, reviewNote: "new-direction", updatedAt: new Date().toISOString() });
  await reconcileRegressionSettlements();
  assert.equal((await outdated.state()).finalization?.completed, true);
  assert.equal((await db.select().from(schema.scheduledMessages).where(eq(schema.scheduledMessages.origin,
    `review-settlement:${outdated.basis.generation}`))).length, 0);
  assert.equal((await db.select().from(schema.freeWorkflowStates).where(eq(schema.freeWorkflowStates.taskId, outdated.taskId)))[0]!.reviewNote, "new-direction");
  console.log("✓ cleared turn tokens cannot revive an old repair after a later direction epoch has completed");

  for (const afterQuestion of [false, true]) {
    const review = await open("preset");
    await db.update(tasks).set({ workflow: JSON.stringify({ workspace: "shared", steps: [makeStep("run", "run"),
      { ...makeStep("verify", "verify"), fail: { mode: "ask" } }] }) }).where(eq(tasks.id, review.taskId));
    const response = await api.request(`/tasks/${review.taskId}/stage`, { method: "POST",
      headers: { "content-type": "application/json", "x-ash-turn-token": `turn-${review.taskId}`, "x-ash-source-task-id": review.taskId },
      body: JSON.stringify({ stage: "verify_failed" }) });
    assert.equal(response.status, 200);
    await dbClient.execute(afterQuestion
      ? `CREATE TEMP TRIGGER question_fault BEFORE UPDATE OF finalization ON regression_evidence
        WHEN OLD.directory='${review.directory}' AND json_extract(NEW.finalization,'$.completed')=1
        BEGIN SELECT RAISE(ABORT,'INJECTED_QUESTION_ACK_FAILURE'); END`
      : `CREATE TEMP TRIGGER question_fault BEFORE UPDATE OF question ON tasks WHEN OLD.id='${review.taskId}'
        BEGIN SELECT RAISE(ABORT,'INJECTED_QUESTION_WRITE_FAILURE'); END`);
    try { await assert.rejects(review.settle(true), /INJECTED_QUESTION/); }
    finally { await dbClient.execute("DROP TRIGGER question_fault"); }
    assert.equal(!!(await taskRow(review.taskId)).question, afterQuestion);
    assert.equal((await review.state()).finalization?.done.includes("question"), afterQuestion);
    if (afterQuestion) await db.update(tasks).set({ question: null, questionOptions: null }).where(eq(tasks.id, review.taskId));
    await clearNotices(review.taskId); runs.releaseTurn(review.taskId);
    await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, review.taskId));
    recoveryProcess();
    assert.equal(!!(await taskRow(review.taskId)).question, !afterQuestion, "an answered durable question is not asked again");
    assert.equal((await review.state()).finalization?.completed, true);
  }
  console.log("✓ question state and outbox receipt commit together; completion retry never restores an answered question");

  for (const uncertain of [false, true]) {
    const review = await open("preset");
    const counter = join(root, uncertain ? "uncertain-count" : "checkpoint-count");
    const command = { ...makeStep("command", "publish"), p: {
      cmd: `node -e 'require("fs").appendFileSync(${JSON.stringify(counter)},"once\\n")'`, where: "workspace",
    } };
    await db.update(tasks).set({ workflow: JSON.stringify({ workspace: "shared", steps: [makeStep("run", "run"),
      makeStep("verify", "verify"), command, makeStep("human", "human")] }) }).where(eq(tasks.id, review.taskId));
    assert.equal((await review.stage()).status, 200);
    await dbClient.execute(uncertain
      ? `CREATE TEMP TRIGGER workflow_fault BEFORE UPDATE OF finalization ON regression_evidence WHEN OLD.directory='${review.directory}'
        AND json_extract(OLD.finalization,'$.runningStep')='publish' AND json_extract(NEW.finalization,'$.runningStep') IS NULL
        BEGIN SELECT RAISE(ABORT,'INJECTED_WORKFLOW_CHECKPOINT_FAILURE'); END`
      : `CREATE TEMP TRIGGER workflow_fault BEFORE UPDATE OF workflow_at ON tasks WHEN OLD.id='${review.taskId}' AND NEW.workflow_at='human'
        BEGIN SELECT RAISE(ABORT,'INJECTED_WORKFLOW_CURSOR_FAILURE'); END`);
    try { await assert.rejects(review.settle(true), /INJECTED_WORKFLOW/); }
    finally { await dbClient.execute("DROP TRIGGER workflow_fault"); }
    assert.equal(readFileSync(counter, "utf8"), "once\n");
    await clearNotices(review.taskId); runs.releaseTurn(review.taskId);
    await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, review.taskId));
    recoveryProcess(); await reconcileRegressionSettlements();
    assert.equal(readFileSync(counter, "utf8"), "once\n", "completed or ambiguous external side effects are never repeated");
    if (uncertain) {
      assert.equal((await review.state()).finalization?.runningStep, "publish");
      assert.equal((await review.state()).finalization?.completed, undefined);
      assert.equal((await taskRow(review.taskId)).workflowAt, "verify");
      await db.update(tasks).set({ activeTurnToken: "manual-followup" }).where(eq(tasks.id, review.taskId));
      await reconcileRegressionSettlements();
      assert.equal((await review.state()).finalization?.completed, true, "a later explicit turn supersedes the old pending workflow");
    } else {
      assert.equal((await review.state()).finalization?.completed, true);
      assert.equal((await taskRow(review.taskId)).stage, "awaiting_acceptance");
      assert.equal((await taskRow(review.taskId)).workflowAt, "human");
    }
    console.log(`✓ workflow recovery ${uncertain ? "retains ambiguous side effect for manual inspection" : "skips durable completed steps and reaches the human gate"}`);
  }

  for (const mode of ["preset", "legacy"] as const) {
    const review = await open(mode);
    assert.equal((await review.stage()).status, 200);
    await review.settle(true);
    runs.releaseTurn(review.ownerTaskId);
    await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, review.ownerTaskId));
    await db.update(tasks).set({ status: "running", activeTurnToken: `next-${review.taskId}`,
      activeDirectionToken: "next-direction", activeDirectionVersion: 2 }).where(eq(tasks.id, review.taskId));
    assert(runs.claimTurn(review.taskId, "single"));
    runs.bindTurnToken(review.taskId, `next-${review.taskId}`);
    assert.equal((await ordinaryStage(review.taskId)).status, 200);
    if (mode === "legacy") {
      await db.update(tasks).set({ status: "paused" }).where(eq(tasks.id, review.ownerTaskId));
      assert.equal((await ordinaryStage(review.taskId)).status, 200, "current implementation identity is not an old paused reviewer");
      await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, review.ownerTaskId));
    }
    await db.update(tasks).set({ stage: null }).where(eq(tasks.id, review.taskId));
    const sessionId = `later-${review.taskId}`, turnStart = new Date().toISOString();
    await db.insert(schema.sessions).values({ id: sessionId, taskId: review.taskId, agentType: "codex", role: "single", executor: "test", cwd: root, startedAt: turnStart });
    const { out } = detachedPathsFor(join(root, "runs", review.taskId), sessionId, turnStart);
    writeFileSync(out, JSON.stringify({ type: "item.completed", item: { id: sessionId, type: "mcp_tool_call", server: "ash", tool: "report_stage",
      arguments: { taskId: review.taskId, stage: "implemented", directionToken: "next-direction" },
      result: null, error: { message: "Transport closed" }, status: "failed" } }) + "\n");
    assert.equal(await replayUndeliveredMcpCalls({ taskId: review.taskId, sessId: sessionId, turnStart, agentType: "codex", directionToken: "next-direction" }), 1);
    assert.equal((await taskRow(review.taskId)).stage, "implemented");
    assert.equal((await review.state()).settlement?.pending, false);
    runs.releaseTurn(review.taskId);
    console.log(`✓ ${mode}: historical review never freezes later ordinary HTTP or MCP stage updates`);
  }
} finally { await teardown(); }
