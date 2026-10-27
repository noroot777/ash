import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { makeStep } from "@ash/shared/workflow";
import { db, tasks, schema, runs, teardown, until } from "./monitors-fixture.js";
import { setupRegressionReviews } from "./regression-review-fixture.js";

const { reconcileRegressionSettlements } = await import("../src/regression-settlement.js");
const { acceptTask } = await import("../src/task-accept.js");
const { setTaskStage } = await import("../src/task-stage.js");
const { finalizationAuthority, settlementAuthority, withReviewAuthority, ReviewSuperseded } = await import("../src/review-ownership.js");
const row = async (taskId: string) => (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!;
const recoveryUrl = new URL("../src/regression-settlement.ts", import.meta.url).href;
const recover = () => execFileSync(process.execPath, ["--import", "tsx/esm", "--input-type=module", "-e",
  `await (await import(${JSON.stringify(recoveryUrl)})).reconcileRegressionSettlements();`], { env: process.env, stdio: "pipe" });

try {
  const { open, repo } = await setupRegressionReviews();
  for (const scenario of ["normal", "gate", "failure", "interrupted", "archive", "direction", "external"] as const) {
    // 门禁只认干净已提交的源码树（accept_gate_source_unavailable）：上一场景的工作流命令
    // 会在共享仓库里留下未跟踪的 marker/count 文件，先提交掉，否则 gate 场景起不了快照。
    execFileSync("git", ["-C", repo, "add", "-A"], { stdio: "pipe" });
    execFileSync("git", ["-C", repo, "commit", "--allow-empty", "-m", `housekeeping before ${scenario}`], { stdio: "pipe" });
    const review = await open("preset");
    const marker = `tail-${scenario}.txt`, ready = `ready-${scenario}.txt`;
    const count = `count-${scenario}.txt`;
    await db.update(schema.projects).set({ acceptGateCommand: scenario === "gate" ? "node -e \"console.log('gate passed')\"" : null })
      .where(eq(schema.projects.id, (await row(review.taskId)).projectId));
    const first = { ...makeStep("command", "first"), p: { where: "workspace" as const,
      cmd: `node -e "require('fs').appendFileSync('${count}','1')"` } };
    const command = { ...makeStep("command", "post-accept"), p: { where: "workspace" as const,
      cmd: `node -e "const fs=require('fs');${scenario === "failure" ? `if(!fs.existsSync('${ready}'))process.exit(1);` : ""}fs.appendFileSync('${marker}','1')"` } };
    await db.update(tasks).set({ workflow: JSON.stringify({ workspace: "shared", steps: [makeStep("run", "run"),
      makeStep("human", "human"), makeStep("verify", "verify"), makeStep("accept", "accept"), first, command] }) })
      .where(eq(tasks.id, review.taskId));
    assert.equal((await review.stage()).status, 200);
    await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, review.taskId));
    runs.releaseTurn(review.ownerTaskId);
    const transaction = db.transaction;
    let injected = false;
    db.transaction = async function (...args) {
      if (!injected && !["normal", "gate", "failure"].includes(scenario) && new Error().stack?.includes("checkpointFinalizationWorkflow")) {
        const state = await review.state();
        if (state.finalization?.steps.includes("first")) {
          injected = true;
          if (scenario === "archive") await db.update(tasks).set({ archived: true }).where(eq(tasks.id, review.taskId));
          else if (scenario === "direction") await db.update(tasks).set({ directionEpoch: (await row(review.taskId)).directionEpoch + 1,
            activeTurnToken: "new-turn", activeDirectionToken: "new-direction" }).where(eq(tasks.id, review.taskId));
          else if (scenario === "external") await setTaskStage(review.taskId, "accepted");
          else {
            const plan = state.finalization!;
            await db.update(schema.regressionEvidence).set({ finalization: { ...plan, runningStep: "post-accept" } })
              .where(eq(schema.regressionEvidence.directory, review.directory));
            throw new Error("INTERRUPTED_ACCEPTED_TAIL");
          }
        }
      }
      const result = await transaction.apply(this, args);
      if (scenario === "gate" && !injected && (await review.state()).finalization?.blockedStep === "accept"
        && new Error().stack?.includes("checkpointFinalizationWorkflow")) {
        injected = true;
        await until("gate commits acceptance before the original drain releases", async () => (await row(review.taskId)).stage === "accepted");
      }
      return result;
    };
    try { await review.settle(true).catch((error) => { assert.match(String(error), /INTERRUPTED_ACCEPTED_TAIL/); }); }
    finally { db.transaction = transaction; }
    if (scenario === "gate") {
      assert(injected);
      await until("gate resumes the same review finalizer", async () => (await review.state()).finalization?.completed === true);
    }
    if (scenario === "interrupted") recover();
    await reconcileRegressionSettlements(review.ownerTaskId);
    const state = await review.state();
    assert.equal((await row(review.taskId)).stage, "accepted");
    assert.equal(readFileSync(join(repo, count), "utf8"), "1");
    assert(state.finalization?.steps.includes("accept"));
    if (["archive", "direction", "external"].includes(scenario)) {
      assert(injected);
      assert.equal(existsSync(join(repo, marker)), false);
      assert.equal(state.finalization?.superseded, true);
      await assert.rejects(withReviewAuthority(finalizationAuthority(state), async () => {}), ReviewSuperseded);
    } else {
      if (!["normal", "gate"].includes(scenario)) {
        assert.equal(existsSync(join(repo, marker)), false);
        assert.equal(state.finalization?.completed, undefined);
        assert.equal((await row(review.taskId)).acceptedTailPending, true);
        writeFileSync(join(repo, ready), "ready");
      }
      const retry = await acceptTask(review.taskId, "human");
      assert(retry.accepted, JSON.stringify(retry));
      assert.equal(readFileSync(join(repo, marker), "utf8"), "1");
      assert.equal(readFileSync(join(repo, count), "utf8"), "1");
      assert.equal((await review.state()).finalization?.completed, true);
      assert.equal((await row(review.taskId)).acceptedTailPending, false);
      await assert.rejects(withReviewAuthority(settlementAuthority(state), async () => {}), ReviewSuperseded);
      assert((await acceptTask(review.taskId, "human")).accepted);
      assert.equal(readFileSync(join(repo, marker), "utf8"), "1");
    }
    console.log(`✓ own acceptance tail ${scenario}: one durable ledger, original-direction authority, no duplicate completed station`);
  }
} finally { await teardown(); }
