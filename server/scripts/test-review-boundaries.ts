import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { makeStep } from "@ash/shared/workflow";
import { db, runs, schema, tasks, teardown, until } from "./monitors-fixture.js";
import { setupRegressionReviews } from "./regression-review-fixture.js";

const { continueTask } = await import("../src/orchestrator.js");
const { resumeOrRunTask } = await import("../src/task-resume.js");
const { occupyResumePrompt, takeResumePrompt, restoreResumePrompt } = await import("../src/task-resume-prompt.js");
const { setTaskQuestion } = await import("../src/task-question.js");
const { startTaskWaitTurn, reviewWaitOrigin } = await import("../src/task-wait-ownership.js");
const { reviewTargetIdentity } = await import("../src/review-ownership.js");
const { reconcileRegressionSettlements } = await import("../src/regression-settlement.js");
const { withdrawReviewStart } = await import("../src/review-start-withdrawal.js");
const { startVerifyRound } = await import("../src/review.js");
const { answerTask } = await import("../src/task-answer.js");
const { importHandoff } = await import("../src/handoff-import.js");
const { exportWaitOrigins } = await import("../src/handoff-wait.js");
const { applyFailPolicy } = await import("../src/workflow-steps.js");
const row = async (taskId: string) => (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!;
const api = new Hono();
api.post("/tasks/:id/answer", (context) => answerTask(context, context.req.param("id")));
const answer = (taskId: string) => api.request(`/tasks/${taskId}/answer`, { method: "POST",
  headers: { "content-type": "application/json" }, body: JSON.stringify({ answer: "Continue implementation" }) });

assert.notEqual(process.env.ASH_ALLOW_REAL_AGENT, "1");
try {
  const { open } = await setupRegressionReviews();
  for (const entry of ["continue", "checkpoint", "answer", "storage-failure"] as const) {
    const review = await open("legacy");
    await db.delete(schema.scheduledMessages);
    await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, review.taskId));
    await db.update(tasks).set({ status: "paused" }).where(eq(tasks.id, review.ownerTaskId));
    await occupyResumePrompt(review.ownerTaskId, "Continue reviewing", false);
    if (entry === "answer") await setTaskQuestion({ taskId: review.ownerTaskId, question: "Review question" });
    runs.releaseTurn(review.ownerTaskId);
    const before = await row(review.ownerTaskId);
    const original = db.transaction;
    let injected = false;
    let storageFailed = false;
    db.transaction = async function (...args) {
      if (!injected && new Error().stack?.includes("assertReviewTurnStart")) {
        injected = true;
        await reconcileRegressionSettlements(review.ownerTaskId);
        assert.equal((await review.state()).settlement, null, "recovery must not interrupt an active startup");
        assert.equal(await continueTask(review.taskId, "A new implementation request"), true);
      }
      if (entry === "storage-failure" && !storageFailed && new Error().stack?.includes("withdrawReviewStart")) {
        storageFailed = true;
        throw new Error("ONCE_WITHDRAWAL_STORAGE_FAILURE");
      }
      return original.apply(this, args);
    };
    try {
      if (entry === "storage-failure") {
        await assert.rejects(continueTask(review.ownerTaskId, "Continue reviewing"), /ONCE_WITHDRAWAL_STORAGE_FAILURE/);
        assert.equal((await row(review.ownerTaskId)).status, "running");
        assert.equal((await review.state()).continuation?.start?.ownerTaskId, review.ownerTaskId);
      }
      else if (entry === "continue") assert.equal(await continueTask(review.ownerTaskId, "Continue reviewing"), false);
      else if (entry === "checkpoint") await resumeOrRunTask(review.ownerTaskId, { reason: "run" });
      else {
        assert.equal((await answer(review.ownerTaskId)).status, 200);
        await until("revoked answer startup settles", async () => injected && !runs.isTurnClaimed(review.ownerTaskId)
          && (await review.state()).settlement?.pending === false);
      }
    } finally { db.transaction = original; }
    assert(injected);
    await reconcileRegressionSettlements(review.ownerTaskId);
    const after = await row(review.ownerTaskId);
    assert.equal(after.status, "failed");
    assert.equal(after.activeTurnToken, null);
    assert.equal(after.activeDirectionToken, null);
    assert.equal(after.followUpFrom, null);
    assert.equal(after.resumePrompt, null);
    assert.equal(after.question, null);
    assert(after.resumePromptGeneration > before.resumePromptGeneration);
    assert.equal((await review.state()).settlement?.pending, false);
    assert.equal(runs.isTurnClaimed(review.ownerTaskId), false);
    const target = await row(review.taskId);
    await reconcileRegressionSettlements(review.ownerTaskId);
    assert.deepEqual(reviewTargetIdentity(await row(review.taskId)), reviewTargetIdentity(target));
    assert.equal((await row(review.taskId)).stage, target.stage);
    if (entry === "continue") {
      await startVerifyRound(review.taskId);
      await until("replacement verification completes its test-only turn", async () => !runs.isTurnClaimed(review.taskId));
    }
    console.log(`✓ late ${entry} revocation closes its own durable startup and permits redispatch without touching the newer target`);
  }

  for (const mode of ["preset", "free", "accepted_merge"] as const) {
    const review = await open(mode);
    await db.delete(schema.scheduledMessages);
    await db.update(tasks).set({ status: "paused" }).where(eq(tasks.id, review.taskId));
    await occupyResumePrompt(review.taskId, "Resume original review", false);
    runs.releaseTurn(review.taskId);
    const original = db.transaction;
    let injected = false;
    db.transaction = async function (...args) {
      if (!injected && new Error().stack?.includes("assertReviewTurnStart")) {
        injected = true;
        await db.update(tasks).set({ archived: true }).where(eq(tasks.id, review.taskId));
      }
      return original.apply(this, args);
    };
    try { await resumeOrRunTask(review.taskId, { reason: "run" }); }
    finally { db.transaction = original; }
    assert(injected);
    const after = await row(review.taskId);
    assert.equal(after.status, "paused");
    assert.equal(after.resumePrompt, null);
    assert.equal(after.activeTurnToken, null);
    assert.equal(after.archived, true);
    assert.equal((await review.state()).settlement?.pending, false);
    console.log(`✓ ${mode}: late archival withdraws the persisted startup without undoing archival`);
  }

  const replacement = await open("legacy");
  const state = await replacement.state();
  const previous = await row(replacement.ownerTaskId);
  await db.update(tasks).set({ directionEpoch: previous.directionEpoch + 1, activeTurnToken: "replacement",
    activeDirectionToken: "replacement-direction" }).where(eq(tasks.id, previous.id));
  const newer = await row(previous.id);
  await withdrawReviewStart(previous.id, { directory: state.directory, generation: state.generation,
    identity: reviewTargetIdentity(previous) }, "paused");
  assert.deepEqual(await row(previous.id), newer);
  assert.equal((await replacement.state()).settlement, null);
  runs.releaseTurn(previous.id);
  console.log("✓ delayed withdrawal cannot clear a replacement turn's state or ledger");

  const early = await open("legacy");
  await db.delete(schema.scheduledMessages);
  await db.update(tasks).set({ status: "paused" }).where(eq(tasks.id, early.ownerTaskId));
  await occupyResumePrompt(early.ownerTaskId, "Stale before startup", false);
  const earlyTarget = await row(early.taskId);
  await db.update(tasks).set({ directionEpoch: earlyTarget.directionEpoch + 1 }).where(eq(tasks.id, early.taskId));
  runs.releaseTurn(early.ownerTaskId);
  assert.equal(await continueTask(early.ownerTaskId, "Stale review continuation"), false);
  assert.notEqual((await row(early.ownerTaskId)).status, "running");
  assert.equal(runs.isTurnClaimed(early.ownerTaskId), false);
  await reconcileRegressionSettlements(early.ownerTaskId);
  assert.equal((await row(early.ownerTaskId)).resumePrompt, null);
  assert.equal((await early.state()).settlement?.pending, false);
  console.log("✓ rejection before taking ownership leaves no persisted startup and recovery closes the old waiting round");

  const frozen = await open("legacy");
  await db.delete(schema.scheduledMessages);
  await db.update(tasks).set({ status: "paused" }).where(eq(tasks.id, frozen.ownerTaskId));
  await occupyResumePrompt(frozen.ownerTaskId, "Frozen review checkpoint", false);
  runs.releaseTurn(frozen.ownerTaskId);
  const transaction = db.transaction;
  let froze = false;
  db.transaction = async function (...args) {
    if (!froze && new Error().stack?.includes("assertReviewTurnStart")) {
      froze = true;
      runs.freezeStartingTurn(frozen.ownerTaskId, "paused");
    }
    return transaction.apply(this, args);
  };
  try { assert.equal(await continueTask(frozen.ownerTaskId, "Continue frozen review"), false); }
  finally { db.transaction = transaction; }
  assert(froze);
  assert.equal((await row(frozen.ownerTaskId)).status, "paused");
  assert.equal((await row(frozen.ownerTaskId)).activeTurnToken, null);
  assert.equal((await row(frozen.ownerTaskId)).resumePrompt, "Frozen review checkpoint");
  assert.equal((await frozen.state()).settlement, null);
  assert.equal(runs.isTurnClaimed(frozen.ownerTaskId), false);
  console.log("✓ a legitimate startup freeze restores paused state and retains the authorized checkpoint for retry");

  // 同一个 ReviewSuperseded 也可能在 spawn **之后**抛(commitReviewTurnDelivery 那笔事务前方向变了):
  // 输入已经交到 CLI 手上,continueTask 不许再说「一个字没送出去」—— 调用方据 false 归还
  // 检查点或把原话退回托盘,同一段输入就会执行两遍(第 1 轮自由审查 ukEvngoK6Yvh 必须修)。
  const late = await open("legacy");
  await db.delete(schema.scheduledMessages);
  await db.update(tasks).set({ status: "paused" }).where(eq(tasks.id, late.ownerTaskId));
  await occupyResumePrompt(late.ownerTaskId, "Superseded after spawn", false);
  runs.releaseTurn(late.ownerTaskId);
  const committing = db.transaction;
  let superseded = false;
  db.transaction = async function (...args) {
    if (!superseded && new Error().stack?.includes("commitReviewTurnDelivery")) {
      superseded = true;
      const owner = await row(late.ownerTaskId);
      await db.update(tasks).set({ directionEpoch: owner.directionEpoch + 1 }).where(eq(tasks.id, late.ownerTaskId));
    }
    return committing.apply(this, args);
  };
  try { assert.equal(await continueTask(late.ownerTaskId, "Continue superseded review"), true, "越过 spawn 的撤回不许报「没送出去」"); }
  finally { db.transaction = committing; }
  assert(superseded);
  assert.equal(runs.isTurnClaimed(late.ownerTaskId), false);
  console.log("✓ a review superseded after spawn reports the input as crossed, not as never sent");

  const native = await open("preset");
  await db.delete(schema.scheduledMessages);
  await db.update(tasks).set({ status: "paused" }).where(eq(tasks.id, native.taskId));
  runs.releaseTurn(native.taskId);
  await continueTask(native.taskId, "/compact", { agent: "claude" });
  assert.equal((await native.state()).continuation?.start, undefined);
  assert.equal((await native.state()).settlement, null);
  assert.equal((await row(native.taskId)).verifyRound, 1);
  console.log("✓ a native side turn clears its startup marker without consuming the verification round");

  for (const mode of ["preset", "legacy"] as const) {
    const review = await open(mode);
    await db.transaction(async (transaction) => {
      const owner = await row(review.ownerTaskId);
      await startTaskWaitTurn(transaction, owner, reviewTargetIdentity(owner), reviewWaitOrigin(await review.state()));
    }, { behavior: "immediate" });
    const command = { ...makeStep("command", "post-review-command"),
      p: { cmd: "node -e 'process.exit(1)'", where: "workspace" }, fail: { mode: "ask" } };
    await db.update(tasks).set({ workflow: JSON.stringify({ workspace: "shared", steps: [makeStep("run", "run"),
      makeStep("verify", "verify"), command, makeStep("human", "human")] }) }).where(eq(tasks.id, review.taskId));
    assert.equal((await review.stage()).status, 200);
    await review.settle(true);
    const after = await row(review.taskId);
    assert(after.question?.includes("问我一句"));
    assert.equal(after.waitOwnership?.question?.origin.kind, "ordinary");
    assert.notEqual((await review.state()).finalization?.superseded, true);
    assert.equal((await review.state()).finalization?.completed, true);
    runs.releaseTurn(review.ownerTaskId);
    await reconcileRegressionSettlements(review.taskId);
    assert.equal((await row(review.taskId)).question, after.question);
    for (const kind of ["command", "preview", "accept"] as const) {
      await applyFailPolicy(await row(review.taskId), { ...makeStep(kind, kind), fail: { mode: "ask" } },
        `${kind} failed`, () => "unused");
      assert.equal((await row(review.taskId)).waitOwnership?.question?.origin.kind, "ordinary");
    }
    console.log(`✓ ${mode}: real post-verification command failure creates a durable ordinary workflow question`);
  }

  const ordinary = await open("free");
  const old = await row(ordinary.taskId);
  await db.transaction((transaction) => startTaskWaitTurn(transaction, old,
    reviewTargetIdentity(old), { kind: "ordinary" }), { behavior: "immediate" });
  await occupyResumePrompt(ordinary.taskId, "New ordinary checkpoint", false);
  await db.update(tasks).set({ status: "paused" }).where(eq(tasks.id, ordinary.taskId));
  runs.releaseTurn(ordinary.taskId);
  await resumeOrRunTask(ordinary.taskId, { reason: "run" });
  assert((await row(ordinary.taskId)).directionEpoch > old.directionEpoch);
  assert.equal((await row(ordinary.taskId)).waitOwnership?.turn?.origin.kind, "ordinary");
  assert.equal((await row(ordinary.taskId)).resumePrompt, null);
  console.log("✓ a known ordinary checkpoint starts on the first click despite an unreconciled reviewing run");

  const source = await open("free");
  await source.settle(false);
  runs.releaseTurn(source.taskId);
  const sourceRow = await row(source.taskId);
  await db.transaction((transaction) => startTaskWaitTurn(transaction, sourceRow,
    reviewTargetIdentity(sourceRow), { kind: "ordinary" }), { behavior: "immediate" });
  await setTaskQuestion({ taskId: source.taskId, question: "New ordinary question" });
  await occupyResumePrompt(source.taskId, "New ordinary checkpoint", false);
  await db.update(tasks).set({ status: "paused" }).where(eq(tasks.id, source.taskId));
  const original = await row(source.taskId);
  const run = (await db.select().from(schema.freeReviewRuns).where(eq(schema.freeReviewRuns.id, source.runId)))[0]!;
  const at = new Date().toISOString();
  const manifest = { version: 1, sourceHost: "fixture", sourceFingerprint: "a".repeat(64),
    targetProjectId: original.projectId, transferId: "ordinary-wait-transfer", autoResume: false,
    sourceWorkspace: null, git: null, sessions: [], files: [],
    task: { ...original, id: "imported-ordinary-wait", waitOrigins: await exportWaitOrigins(original) },
    freeWorkflow: { state: null, events: [], runs: [{ ...run, id: "imported-review", rounds: [{ round: 1,
      status: "failed", conclusion: null, reviewedCommit: null, startedAt: at, endedAt: at }] }] } };
  const imported = await importHandoff(manifest);
  const before = await row(imported.taskId);
  assert.equal(before.waitOwnership?.question?.origin.kind, "ordinary");
  assert.equal(before.waitOwnership?.checkpoint?.origin.kind, "ordinary");
  assert.notEqual(before.waitOwnership?.question?.occupancy, original.waitOwnership?.question?.occupancy);
  await reconcileRegressionSettlements(imported.taskId);
  assert.equal((await row(imported.taskId)).question, before.question);
  await db.insert(schema.sessions).values([
    { id: "imported-ordinary-session", taskId: imported.taskId, role: "single", agentType: "claude", executor: "test",
      startedAt: new Date(Date.now() - 2000).toISOString() },
    { id: "imported-old-reviewer-session", taskId: imported.taskId, role: "reviewer", agentType: "codex", executor: "test",
      startedAt: new Date(Date.now() - 1000).toISOString() },
  ]);
  assert.equal((await answer(imported.taskId)).status, 200);
  await until("imported ordinary answer finishes", async () => !runs.isTurnClaimed(imported.taskId)
    && (await row(imported.taskId)).directionEpoch > before.directionEpoch);
  assert.equal((await row(imported.taskId)).waitOwnership?.turn?.origin.kind, "ordinary");
  assert((await db.select().from(schema.sessions).where(eq(schema.sessions.taskId, imported.taskId)))
    .some((session) => session.role === "single" && session.agentType === "claude" && session.id !== "imported-ordinary-session"));
  console.log("✓ export/import preserves ordinary provenance, renews occupancy and accepts the answer despite review history");

  await occupyResumePrompt(imported.taskId, "Borrowed on the receiving machine", false);
  const local = await row(imported.taskId);
  const receipt = await takeResumePrompt(local.id, local.resumePrompt!, local.resumePromptGeneration);
  assert(receipt);
  await db.update(tasks).set({ handoff: JSON.stringify({ direction: "out", pending: false,
    peerFp: manifest.sourceFingerprint, transferId: "outbound" }) }).where(eq(tasks.id, local.id));
  const returned = await importHandoff({ ...manifest, transferId: "returned-wait", task: {
    ...manifest.task, id: local.id, question: "Returned ordinary question", resumePrompt: "Returned ordinary checkpoint" } });
  const returnedRow = await row(returned.taskId);
  assert(returnedRow.resumePromptGeneration > receipt.generation);
  assert.equal(await restoreResumePrompt(local.id, receipt), false);
  assert.equal(returnedRow.waitOwnership?.question?.text, "Returned ordinary question");
  assert.equal(returnedRow.waitOwnership?.checkpoint?.generation, returnedRow.resumePromptGeneration);
  await reconcileRegressionSettlements(local.id);
  assert.equal((await row(local.id)).resumePrompt, "Returned ordinary checkpoint");
  console.log("✓ safe return replaces local ownership and advances checkpoint generation beyond in-flight local receipts");

  const importedReview = await importHandoff({ ...manifest, transferId: "review-wait", task: {
    ...manifest.task, id: "imported-review-wait", waitOrigins: { question: "review", checkpoint: "review" } }, freeWorkflow: null });
  const reviewWait = await row(importedReview.taskId);
  assert.equal(reviewWait.waitOwnership?.question?.origin.kind, "review");
  assert.equal((await answer(importedReview.taskId)).status, 409);
  assert.equal((await row(importedReview.taskId)).question, null);
  assert.equal((await row(importedReview.taskId)).resumePrompt, null);
  console.log("✓ imported review waits do not inherit local authority or become ordinary implementation input");

  await assert.rejects(importHandoff({ ...manifest, transferId: "bad-wait", task: {
    ...manifest.task, id: "invalid-wait-import", waitOrigins: { question: "invalid" } } }), /waitOrigins 非法/);
  assert.equal((await db.select().from(tasks).where(eq(tasks.id, "invalid-wait-import"))).length, 0);
  console.log("✓ malformed provenance is rejected before import creates a task");
} finally { await teardown(); }
