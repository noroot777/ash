import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { db, tasks, schema, runs, teardown } from "./monitors-fixture.js";
import { setupRegressionReviews } from "./regression-review-fixture.js";

const { setTaskQuestion } = await import("../src/task-question.js");
const { occupyResumePrompt, takeResumePrompt } = await import("../src/task-resume-prompt.js");
const { answerTask } = await import("../src/task-answer.js");
const { continueTask } = await import("../src/orchestrator.js");
const { beginDelivery } = await import("../src/pending-messages.js");
const { deliveryOptions, monitorWakeGuard } = await import("../src/pending-verdict.js");
const { reviewDeliveryBlocked } = await import("../src/review-ownership.js");
const { reconcileRegressionSettlements } = await import("../src/regression-settlement.js");
const { freeReviewResumeOptions } = await import("../src/free-workflow.js");
const { mountGroupRoutes } = await import("../src/group-routes.js");
const row = async (taskId: string) => (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!;
const recoveryUrl = new URL("../src/regression-settlement.ts", import.meta.url).href;
const recover = () => execFileSync(process.execPath, ["--import", "tsx/esm", "--input-type=module", "-e",
  `await (await import(${JSON.stringify(recoveryUrl)})).reconcileRegressionSettlements();`], { env: process.env, stdio: "pipe" });

assert.notEqual(process.env.ASH_ALLOW_REAL_AGENT, "1");
try {
  const { open } = await setupRegressionReviews();
  for (const mode of ["preset", "legacy", "free", "accepted_merge"] as const) {
    for (const input of ["answer", "checkpoint"] as const) {
      for (const fault of mode === "preset" && input === "answer" ? ["none", "rollback", "preflight"] : ["none"]) {
        const review = await open(mode);
        await db.delete(schema.scheduledMessages);
        const taskId = review.ownerTaskId;
        const at = new Date().toISOString();
        await db.insert(schema.sessions).values({ id: `delivery-${taskId}`, taskId,
          role: mode === "free" || mode === "accepted_merge" ? "reviewer" : "single", agentType: "codex", executor: "test", startedAt: at });
        if (input === "answer") await setTaskQuestion({ taskId, question: "Continue this review?" });
        else await occupyResumePrompt(taskId, "Continue the same review checkpoint", false);
        await db.update(tasks).set({ status: "paused" }).where(eq(tasks.id, taskId));
        await review.settle(true);
        const groupId = `freeze-${taskId}`;
        await db.insert(schema.groups).values({ id: groupId, projectId: (await row(taskId)).projectId,
          name: "review delivery freeze", createdAt: at });
        await db.update(tasks).set({ groupId }).where(eq(tasks.id, taskId));
        const api = new Hono();
        mountGroupRoutes(api);
        api.post("/answer", (context) => answerTask(context, taskId));
        if (input === "answer") assert.equal((await api.request("/answer", { method: "POST",
          headers: { "content-type": "application/json" }, body: JSON.stringify({ answer: "Same review answer" }) })).status, 200);
        const message = (await db.select().from(schema.scheduledMessages).where(eq(schema.scheduledMessages.taskId, taskId)))[0];
        if (message) assert(await beginDelivery(message.id));
        const checkpoint = await row(taskId);
        const options = message ? { ...deliveryOptions(message), wakeGuard: monitorWakeGuard(message) } : {
          ...await freeReviewResumeOptions(taskId), system: "run" as const,
          reviewDelivery: { kind: "checkpoint" as const, generation: (await review.state()).generation,
            text: checkpoint.resumePrompt!, promptGeneration: checkpoint.resumePromptGeneration },
        };
        const text = message?.text ?? checkpoint.resumePrompt!;
        runs.releaseTurn(taskId);
        const transaction = db.transaction;
        let injected = false, failed = false, delivered = false;
        db.transaction = async function (...args) {
          if (!injected && new Error().stack?.includes("assertReviewTurnStart")) {
            injected = true;
            assert.equal((await api.request(`/groups/${groupId}/pause`, { method: "POST" })).status, 200);
            if (fault === "preflight") throw new Error("ONCE_START_STORAGE_FAILURE");
          }
          if (fault === "rollback" && !failed && new Error().stack?.includes("restoreUndeliveredReviewStart")) {
            failed = true;
            throw new Error("ONCE_DELIVERY_RESTORE_FAILURE");
          }
          return transaction.apply(this, args);
        };
        const start = () => continueTask(taskId, text, { ...options, freezeGuard: true,
          onDelivered: async () => { delivered = true; } });
        try {
          if (fault === "rollback") await assert.rejects(start(), /ONCE_DELIVERY_RESTORE_FAILURE/);
          else assert.equal(await start(), false);
        } finally { db.transaction = transaction; }
        assert(injected);
        assert.equal(delivered, false);
        if (fault === "rollback") recover();
        await reconcileRegressionSettlements(taskId);
        const state = await review.state();
        assert.equal(state.settlement, null);
        assert.equal(state.continuation?.phase, input === "answer" ? "delivery" : "waiting");
        assert.equal(state.continuation?.start, undefined);
        assert.equal((await row(taskId)).waitOwnership?.start, undefined);
        assert.equal((await row(taskId)).status, "paused");
        assert.equal(await reviewDeliveryBlocked(options.reviewDelivery, taskId), null);
        assert.equal(await start(), false, "a paused group cannot spawn even though the same input retains authority");
        await db.update(schema.groups).set({ paused: false }).where(eq(schema.groups.id, groupId));
        assert.equal(await continueTask(taskId, text, { ...options, freezeGuard: true, onDelivered: async () => {
          delivered = true;
          if (message) await db.update(schema.scheduledMessages).set({ status: "sent", deliveringSince: null })
            .where(eq(schema.scheduledMessages.id, message.id));
          else {
            await takeResumePrompt(taskId, text, checkpoint.resumePromptGeneration);
            assert.equal((await row(taskId)).resumePrompt, null);
          }
        } }), true);
        assert(delivered);
        assert.equal((await row(taskId)).waitOwnership?.start, undefined);
        assert(await reviewDeliveryBlocked(options.reviewDelivery, taskId), "actual delivery loses the old retry authority");
        console.log(`✓ ${mode} ${input}: real group pause preserves undelivered authority, retry delivers once (${fault})`);
      }
    }
  }
} finally { await teardown(); }
