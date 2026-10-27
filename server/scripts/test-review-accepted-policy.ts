import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { makeStep } from "@ash/shared/workflow";
import { db, tasks, schema, runs, teardown } from "./monitors-fixture.js";
import { setupRegressionReviews } from "./regression-review-fixture.js";

const { acceptTask } = await import("../src/task-accept.js");
const { setTaskStage } = await import("../src/task-stage.js");
const { beginDelivery } = await import("../src/pending-messages.js");
const { reviewDeliveryBlocked, reviewDeliveryFrom } = await import("../src/review-ownership.js");
const { taskWorkspace } = await import("../src/task-workspace.js");
const row = async (taskId: string) => (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!;
const worker = fileURLToPath(new URL("./review-delivery-worker.ts", import.meta.url));
const execute = (input: unknown, marker: string) => new Promise<{ code: number | null; output: string }>((resolve, reject) => {
  const child = spawn(process.execPath, ["--import", "tsx/esm", worker, JSON.stringify(input), "none", marker], { env: process.env });
  let output = "";
  child.stdout.on("data", (data) => { output += data; });
  child.stderr.on("data", (data) => { output += data; });
  child.on("error", reject);
  child.on("close", (code) => resolve({ code, output }));
});

try {
  const { open, repo, git } = await setupRegressionReviews();
  writeFileSync(join(repo, ".gitignore"), ".worktrees/\n");
  git("add", ".gitignore");
  git("commit", "-m", "ignore isolated test workspaces");
  for (const scenario of ["stop", "ask", "back", "archive", "direction", "external", "superseded", "missing", "cleaned"] as const) {
    const review = await open("preset");
    await db.delete(schema.scheduledMessages);
    const marker = `marker-${scenario}`, ready = `ready-${scenario}`, delivery = join(repo, `delivery-${scenario}`);
    const policy = ["stop", "ask"].includes(scenario) ? scenario as "stop" | "ask" : "back";
    const command = { ...makeStep("command", "post-accept"), fail: { mode: policy, max: 2 },
      p: { where: "repo" as const, cmd: `node -e "const fs=require('fs');if(!fs.existsSync('${ready}'))process.exit(9);fs.appendFileSync('${marker}','1')"` } };
    await db.update(tasks).set({ useWorktree: scenario === "cleaned", workflow: JSON.stringify({
      workspace: scenario === "cleaned" ? "isolated" : "shared", steps: [makeStep("run", "run"),
        makeStep("human", "human"), makeStep("verify", "verify"), makeStep("accept", "accept"), command] }) })
      .where(eq(tasks.id, review.taskId));
    const workspace = scenario === "cleaned" ? await taskWorkspace(await row(review.taskId), repo) : null;
    assert.equal((await review.stage()).status, 200);
    await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, review.taskId));
    runs.releaseTurn(review.ownerTaskId);
    await review.settle(true);
    const state = await review.state(), task = await row(review.taskId);
    assert.equal(task.stage, "accepted");
    assert.equal(state.finalization?.completed, undefined);
    assert.equal(state.finalization?.superseded, undefined);
    assert.equal(task.acceptedTailPending, true);
    const repairs = (await db.select().from(schema.scheduledMessages).where(eq(schema.scheduledMessages.taskId, task.id)))
      .filter((message) => message.origin?.startsWith("review-settlement:"));
    if (["ask", "cleaned"].includes(scenario)) {
      assert(task.question);
      assert.equal(repairs.length, 0);
      if (workspace) assert.equal(existsSync(workspace.path), false);
    } else if (scenario === "stop") {
      writeFileSync(join(repo, ready), "ready");
      assert.equal((await acceptTask(task.id, "human")).tail?.ok, true);
      assert.equal(readFileSync(join(repo, marker), "utf8"), "1");
    } else {
      const message = repairs[0]!;
      assert.equal(repairs.length, 1);
      assert.equal(await reviewDeliveryBlocked(reviewDeliveryFrom(message), task.id), null);
      assert.equal((await acceptTask(task.id, "human")).tail?.ok, false);
      if (scenario === "archive") await db.update(tasks).set({ archived: true }).where(eq(tasks.id, task.id));
      if (scenario === "direction") await db.update(tasks).set({ directionEpoch: task.directionEpoch + 1 }).where(eq(tasks.id, task.id));
      if (scenario === "external") await setTaskStage(task.id, "accepted");
      if (scenario === "superseded" || scenario === "missing") await db.update(schema.regressionEvidence)
        .set({ finalization: scenario === "missing" ? null : { ...state.finalization!, completed: true, superseded: true } })
        .where(eq(schema.regressionEvidence.directory, state.directory));
      if (scenario === "back") {
        assert(await beginDelivery(message.id));
        const result = await execute({ taskId: task.id, text: message.text, message }, delivery);
        assert.equal(result.code, 0, result.output);
        assert.match(result.output, /CONTINUE_RESULT true/);
        assert.equal(readFileSync(delivery, "utf8"), "delivered\n");
        assert.equal((await row(task.id)).stage, "accepted");
        writeFileSync(join(repo, ready), "ready");
        assert.equal((await acceptTask(task.id, "human")).tail?.ok, true);
        assert.equal(readFileSync(join(repo, marker), "utf8"), "1");
        assert.equal((await row(task.id)).acceptedTailPending, false);
      } else {
        assert(await reviewDeliveryBlocked(reviewDeliveryFrom(message), task.id));
        if (["superseded", "missing"].includes(scenario)) assert.equal((await acceptTask(task.id, "human")).tail?.ok, false);
        assert.equal(existsSync(delivery), false);
      }
    }
    for (const filename of [join(repo, marker), join(repo, ready), delivery]) rmSync(filename, { force: true });
    console.log(`✓ accepted tail ${scenario}: bounded repair authority, honest completion, cleanup fallback`);
  }
} finally { await teardown(); }
