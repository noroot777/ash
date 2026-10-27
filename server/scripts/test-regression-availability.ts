import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { makeStep } from "@ash/shared/workflow";
import { db, inTurnCaller, makeTask, runs, schema, startMonitor, tasks, teardown } from "./monitors-fixture.js";
import { setupRegression } from "./regression-fixture.js";

const { evidenceState, refreshRegressionEvidence } = await import("../src/regression-evidence-lifecycle.js");
const { mountTaskStageRoutes } = await import("../src/task-stage.js");
const { handleFreeWorkflowSettlement } = await import("../src/free-workflow.js");
const { handleTaskSettlement } = await import("../src/review.js");
const { freeReviewEvidenceDir } = await import("../src/free-review-files.js");

let restricted: string | null = null;
try {
  const { taskId, repo, evidenceDir, wait } = await setupRegression();
  const api = new Hono();
  mountTaskStageRoutes(api);
  const stage = (verificationBasis?: unknown) => api.request(`/tasks/${taskId}/stage`, {
    method: "POST", headers: { "content-type": "application/json", "x-ash-turn-token": `turn-${taskId}` },
    body: JSON.stringify({ stage: "verified", verificationBasis }),
  });
  const independentlyVerify = () => execFileSync(process.execPath, ["-e",
    "require('assert').equal(require('fs').readFileSync('code.txt','utf8'),'bad')"], { cwd: repo });
  for (const targetKind of ["workspace", "accepted_merge"] as const) {
    const runId = `independent-${targetKind}`;
    const roundId = `round-${targetKind}`;
    const at = new Date().toISOString();
    await db.insert(schema.freeReviewRuns).values({ id: runId, taskId, reviewerName: "reviewer", agentType: "codex",
      checkMode: "logic", status: "reviewing", retryLimit: 0, currentRound: 1, targetKind, createdAt: at, updatedAt: at });
    await db.insert(schema.freeReviewRounds).values({ id: roundId, runId, round: 1, status: "reviewing", startedAt: at });
    runs.releaseTurn(taskId);
    assert(runs.claimTurn(taskId, "reviewer", { run: runId, round: 1 }));
    const directory = freeReviewEvidenceDir(taskId, runId, 1);
    await evidenceState(taskId, directory, (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!);
    mkdirSync(directory, { recursive: true });
    const initial = await refreshRegressionEvidence(taskId, directory, targetKind === "accepted_merge");
    assert.match(initial.reference, /回归测试统一在验收时|合并结果审查没有执行者登记清单可核对/, "清单说明带新口径");
    independentlyVerify();
    writeFileSync(join(directory, "report.md"), "独立检查当前内容通过，无任何历史回归引用。\n");
    assert.equal((await stage()).status, 200);
    chmodSync(directory, 0o500);
    restricted = directory;
    assert.throws(() => writeFileSync(join(directory, "write-probe"), "blocked"),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "EACCES", "真实文件系统权限失败，而非伪造异常");
    const refresh = await refreshRegressionEvidence(taskId, directory, targetKind === "accepted_merge");
    const state = (await db.select().from(schema.regressionEvidence).where(eq(schema.regressionEvidence.directory, directory)))[0]!;
    if (targetKind === "workspace") {
      assert.match(refresh.reference, /EACCES/);
      assert.match(state.unavailable!, /EACCES/);
    } else {
      assert.match(refresh.reference, /合并结果审查没有执行者登记清单可核对/);
      assert.equal(existsSync(join(directory, "regression-evidence.json")), false, "合并结果无需写空诊断清单");
    }
    assert.equal((await stage()).status, 200, "真实独立验证不被诊断清单写入故障拒绝");
    await handleFreeWorkflowSettlement(taskId, "done", false, true, "reviewer");
    const settled = (await db.select().from(schema.freeReviewRounds).where(eq(schema.freeReviewRounds.id, roundId)))[0]!;
    assert.equal(settled.conclusion, "verified");
    assert.equal(settled.status, "passed");
    chmodSync(directory, 0o700);
    restricted = null;
  }

  runs.releaseTurn(taskId);
  assert(runs.claimTurn(taskId, "single"));
  await db.update(tasks).set({ workflowMode: "preset", verifyRound: 1, stage: "verifying", workflowAt: "verify",
    workflow: JSON.stringify({ workspace: "shared", steps: [makeStep("run", "run"), makeStep("verify", "verify")] }),
  }).where(eq(tasks.id, taskId));
  await evidenceState(taskId, evidenceDir, (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!);
  await refreshRegressionEvidence(taskId, evidenceDir);
  independentlyVerify();
  writeFileSync(join(evidenceDir, "report.md"), "独立验证通过。\n");
  chmodSync(evidenceDir, 0o500);
  restricted = evidenceDir;
  assert.equal((await stage()).status, 200, "就地验证上报没有刷新写入依赖");
  await db.update(tasks).set({ verifyRound: null }).where(eq(tasks.id, taskId));
  const legacy = await makeTask();
  await db.update(tasks).set({ reviewOf: taskId, reviewRound: 1 }).where(eq(tasks.id, legacy));
  assert.equal((await stage()).status, 200, "历史独立验证同样不因目录只读拒收");
  chmodSync(evidenceDir, 0o700);
  restricted = null;
  await db.update(tasks).set({ verifyRound: 1 }).where(eq(tasks.id, taskId));
  const check = await startMonitor({ taskId, cwd: repo, caller: await inTurnCaller(taskId),
    command: "node -e \"require('assert').equal(require('fs').readFileSync('code.txt','utf8'),'bad')\"" });
  assert(check.ok);
  await wait(check.monitor.id);
  const generation = (await db.select().from(schema.regressionEvidence)
    .where(eq(schema.regressionEvidence.directory, evidenceDir)))[0]!.generation;
  assert.equal((await stage({ kind: "independent", generation, monitorIds: [check.monitor.id] })).status, 200);
  const monitor = (await db.select().from(schema.monitors).where(eq(schema.monitors.id, check.monitor.id)))[0]!;
  chmodSync(monitor.logPath, 0o000);
  try {
    await handleTaskSettlement(taskId, "done", false, true);
    const waiting = (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!;
    assert.equal(waiting.stage, "verified");
    assert.equal(waiting.verifyRound, 1, "依据暂不可读时不能先清掉轮次，恢复后仍可消费原依据");
  } finally { chmodSync(monitor.logPath, 0o600); }
  await handleTaskSettlement(taskId, "done", false, true);
  assert.equal((await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!.stage, "verified");
  console.log("✓ regression availability: real EACCES, independent workspace/accepted-merge results, preset/legacy reports, no false failure");
} finally {
  if (restricted) chmodSync(restricted, 0o700);
  await teardown();
}
