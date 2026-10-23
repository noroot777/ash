import assert from "node:assert/strict";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { makeStep } from "@ash/shared/workflow";
import { db, inTurnCaller, makeTask, root, runs, schema, startMonitor, tasks, teardown } from "./monitors-fixture.js";
import { setupRegression } from "./regression-fixture.js";

const { regressionEvidenceReference } = await import("../src/regression-checks.js");
const { verifyReminderFor, reviewReminderFor } = await import("../src/review-prompts.js");
const { freeReviewPrompt } = await import("../src/free-review-prompts.js");
const { freeReviewReminder, handleFreeWorkflowSettlement, reconcileFreeReviews, reportFreeReviewConclusion } = await import("../src/free-workflow.js");
const { freeReviewEvidenceDir } = await import("../src/free-review-files.js");
const { mountTaskStageRoutes } = await import("../src/task-stage.js");
const { handleTaskSettlement } = await import("../src/review.js");
const { replayUndeliveredMcpCalls } = await import("../src/mcp-handoff.js");
const { detachedPathsFor } = await import("../src/executors/detached.js");
const { refreshRegressionEvidence } = await import("../src/regression-evidence-lifecycle.js");

try {
  const { taskId, task, repo, evidenceDir, manifest, run, wait } = await setupRegression();
  writeFileSync(join(repo, "settings.local"), "good");
  const command = "node -e \"process.exit(require('fs').readFileSync('settings.local','utf8')==='good'?0:1)\"";
  await run(command);
  await regressionEvidenceReference(task, repo, evidenceDir);
  const oldManifest = { ...manifest(), protocol: 1, records: manifest().records.map((record) => ({ ...record, reusable: true })) };
  const stale = (directory: string) => {
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "regression-evidence.json"), JSON.stringify(oldManifest));
  };
  const refreshed = (directory: string) => {
    assert.equal(manifest(directory).protocol, 2);
    assert.equal(manifest(directory).records.length, 1);
    assert.equal(manifest(directory).records[0]!.reusable, false);
  };

  writeFileSync(join(repo, "code.txt"), "changed after prompt");
  writeFileSync(join(repo, "settings.local"), "bad");
  assert.throws(() => execFileSync(process.execPath, ["-e", "process.exit(require('fs').readFileSync('settings.local','utf8')==='good'?0:1)"],
    { cwd: repo }), (error: unknown) => (error as { status: number }).status === 1, "旧通过所对应的当前忽略配置实际失败");
  stale(evidenceDir);
  assert.match(await verifyReminderFor(taskId, 1), /regression-evidence\.json.*禁止自动复用/);
  refreshed(evidenceDir);
  stale(evidenceDir);
  assert.match(await reviewReminderFor({ id: "legacy", reviewOf: taskId, reviewRound: 1 }), /regression-evidence\.json/);
  refreshed(evidenceDir);

  await db.update(tasks).set({ workflowMode: "preset", verifyRound: 1 }).where(eq(tasks.id, taskId));
  const api = new Hono();
  mountTaskStageRoutes(api);
  const stage = (verificationBasis?: unknown) => api.request(`/tasks/${taskId}/stage`, {
    method: "POST", headers: { "content-type": "application/json", "x-ash-turn-token": `turn-${taskId}` },
    body: JSON.stringify({ stage: "verified", verificationBasis }),
  });
  stale(evidenceDir);
  const refused = await stage();
  assert.equal(refused.status, 409);
  assert.match((await refused.json() as { error: string }).error, /旧回归复用资格已撤销/);
  assert.notEqual((await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!.stage, "verified");
  await refreshRegressionEvidence(taskId, evidenceDir);
  refreshed(evidenceDir);
  assert.equal((await stage()).status, 409, "刷新展示清单不是新验证依据，直接重试仍被拒绝");
  await Promise.all(Array.from({ length: 4 }, () => refreshRegressionEvidence(taskId, evidenceDir)));
  rmSync(join(evidenceDir, "regression-evidence.json"));
  assert.equal((await stage()).status, 409, "删除清单不能解除持久撤销");
  writeFileSync(join(evidenceDir, "regression-evidence.json"), '{"protocol":2,"records":[]}');
  assert.equal((await stage()).status, 409, "重写清单不能解除持久撤销");
  const lifecycleUrl = new URL("../src/regression-evidence-lifecycle.ts", import.meta.url).href;
  execFileSync(process.execPath, ["--import", "tsx/esm", "--input-type=module", "-e", `
    const {checkPresetRegressionConclusion}=await import(${JSON.stringify(lifecycleUrl)});
    try { await checkPresetRegressionConclusion(${JSON.stringify(taskId)},"verified"); process.exit(1); }
    catch(error) { if(!error.message.includes("旧回归复用资格已撤销")) throw error; }
  `], { env: process.env, stdio: "pipe" });

  const positivePresetCaller = await inTurnCaller(taskId);
  writeFileSync(join(repo, "settings.local"), "good");
  const positivePreset = await startMonitor({ taskId, caller: positivePresetCaller, cwd: repo,
    command });
  assert(positivePreset.ok);
  await wait(positivePreset.monitor.id);
  const presetGeneration = (await db.select().from(schema.regressionEvidence)
    .where(eq(schema.regressionEvidence.directory, evidenceDir)))[0]!.generation;
  await refreshRegressionEvidence(taskId, evidenceDir);
  const presentation = manifest() as ReturnType<typeof manifest> & { verification: { generation: string; independentRequired: boolean } };
  assert.equal(presentation.verification.generation, presetGeneration, "缩略续跑重读清单也能找到本轮依据代次");
  assert.equal(presentation.verification.independentRequired, true);
  const presetBasis = { kind: "independent", generation: presetGeneration, monitorIds: [positivePreset.monitor.id] };
  assert.equal((await stage(presetBasis)).status, 200, "真实的新独立执行可以恢复上报");
  const presetReplayAt = new Date().toISOString();
  const { out: presetOut } = detachedPathsFor(join(root, "runs", taskId), "lost-preset-positive", presetReplayAt);
  writeFileSync(presetOut, JSON.stringify({ type: "item.completed", item: {
    id: "lost-preset-positive", type: "mcp_tool_call", server: "ash", tool: "report_stage",
    arguments: { taskId, stage: "verified", verificationBasis: presetBasis }, result: null,
    error: { message: "Transport closed" }, status: "failed",
  } }) + "\n");
  assert.equal(await replayUndeliveredMcpCalls({ taskId, sessId: "lost-preset-positive", turnStart: presetReplayAt, agentType: "codex" }), 1);
  assert.equal((await stage()).status, 409, "新依据获准不能给旧的无依据请求补签");

  const legacyId = await makeTask();
  await db.update(tasks).set({ reviewOf: taskId, reviewRound: 2 }).where(eq(tasks.id, legacyId));
  await db.update(tasks).set({ verifyRound: null, stage: "verifying" }).where(eq(tasks.id, taskId));
  const legacyDir = join(evidenceDir, "..", "round-2");
  stale(legacyDir);
  assert.equal((await stage()).status, 409, "历史独立审查的结论入口同样重新核验");
  const turnStart = new Date().toISOString();
  const { out } = detachedPathsFor(join(evidenceDir, "..", ".."), "proof-session", turnStart);
  writeFileSync(out, JSON.stringify({ type: "item.completed", item: {
    id: "lost-conclusion", type: "mcp_tool_call", server: "ash", tool: "report_stage",
    arguments: { taskId, stage: "verified" }, result: null, error: { message: "Transport closed" }, status: "failed",
  } }) + "\n");
  stale(legacyDir);
  assert.equal(await replayUndeliveredMcpCalls({ taskId, sessId: "proof-session", turnStart, agentType: "codex" }), 0,
    "MCP 补捞不能绕过结论消费的输入核验");
  await refreshRegressionEvidence(taskId, legacyDir);
  refreshed(legacyDir);
  assert.equal(await replayUndeliveredMcpCalls({ taskId, sessId: "proof-session", turnStart, agentType: "codex" }), 0,
    "第一次拒收后自动补录同一请求仍然拒收");

  await db.update(tasks).set({ verifyRound: 3, stage: "verified", workflowAt: "verify",
    workflow: JSON.stringify({ workspace: "shared", steps: [makeStep("run", "run"), makeStep("verify", "verify")] }),
  }).where(eq(tasks.id, taskId));
  const unsettledDir = join(evidenceDir, "..", "round-3");
  assert.equal((await stage()).status, 409, "首次接入的旧轮次即使缺清单，也不能放行不明依据");
  stale(unsettledDir);
  await handleTaskSettlement(taskId, "done", false, true);
  assert.equal((await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!.stage, "verify_failed",
    "在结论上报与实际结算之间出现旧授权，也不能用它推进验证通过");

  await db.update(tasks).set({ workflowMode: "free", workflow: null, workflowAt: null, verifyRound: null, stage: null }).where(eq(tasks.id, taskId));
  const now = new Date().toISOString();
  await db.insert(schema.freeReviewRuns).values({
    id: "proof-review", taskId, reviewerName: "reviewer", agentType: "codex", checkMode: "logic",
    status: "reviewing", retryLimit: 0, currentRound: 1, createdAt: now, updatedAt: now,
  });
  await db.insert(schema.freeReviewRounds).values({ id: "proof-round", runId: "proof-review", round: 1, status: "reviewing", startedAt: now });
  const reviewRun = (await db.select().from(schema.freeReviewRuns).where(eq(schema.freeReviewRuns.id, "proof-review")))[0]!;
  const freeDir = freeReviewEvidenceDir(taskId, reviewRun.id, 1);
  await freeReviewPrompt(task, reviewRun, 1, repo);
  stale(freeDir);
  assert.match(await freeReviewReminder(taskId), /regression-evidence\.json/);
  refreshed(freeDir);
  writeFileSync(join(freeDir, "report.md"), "输入证明及验证结果已检查。\n");
  runs.releaseTurn(taskId);
  assert.equal(runs.claimTurn(taskId, "reviewer", { run: reviewRun.id, round: 1 }), true);
  stale(freeDir);
  await assert.rejects(reportFreeReviewConclusion(taskId, "verified"), /旧回归复用资格已撤销/);
  await refreshRegressionEvidence(taskId, freeDir);
  refreshed(freeDir);
  await assert.rejects(reportFreeReviewConclusion(taskId, "verified"), /旧回归复用资格已撤销/);
  await db.insert(schema.sessions).values({ id: "lost-free-session", taskId, role: "reviewer", agentType: "codex",
    executor: "reviewer", startedAt: now });
  const { out: freeOut } = detachedPathsFor(join(root, "runs", taskId), "lost-free-session", now);
  const lostCall = (verificationBasis?: unknown) => writeFileSync(freeOut, JSON.stringify({ type: "item.completed", item: {
    id: "lost-free-conclusion", type: "mcp_tool_call", server: "ash", tool: "report_stage",
    arguments: { taskId, stage: "verified", verificationBasis }, result: null, error: { message: "Transport closed" }, status: "failed",
  } }) + "\n");
  lostCall();
  assert.equal(await replayUndeliveredMcpCalls({ taskId, sessId: "lost-free-session", turnStart: now, agentType: "codex" }), 0);
  await db.update(schema.freeReviewRounds).set({ conclusion: "verified" }).where(eq(schema.freeReviewRounds.id, "proof-round"));
  await handleFreeWorkflowSettlement(taskId, "done", false, true, "reviewer");
  const settled = (await db.select().from(schema.freeReviewRounds).where(eq(schema.freeReviewRounds.id, "proof-round")))[0]!;
  assert.equal(settled.conclusion, "verify_failed");
  assert.equal(settled.status, "failed", "自由审查消费结论时再次撤销旧授权");

  await db.update(schema.freeReviewRuns).set({ status: "reviewing", currentRound: 2 }).where(eq(schema.freeReviewRuns.id, reviewRun.id));
  await db.insert(schema.freeReviewRounds).values({ id: "independent-round", runId: reviewRun.id, round: 2, status: "reviewing", startedAt: now });
  runs.releaseTurn(taskId);
  assert(runs.claimTurn(taskId, "reviewer", { run: reviewRun.id, round: 2 }));
  const nextDir = freeReviewEvidenceDir(taskId, reviewRun.id, 2);
  await refreshRegressionEvidence(taskId, nextDir);
  mkdirSync(nextDir, { recursive: true });
  writeFileSync(join(nextDir, "report.md"), "真实独立验证已通过，不依赖旧回归。\n");
  const nextGeneration = (await db.select().from(schema.regressionEvidence)
    .where(eq(schema.regressionEvidence.directory, nextDir)))[0]!.generation;
  const caller = await inTurnCaller(taskId);
  const check = await startMonitor({ taskId, caller, cwd: repo, command: "node -e \"console.log('independent free passed')\"" });
  assert(check.ok);
  await wait(check.monitor.id);
  const basis = { kind: "independent", generation: nextGeneration, monitorIds: [check.monitor.id] };
  assert.equal((await stage({ ...basis, generation: presetGeneration })).status, 409, "另一轮代次不能借用");
  assert.equal((await stage({ ...basis, monitorIds: [positivePreset.monitor.id] })).status, 409, "前轮检查不能冒充新执行");
  assert.equal((await stage(basis)).status, 200);
  lostCall(basis);
  assert.equal(await replayUndeliveredMcpCalls({ taskId, sessId: "lost-free-session", turnStart: now, agentType: "codex" }), 1,
    "补录携带真实新依据的请求仍可恢复");
  assert.equal((await stage()).status, 409);
  const checkedMonitor = (await db.select().from(schema.monitors).where(eq(schema.monitors.id, check.monitor.id)))[0]!;
  chmodSync(checkedMonitor.logPath, 0o000);
  try {
    const temporarilyUnavailable = await stage(basis);
    assert.equal(temporarilyUnavailable.status, 503, "真实独立依据暂不可读是可恢复的基础设施错误");
    assert.match((await temporarilyUnavailable.json() as { error: string }).error, /EACCES/);
    await handleFreeWorkflowSettlement(taskId, "done", false, true, "reviewer");
    const waiting = (await db.select().from(schema.freeReviewRounds).where(eq(schema.freeReviewRounds.id, "independent-round")))[0]!;
    assert.equal(waiting.status, "reviewing");
    assert.equal(waiting.conclusion, "verified", "证据暂不可读不能虚构测试失败");
  } finally { chmodSync(checkedMonitor.logPath, 0o600); }
  assert.equal((await stage(basis)).status, 200, "恢复可读后原真实依据可重试，不强迫重复测试");
  stale(nextDir);
  runs.releaseTurn(taskId);
  await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, taskId));
  await reconcileFreeReviews();
  const independent = (await db.select().from(schema.freeReviewRounds).where(eq(schema.freeReviewRounds.id, "independent-round")))[0]!;
  assert.equal(independent.status, "passed", "持久化的独立依据不依赖旧清单，结算可通过");
  assert.equal(independent.conclusion, "verified");
  console.log("✓ regression lifecycle: durable revocation, retry/replay/restart/concurrent refresh, independent execution recovery, all settlements");
} finally {
  await teardown();
}
