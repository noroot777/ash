import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { makeStep } from "@ash/shared/workflow";
import { db, inTurnCaller, makeTask, runs, schema, startMonitor, tasks } from "./monitors-fixture.js";
import { setupRegression } from "./regression-fixture.js";

const { evidenceState, refreshRegressionEvidence } = await import("../src/regression-evidence-lifecycle.js");
const { mountTaskStageRoutes } = await import("../src/task-stage.js");
const { freeReviewEvidenceDir } = await import("../src/free-review-files.js");
const { reviewRoundDir } = await import("../src/review-evidence.js");
const { handleFreeWorkflowSettlement } = await import("../src/free-workflow.js");
const { handleTaskSettlement } = await import("../src/review.js");
const { stopMonitor } = await import("../src/monitor-stop.js");

export type ReviewMode = "free" | "accepted_merge" | "preset" | "legacy";

export async function setupRegressionReviews() {
  const fixture = await setupRegression();
  const { repo, wait } = fixture;
  runs.releaseTurn(fixture.taskId);
  const api = new Hono();
  mountTaskStageRoutes(api);
  let sequence = 0;
  const open = async (mode: ReviewMode) => {
    sequence += 1;
    const round = 1;
    const taskId = await makeTask();
    const task = (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!;
    await db.update(schema.projects).set({ repoPath: repo }).where(eq(schema.projects.id, task.projectId));
    await db.update(tasks).set({ workflowMode: "free", useWorktree: false }).where(eq(tasks.id, taskId));
    assert(runs.claimTurn(taskId, "single"));
    const executorCheck = await startMonitor({ taskId, cwd: repo, caller: await inTurnCaller(taskId),
      command: "node -e \"console.log('executor check')\"", regression: true });
    assert(executorCheck.ok);
    await wait(executorCheck.monitor.id);
    runs.releaseTurn(taskId);
    const free = mode === "free" || mode === "accepted_merge";
    const runId = `review-${sequence}`, roundId = `review-round-${sequence}`, at = new Date().toISOString();
    await db.update(tasks).set({ status: "running", workflowMode: free ? "free" : "preset",
      verifyRound: mode === "preset" ? round : null, activeDirectionToken: null,
      stage: mode === "accepted_merge" ? "accepted" : free ? null : "verifying", workflowAt: "verify",
      workflow: JSON.stringify({ workspace: "shared", steps: [makeStep("run", "run"), makeStep("verify", "verify")] }),
    }).where(eq(tasks.id, taskId));
    if (free) {
      await db.insert(schema.freeReviewRuns).values({ id: runId, taskId, reviewerName: "reviewer", agentType: "codex",
        checkMode: "logic", status: "reviewing", retryLimit: 0, currentRound: round,
        targetKind: mode === "accepted_merge" ? "accepted_merge" : "workspace", createdAt: at, updatedAt: at });
      await db.insert(schema.freeReviewRounds).values({ id: roundId, runId, round, status: "reviewing", startedAt: at });
    }
    let ownerTaskId = taskId;
    if (mode === "legacy") {
      ownerTaskId = await makeTask();
      await db.update(tasks).set({ reviewOf: taskId, reviewRound: round }).where(eq(tasks.id, ownerTaskId));
    }
    runs.releaseTurn(taskId);
    assert(runs.claimTurn(ownerTaskId, free ? "reviewer" : "single", free ? { run: runId, round } : undefined));
    const directory = free ? freeReviewEvidenceDir(taskId, runId, round) : reviewRoundDir(taskId, round);
    await evidenceState(taskId, directory, (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!);
    await refreshRegressionEvidence(taskId, directory, mode === "accepted_merge");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "report.md"), "Independent current-input check passed.\n");
    const check = await startMonitor({ taskId: ownerTaskId, cwd: repo, caller: await inTurnCaller(ownerTaskId),
      command: "node -e \"require('assert').equal(require('fs').readFileSync('code.txt','utf8'),'bad')\"" });
    assert(check.ok);
    await wait(check.monitor.id);
    const monitor = (await db.select().from(schema.monitors).where(eq(schema.monitors.id, check.monitor.id)))[0]!;
    assert.equal(monitor.exitCode, 0);
    const state = () => db.select().from(schema.regressionEvidence).where(eq(schema.regressionEvidence.directory, directory)).then((rows) => rows[0]!);
    const generation = (await state()).generation;
    const stage = () => api.request(`/tasks/${taskId}/stage`, { method: "POST",
      headers: { "content-type": "application/json", "x-ash-turn-token": `turn-${ownerTaskId}`, "x-ash-source-task-id": ownerTaskId },
      body: JSON.stringify({ stage: "verified" }) });
    const conclusion = async () => free
      ? (await db.select().from(schema.freeReviewRounds).where(eq(schema.freeReviewRounds.id, roundId)))[0]!.conclusion
      : (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!.stage;
    const settle = (turnOk: boolean) => free
      ? handleFreeWorkflowSettlement(taskId, "done", false, turnOk, "reviewer")
      : handleTaskSettlement(ownerTaskId, turnOk ? "done" : "failed", false, turnOk);
    // 「这一轮的哨兵结果我不要了」。上面那条审查者哨兵一建出来就让这一轮**欠着一份结果**
    // (结局已写定、结果还排在待发送托盘里),而「名下还欠着结果就不许结算」是自由审查那一侧
    // 独立的一道保护(review-continuation 的 roundOwesResult,第 3 轮自由审查 F2)。想单独观察
    // 别的结算判据(比如「未知归属的等待挡不挡得住」)就得先把它了结,否则看到的永远是这一条。
    // 走产品自己那条放弃路径,不手改库:它对已经结束的哨兵正是「撤掉『必须先收下它』这条放行
    // 条件」,语义正好,而且幂等。preset/legacy 不受这条保护约束(它们的证据目录形状压根匹配不
    // 上轮次归属),调了也无害。
    const releaseResult = async () => { await stopMonitor(monitor.id, "这一轮不再等它的结果"); };
    return { mode, taskId, ownerTaskId, round, runId, roundId, directory, monitor, generation, stage, state, conclusion,
      settle, releaseResult };
  };
  return { ...fixture, open };
}
