import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { makeStep } from "@ash/shared/workflow";
import { db, inTurnCaller, makeTask, runs, schema, tasks, teardown } from "./monitors-fixture.js";
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
const { evidenceState, refreshRegressionEvidence } = await import("../src/regression-evidence-lifecycle.js");
const { REVIEWER_REGRESSION_CLAUSE } = await import("@ash/shared/free-workflow");

try {
  const { taskId, task, repo, evidenceDir, manifest, run } = await setupRegression();
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

  // ① 清单是**诊断件**：伪造它拿不到任何东西，而下一次刷新一定把它覆盖回数据库里的真相。
  stale(evidenceDir);
  const reminder = (await verifyReminderFor(taskId, 1)).text;
  assert.match(reminder, /regression-evidence\.json.*reusable 恒为 false/);
  assert.ok(reminder.includes(REVIEWER_REGRESSION_CLAUSE), "续跑提醒经清单说明带上同一份审查者口径");
  refreshed(evidenceDir);
  stale(evidenceDir);
  assert.match((await reviewReminderFor({ id: "legacy", reviewOf: taskId, reviewRound: 1 })).text, /regression-evidence\.json/);
  refreshed(evidenceDir);
  await Promise.all(Array.from({ length: 4 }, () => refreshRegressionEvidence(taskId, evidenceDir)));
  refreshed(evidenceDir);
  rmSync(join(evidenceDir, "regression-evidence.json"));
  await refreshRegressionEvidence(taskId, evidenceDir);
  refreshed(evidenceDir);

  // ② 结论门禁**不再看清单**，只认代次与回合身份；「通过得有真实执行依据」由验收门禁在合并前
  // 真跑一遍验收前置命令来兜（用户 2026-10-26 改回归口径）。
  await db.update(tasks).set({ workflowMode: "preset", verifyRound: 1 }).where(eq(tasks.id, taskId));
  const api = new Hono();
  mountTaskStageRoutes(api);
  let sourceTaskId = taskId;
  const stage = () => api.request(`/tasks/${taskId}/stage`, {
    method: "POST", headers: { "content-type": "application/json", "x-ash-turn-token": `turn-${sourceTaskId}`, "x-ash-source-task-id": sourceTaskId },
    body: JSON.stringify({ stage: "verified" }),
  });
  stale(evidenceDir);
  assert.equal((await stage()).status, 200, "撤销机制已退役：登记过回归不再要求审查者补一份独立依据");
  assert.equal((await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!.stage, "verified");
  rmSync(join(evidenceDir, "regression-evidence.json"));
  assert.equal((await stage()).status, 200, "清单不在场也不影响结论门禁");
  writeFileSync(join(evidenceDir, "regression-evidence.json"), '{"protocol":2,"records":[]}');
  assert.equal((await stage()).status, 200);
  const lifecycleUrl = new URL("../src/regression-evidence-lifecycle.ts", import.meta.url).href;
  execFileSync(process.execPath, ["--import", "tsx/esm", "--input-type=module", "-e", `
    const {checkPresetRegressionConclusion}=await import(${JSON.stringify(lifecycleUrl)});
    const checked=await checkPresetRegressionConclusion(${JSON.stringify(taskId)},"verified");
    if(!checked) process.exit(1);
  `], { env: process.env, stdio: "pipe" });
  await db.update(tasks).set({ verifyRound: 1, stage: "verifying" }).where(eq(tasks.id, taskId));
  await refreshRegressionEvidence(taskId, evidenceDir);
  assert.equal((manifest() as ReturnType<typeof manifest> & { verification?: unknown }).verification, undefined,
    "清单不再登载「本轮需要独立依据」那套展示字段");
  assert.equal((await stage()).status, 200);

  // 结算：「清单里有执行者登记结果」本身不是降级理由。
  stale(evidenceDir);
  await handleTaskSettlement(taskId, "done", false, true);
  assert.equal((await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!.stage, "verified",
    "结算不再因为「清单里有执行者结果」把通过结论降级");

  // ③ 历史独立审查这条来源同样只认归属与回合身份，不再被清单内容拦住。
  const legacyId = await makeTask();
  await db.update(tasks).set({ reviewOf: taskId, reviewRound: 2 }).where(eq(tasks.id, legacyId));
  runs.releaseTurn(taskId);
  assert(runs.claimTurn(legacyId, "single"));
  await inTurnCaller(legacyId);
  sourceTaskId = legacyId;
  await db.update(tasks).set({ verifyRound: null, stage: "verifying" }).where(eq(tasks.id, taskId));
  const legacyDir = join(evidenceDir, "..", "round-2");
  stale(legacyDir);
  assert.equal((await stage()).status, 200, "历史独立审查的结论入口同样不再要求独立依据");
  const turnStart = new Date().toISOString();
  await db.insert(schema.sessions).values({ id: "legacy-proof-session", taskId: legacyId, role: "single", agentType: "codex",
    executor: "test", startedAt: turnStart });
  const { out } = detachedPathsFor(join(evidenceDir, "..", ".."), "legacy-proof-session", turnStart);
  writeFileSync(out, JSON.stringify({ type: "item.completed", item: {
    id: "lost-conclusion", type: "mcp_tool_call", server: "ash", tool: "report_stage",
    arguments: { taskId, stage: "verified" }, result: null, error: { message: "Transport closed" }, status: "failed",
  } }) + "\n");
  stale(legacyDir);
  assert.equal(await replayUndeliveredMcpCalls({ taskId, sessId: "legacy-proof-session", turnStart, agentType: "codex" }), 1,
    "不带依据的未投递结论可以原样补录（它本来就不需要依据）");
  await refreshRegressionEvidence(taskId, legacyDir);
  refreshed(legacyDir);

  runs.releaseTurn(legacyId);
  assert(runs.claimTurn(taskId, "single"));
  sourceTaskId = taskId;
  await db.update(tasks).set({ verifyRound: 3, stage: "verifying", workflowAt: "verify",
    workflow: JSON.stringify({ workspace: "shared", steps: [makeStep("run", "run"), makeStep("verify", "verify")] }),
  }).where(eq(tasks.id, taskId));
  const unsettledDir = join(evidenceDir, "..", "round-3");
  await evidenceState(taskId, unsettledDir, (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!);
  assert.equal((await stage()).status, 200, "首次接入的旧轮次缺清单也照常放行");
  stale(unsettledDir);
  await handleTaskSettlement(taskId, "done", false, true);
  assert.equal((await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!.stage, "verified");

  // ④ 自由审查这条线同样：伪造清单不改变结论，结算照常通过。
  await db.update(tasks).set({ workflowMode: "free", workflow: null, workflowAt: null, verifyRound: null, stage: null }).where(eq(tasks.id, taskId));
  const now = new Date().toISOString();
  await db.insert(schema.freeReviewRuns).values({
    id: "proof-review", taskId, reviewerName: "reviewer", agentType: "codex", checkMode: "logic",
    status: "reviewing", retryLimit: 0, currentRound: 1, createdAt: now, updatedAt: now,
  });
  await db.insert(schema.freeReviewRounds).values({ id: "proof-round", runId: "proof-review", round: 1, status: "reviewing", startedAt: now });
  const reviewRun = (await db.select().from(schema.freeReviewRuns).where(eq(schema.freeReviewRuns.id, "proof-review")))[0]!;
  const freeDir = freeReviewEvidenceDir(taskId, reviewRun.id, 1);
  await evidenceState(taskId, freeDir, (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!);
  await freeReviewPrompt(task, reviewRun, 1, repo);
  stale(freeDir);
  assert.match((await freeReviewReminder(taskId)).text, /regression-evidence\.json/);
  refreshed(freeDir);
  writeFileSync(join(freeDir, "report.md"), "输入证明及验证结果已检查。\n");
  runs.releaseTurn(taskId);
  assert.equal(runs.claimTurn(taskId, "reviewer", { run: reviewRun.id, round: 1 }), true);
  stale(freeDir);
  assert.ok(await reportFreeReviewConclusion(taskId, "verified"), "自由审查的通过结论不再被清单内容拒收");
  await handleFreeWorkflowSettlement(taskId, "done", false, true, "reviewer");
  const settled = (await db.select().from(schema.freeReviewRounds).where(eq(schema.freeReviewRounds.id, "proof-round")))[0]!;
  assert.equal(settled.conclusion, "verified");
  assert.equal(settled.status, "passed", "自由审查结算不再撤销通过结论");
  console.log("✓ regression lifecycle: diagnostic-only manifest, conclusion gate independent of it, replay/restart/concurrent refresh, all settlements");
} finally {
  await teardown();
}
