import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { makeStep } from "@ash/shared/workflow";
import { db, tasks, schema, runs, until, teardown } from "./monitors-fixture.js";
import { setupRegressionReviews } from "./regression-review-fixture.js";

const { ClaudeExecutor } = await import("../src/executors/claude.js");
const { CodexExecutor } = await import("../src/executors/codex.js");
const { rehandOffAcceptGate } = await import("../src/accept-gate.js");
let deliveries = 0;
const run = () => {
  deliveries += 1;
  return { sessionId: "gate-repair-test", commandLine: "local gate repair test", kill() {},
    events: (async function* () { yield { kind: "done" as const, exitStatus: 0 }; })() };
};
for (const executor of [ClaudeExecutor.prototype, CodexExecutor.prototype]) {
  executor.run = run;
  executor.runSteerable = run;
}
try {
  const { open } = await setupRegressionReviews();
  const review = await open("preset");
  const task = (await db.select().from(tasks).where(eq(tasks.id, review.taskId)))[0]!;
  await db.update(schema.projects).set({ acceptGateCommand: "exit 9" }).where(eq(schema.projects.id, task.projectId));
  await db.update(tasks).set({ workflow: JSON.stringify({ workspace: "shared", steps: [makeStep("run", "run"),
    makeStep("human", "human"), makeStep("verify", "verify"), makeStep("accept", "accept")] }) }).where(eq(tasks.id, task.id));
  assert.equal((await review.stage()).status, 200);
  await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, task.id));
  runs.releaseTurn(task.id);
  await review.settle(true);
  await until("real failed gate repair actually delivered", async () => deliveries === 1 && !runs.isTurnClaimed(task.id));
  const gate = (await db.select().from(schema.acceptGateRuns).where(eq(schema.acceptGateRuns.taskId, task.id)))[0]!;
  assert.equal(gate.exitCode, 9);
  assert.equal(gate.status, "failed");
  assert.equal(gate.handoffError, null);
  const state = await review.state();
  const message = (await db.select().from(schema.scheduledMessages).where(eq(schema.scheduledMessages.taskId, task.id)))
    .find((message) => message.origin === `review-settlement:${state.generation}`);
  assert(message);
  assert.notEqual(message.id, gate.id);
  assert.equal(message.status, "sent");
  assert.equal((await rehandOffAcceptGate(task.id)).ok, true);
  await until("explicit manual rehandoff remains available", async () => deliveries === 2 && !runs.isTurnClaimed(task.id));
  console.log("✓ gate failure: real command exit persists repair input, automatic consumer starts once, manual retry stays explicit");
} finally { await teardown(); }
