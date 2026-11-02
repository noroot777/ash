import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { db, tasks, schema, runs, teardown } from "./monitors-fixture.js";
import { setupRegressionReviews } from "./regression-review-fixture.js";

const { beginDelivery, deliverPendingMessages } = await import("../src/pending-messages.js");
const { setTaskQuestion } = await import("../src/task-question.js");
const { occupyResumePrompt } = await import("../src/task-resume-prompt.js");
const { answerTask } = await import("../src/task-answer.js");
const { reconcileInterrupted } = await import("../src/task-reconcile.js");
const { reattachRunningTasks } = await import("../src/reattach.js");
const { reconcileRegressionSettlements } = await import("../src/regression-settlement.js");
const { reconcileFreeReviews, freeReviewResumeOptions } = await import("../src/free-workflow.js");
const { deliveryVerdict } = await import("../src/pending-verdict.js");
const row = async (taskId: string) => (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!;
const worker = fileURLToPath(new URL("./review-delivery-worker.ts", import.meta.url));
const execute = (input: unknown, fault: string, marker: string) => new Promise<{ code: number | null; output: string }>((resolve, reject) => {
  const child = spawn(process.execPath, ["--import", "tsx/esm", worker, JSON.stringify(input), fault, marker], { env: process.env });
  let output = "";
  child.stdout.on("data", (data) => { output += data; });
  child.stderr.on("data", (data) => { output += data; });
  child.on("error", reject);
  child.on("close", (code) => resolve({ code, output }));
});

try {
  const { open, repo } = await setupRegressionReviews();
  for (const mode of ["preset", "legacy", "free", "accepted_merge"] as const) {
    for (const kind of ["answer", "checkpoint"] as const) {
      for (const fault of ["before", "intent", "after", "committed"]) {
        const review = await open(mode);
        await db.delete(schema.scheduledMessages);
        const taskId = review.ownerTaskId;
        const at = new Date().toISOString();
        await db.insert(schema.sessions).values({ id: `recovery-${taskId}`, taskId,
          role: mode === "free" || mode === "accepted_merge" ? "reviewer" : "single", agentType: "codex",
          executor: "test", startedAt: at, endedAt: at });
        if (mode === "legacy") await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, review.taskId));
        const text = `Continue the ${kind} in the same review`;
        if (kind === "answer") await setTaskQuestion({ taskId, question: "May this review continue?" });
        else await occupyResumePrompt(taskId, text, false);
        await db.update(tasks).set({ status: "paused" }).where(eq(tasks.id, taskId));
        await review.settle(true);
        let input: Parameters<typeof execute>[0];
        if (kind === "answer") {
          const api = new Hono();
          api.post("/answer", (context) => answerTask(context, taskId));
          assert.equal((await api.request("/answer", { method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ answer: text }) })).status, 200);
          const message = (await db.select().from(schema.scheduledMessages).where(eq(schema.scheduledMessages.taskId, taskId)))
            .find((message) => message.origin?.startsWith("review-answer:"))!;
          assert(message);
          assert(await beginDelivery(message.id));
          input = { taskId, text, message };
        } else {
          const checkpoint = await row(taskId);
          const options = { ...await freeReviewResumeOptions(taskId), system: "run", freezeGuard: true,
            reviewDelivery: { kind: "checkpoint", generation: (await review.state()).generation,
              text, promptGeneration: checkpoint.resumePromptGeneration } };
          input = { taskId, text, options };
        }
        runs.releaseTurn(taskId);
        const marker = join(repo, `delivered-${mode}-${kind}-${fault}`);
        const first = await execute(input, fault, marker);
        assert.equal(first.code, 86, first.output);
        assert.equal(existsSync(marker), ["after", "committed"].includes(fault));
        await reattachRunningTasks();
        await reconcileInterrupted();
        await reconcileFreeReviews();
        await reconcileRegressionSettlements();
        const task = await row(taskId), state = await review.state();
        if (fault === "before") {
          assert.equal(state.settlement, null);
          assert.equal(task.waitOwnership?.start, undefined);
          const retry = await execute(input, "none", marker);
          assert.equal(retry.code, 0, retry.output);
          assert.equal(readFileSync(marker, "utf8"), "delivered\n");
        } else if (fault === "committed") {
          assert.equal(task.waitOwnership?.deliveredReview?.generation, state.generation);
          assert.equal(task.waitOwnership?.start, undefined);
          assert.equal(readFileSync(marker, "utf8"), "delivered\n");
        } else {
          assert.equal(state.settlement, null);
          assert.equal(state.continuation?.phase, "uncertain");
          assert.equal(task.status, "paused");
          assert.equal(task.waitOwnership?.start?.phase, "uncertain");
          assert.equal(deliveryVerdict({ mode: "queued", sendAt: at }, { ...task, reviewUncertain: true }, new Date()).action, "wait");
          await deliverPendingMessages(taskId);
          await reconcileRegressionSettlements();
          const retry = await execute(input, "none", marker);
          assert.equal(retry.code, 0, retry.output);
          assert.match(retry.output, /CONTINUE_RESULT false/);
          assert.equal(existsSync(marker) ? readFileSync(marker, "utf8") : "", fault === "after" ? "delivered\n" : "");
          assert.equal((await row(taskId)).waitOwnership?.start?.phase, "uncertain");
          if (kind === "answer") assert.equal((await db.select().from(schema.scheduledMessages)
            .where(eq(schema.scheduledMessages.taskId, taskId)))[0]?.status, "pending");
        }
        console.log(`✓ ${mode} ${kind} ${fault}: actual startup preserves delivery facts without replay`);
      }
    }
  }
} finally { await teardown(); }
