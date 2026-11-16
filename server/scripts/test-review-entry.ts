import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { db, runs, schema, tasks, teardown, until } from "./monitors-fixture.js";
import { setupRegressionReviews } from "./regression-review-fixture.js";

const { continueTask } = await import("../src/orchestrator.js");
const { resumeOrRunTask } = await import("../src/task-resume.js");
const { occupyResumePrompt } = await import("../src/task-resume-prompt.js");
const { mountTaskRunRoutes } = await import("../src/task-run-routes.js");
const { sessionTranscriptPath } = await import("../src/transcript.js");
const { withTurnPreflight } = await import("../src/turn-entry-guard.js");
const row = async (taskId: string) => (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!;
const api = new Hono();
mountTaskRunRoutes(api);

assert.notEqual(process.env.ASH_ALLOW_REAL_AGENT, "1");
try {
  const { open, openQuiet } = await setupRegressionReviews();
  for (const entry of ["continue", "checkpoint"] as const) {
    const review = await open("preset");
    await db.update(tasks).set({ status: "paused" }).where(eq(tasks.id, review.taskId));
    if (entry === "checkpoint") await occupyResumePrompt(review.taskId, "Continue this review", false);
    const original = db.transaction;
    let injected = false;
    db.transaction = async function (...args) {
      if (!injected) { injected = true; throw new Error("ONCE_REVIEW_PREFLIGHT_FAULT"); }
      return original.apply(this, args);
    };
    // `turnHeld` 现在是**那把锁的身份**(第 2 轮审查 F1)。这一轮的锁是派审那一侧占下的
    // (所以这里再 claim 一次是占不到的),交下去的就是它那一份 —— 本节验的正是「读失败要把
    // 调用方那把锁还回去」。
    const entryTurn = runs.turnIdentity(review.taskId);
    assert.ok(entryTurn, "台子前提:派审已经占住这一轮");
    try {
      await assert.rejects(entry === "continue"
        ? continueTask(review.taskId, "Continue", { turnHeld: entryTurn })
        : resumeOrRunTask(review.taskId, { reason: "run", turnHeld: entryTurn }), /ONCE_REVIEW_PREFLIGHT_FAULT/);
    } finally { db.transaction = original; }
    assert(injected);
    assert.equal(runs.isTurnClaimed(review.taskId), false);
    assert.equal(await continueTask(review.taskId, "Continue after the read recovers"), true);
    assert.equal(runs.isTurnClaimed(review.taskId), false);
    console.log(`✓ ${entry}: one-shot read failure releases the caller's turn and a subsequent continuation starts`);
  }

  for (const route of ["run", "retry"] as const) {
    for (const fault of ["evidence", "retirement"] as const) {
      // 走的是独立审查任务(reviewOf)那一种:就地验证轮没出结论时 /run、/retry 在门口就拒了
      // (task-action-verdicts.ts 的 pendingSideState),HTTP 能真走到起跑前检查的只剩这一种。
      // 夹具排着的哨兵结果先撤掉,不然放锁那一下的后台投递会抢先把这一轮收走。
      const opened = await openQuiet("legacy");
      const review = { ...opened, taskId: opened.ownerTaskId };
      await db.update(tasks).set({ status: route === "run" ? "paused" : "failed" }).where(eq(tasks.id, review.taskId));
      await occupyResumePrompt(review.taskId, "Continue this review", false);
      const checkpoint = await row(review.taskId);
      runs.releaseTurn(review.taskId);
      const sessionId = `entry-${review.taskId}`;
      await db.insert(schema.sessions).values({ id: sessionId, taskId: review.taskId, role: "single", agentType: "codex",
        executor: "test", startedAt: new Date().toISOString() });
      const transcript = sessionTranscriptPath(review.taskId, sessionId);
      const original = db.transaction;
      const message = `HTTP_ONCE_${fault.toUpperCase()}_FAULT`;
      let injected = false;
      db.transaction = async function (...args) {
        const stack = new Error().stack ?? "";
        if (!injected && stack.includes(fault === "evidence" ? "resumeOrRunClaimedTask" : "review-retirement")) {
          injected = true;
          throw new Error(message);
        }
        return original.apply(this, args);
      };
      try {
        const first = await api.request(`/tasks/${review.taskId}/${route}`, { method: "POST" });
        assert.equal(first.status, 409, "a failed preflight must not acknowledge an unstarted review");
        assert.match((await first.json()).error, /尚未启动/);
        await until("HTTP preflight fails once and publishes a durable retry notice", async () => injected
          && !runs.isTurnClaimed(review.taskId) && existsSync(transcript) && readFileSync(transcript, "utf8").includes(message));
      } finally { db.transaction = original; }
      const rejected = await row(review.taskId);
      assert.equal(rejected.status, route === "run" ? "paused" : "failed");
      assert.equal(rejected.resumePrompt, checkpoint.resumePrompt);
      assert.equal(rejected.resumePromptGeneration, checkpoint.resumePromptGeneration);
      assert.equal(runs.isRunning(review.taskId), false);
      const second = await api.request(`/tasks/${review.taskId}/${route}`, { method: "POST" });
      assert.equal(second.status, 202, "a recovered database must not leave /run or /retry permanently blocked");
      await until("retried review releases its test-only turn", async () => !runs.isTurnClaimed(review.taskId));
      console.log(`✓ HTTP /${route} ${fault}: rejected startup preserves the checkpoint, reports failure and the next request starts`);
    }
  }

  const replacement = await open("preset");
  // 交下去的是**旧那一把的身份**:传 true 的话按号核验永远对不上,这一档无论产品对错都过。
  const older = runs.turnIdentity(replacement.taskId);
  assert.ok(older, "台子前提:派审已经占住这一轮");
  let newer = older;
  await assert.rejects(withTurnPreflight(replacement.taskId, older, async () => {
    runs.releaseTurn(replacement.taskId);
    assert(runs.claimTurn(replacement.taskId));
    newer = runs.turnIdentity(replacement.taskId);
    throw new Error("OLD_PREFLIGHT_FAILURE");
  }), /OLD_PREFLIGHT_FAILURE/);
  assert.notEqual(newer, older);
  assert.equal(runs.turnIdentity(replacement.taskId), newer);
  assert(runs.isTurnClaimed(replacement.taskId));
  runs.releaseTurn(replacement.taskId);
  console.log("✓ a late preflight failure cannot release a replacement turn's reservation");
} finally { await teardown(); }
