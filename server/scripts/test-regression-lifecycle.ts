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
const { evidenceState, refreshRegressionEvidence } = await import("../src/regression-evidence-lifecycle.js");
const { REVIEWER_REGRESSION_CLAUSE } = await import("@ash/shared/free-workflow");

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

  // ① 清单是**诊断件**：伪造它拿不到任何东西，而下一次刷新一定把它覆盖回数据库里的真相。
  stale(evidenceDir);
  const reminder = await verifyReminderFor(taskId, 1);
  assert.match(reminder, /regression-evidence\.json.*禁止自动复用/);
  assert.ok(reminder.includes(REVIEWER_REGRESSION_CLAUSE), "续跑提醒经清单说明带上同一份审查者口径");
  refreshed(evidenceDir);
  stale(evidenceDir);
  assert.match(await reviewReminderFor({ id: "legacy", reviewOf: taskId, reviewRound: 1 }), /regression-evidence\.json/);
  refreshed(evidenceDir);
  await Promise.all(Array.from({ length: 4 }, () => refreshRegressionEvidence(taskId, evidenceDir)));
  refreshed(evidenceDir);
  rmSync(join(evidenceDir, "regression-evidence.json"));
  await refreshRegressionEvidence(taskId, evidenceDir);
  refreshed(evidenceDir);

  // ② 结论门禁**不再看清单**。原先：任务名下只要登记过一条回归，本轮就被标成「复用资格
  // 已撤销」，审查者上报 verified 必须附一份自己跑出来的 verificationBasis。那条闸的前提
  // 是「审查者本该独立重跑回归」，与 2026-10-26 的新口径（回归统一在验收时跑、审查者一条
  // 都不跑、只核对执行者登记的结果）正好相反 —— 两者同时在，执行者按新口径登记了自己新写
  // 的测试之后，审查者就永远给不出通过结论。所以撤销整体退役，结论门禁只认代次与回合身份；
  // 「通过得有真实执行依据」改由验收门禁在合并前真跑一遍验收前置命令来兜。
  await db.update(tasks).set({ workflowMode: "preset", verifyRound: 1 }).where(eq(tasks.id, taskId));
  const api = new Hono();
  mountTaskStageRoutes(api);
  let sourceTaskId = taskId;
  const stage = (verificationBasis?: unknown) => api.request(`/tasks/${taskId}/stage`, {
    method: "POST", headers: { "content-type": "application/json", "x-ash-turn-token": `turn-${sourceTaskId}`, "x-ash-source-task-id": sourceTaskId },
    body: JSON.stringify({ stage: "verified", verificationBasis }),
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
    if(!checked||checked.basis!==null) process.exit(1);
  `], { env: process.env, stdio: "pipe" });
  // verificationBasis 这条入口没有拆掉（旧回合的未投递调用要能原样重放），带了就仍按原标准核验。
  const positivePresetCaller = await inTurnCaller(taskId);
  writeFileSync(join(repo, "settings.local"), "good");
  const positivePreset = await startMonitor({ taskId, caller: positivePresetCaller, cwd: repo, command });
  assert(positivePreset.ok);
  await wait(positivePreset.monitor.id);
  await db.update(tasks).set({ verifyRound: 1, stage: "verifying" }).where(eq(tasks.id, taskId));
  const presetGeneration = (await db.select().from(schema.regressionEvidence)
    .where(eq(schema.regressionEvidence.directory, evidenceDir)))[0]!.generation;
  await refreshRegressionEvidence(taskId, evidenceDir);
  assert.equal((manifest() as ReturnType<typeof manifest> & { verification?: unknown }).verification, undefined,
    "清单不再登载「本轮需要独立依据」那套展示字段");
  const presetBasis = { kind: "independent", generation: presetGeneration, monitorIds: [positivePreset.monitor.id] };
  assert.equal((await stage(presetBasis)).status, 200, "带依据的上报仍按原标准核验后接受");
  const presetReplayAt = new Date().toISOString();
  const { out: presetOut } = detachedPathsFor(join(root, "runs", taskId), "lost-preset-positive", presetReplayAt);
  writeFileSync(presetOut, JSON.stringify({ type: "item.completed", item: {
    id: "lost-preset-positive", type: "mcp_tool_call", server: "ash", tool: "report_stage",
    arguments: { taskId, stage: "verified", verificationBasis: presetBasis }, result: null,
    error: { message: "Transport closed" }, status: "failed",
  } }) + "\n");
  assert.equal(await replayUndeliveredMcpCalls({ taskId, sessId: "lost-preset-positive", turnStart: presetReplayAt, agentType: "codex" }), 1);

  // 存量 `revoked=1`（口径切换前写下的行，改口径那天线上有 167 条）**仍然算数**：新轮次不再写
  // 它，但读取方一个都没删 —— 删了那些旧轮次就被静默放行（第 1 轮审查发现 1 实测）。要的是
  // 「一份本轮真实执行」，不是回归，拒收文案也得这么说。
  await db.update(schema.regressionEvidence).set({ revoked: true, acceptedBasis: null })
    .where(eq(schema.regressionEvidence.directory, evidenceDir));
  await db.update(tasks).set({ stage: "verifying" }).where(eq(tasks.id, taskId));
  const legacyRejected = await stage();
  assert.equal(legacyRejected.status, 409, "存量撤销行没交依据，通过结论必须被拒");
  const legacyError = (await legacyRejected.json() as { error: string }).error;
  assert.match(legacyError, /口径切换前开的旧审查轮次/);
  assert.match(legacyError, /不要为此去跑回归/, "拒收要的是一次真实执行，不是让审查者补跑回归");
  assert.equal((await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!.stage, "verifying",
    "被拒时结论一个字都没落下");
  assert.equal((await db.select().from(schema.regressionEvidence)
    .where(eq(schema.regressionEvidence.directory, evidenceDir)))[0]!.revoked, true, "拒收不会顺手把存量标记清掉");
  assert.equal((await stage(presetBasis)).status, 200, "交了本轮真实执行依据，旧轮次照常放行");
  await db.update(schema.regressionEvidence).set({ revoked: false })
    .where(eq(schema.regressionEvidence.directory, evidenceDir));

  // 结算这一步在依据之后：它会把已接受的依据再核一遍（日志仍可读 → 通过），而「清单里有执行者
  // 登记结果」本身不再是降级理由。
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
  assert.match(await freeReviewReminder(taskId), /regression-evidence\.json/);
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
  await db.insert(schema.sessions).values({ id: "lost-free-session", taskId, role: "reviewer", agentType: "codex",
    executor: "reviewer", startedAt: now });
  const { out: freeOut } = detachedPathsFor(join(root, "runs", taskId), "lost-free-session", now);
  const lostCall = (verificationBasis?: unknown) => writeFileSync(freeOut, JSON.stringify({ type: "item.completed", item: {
    id: "lost-free-conclusion", type: "mcp_tool_call", server: "ash", tool: "report_stage",
    arguments: { taskId, stage: "verified", verificationBasis }, result: null, error: { message: "Transport closed" }, status: "failed",
  } }) + "\n");

  await db.update(schema.freeReviewRuns).set({ status: "reviewing", currentRound: 2 }).where(eq(schema.freeReviewRuns.id, reviewRun.id));
  await db.insert(schema.freeReviewRounds).values({ id: "independent-round", runId: reviewRun.id, round: 2, status: "reviewing", startedAt: now });
  runs.releaseTurn(taskId);
  assert(runs.claimTurn(taskId, "reviewer", { run: reviewRun.id, round: 2 }));
  const nextDir = freeReviewEvidenceDir(taskId, reviewRun.id, 2);
  await evidenceState(taskId, nextDir, (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!);
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

  // 结算是第三层。把同一轮改回「存量撤销行 + 没交依据」再结算一次：基线语义是把通过结论
  // **降级**成 verify_failed（不是静默放行、也不是留在原地），这一层跟着预检和事务内提交
  // 一起保留，否则一个已经写进库的旧轮次只要绕过前两层就能把通过落定。
  await db.update(schema.regressionEvidence).set({ revoked: true, acceptedBasis: null, settlement: null })
    .where(eq(schema.regressionEvidence.directory, nextDir));
  await db.update(schema.freeReviewRounds).set({ status: "reviewing", conclusion: "verified", endedAt: null })
    .where(eq(schema.freeReviewRounds.id, "independent-round"));
  await db.update(schema.freeReviewRuns).set({ status: "reviewing" }).where(eq(schema.freeReviewRuns.id, reviewRun.id));
  await handleFreeWorkflowSettlement(taskId, "done", false, true, "reviewer");
  const downgraded = (await db.select().from(schema.freeReviewRounds).where(eq(schema.freeReviewRounds.id, "independent-round")))[0]!;
  assert.equal(downgraded.conclusion, "verify_failed", "存量撤销行没依据：结算把通过结论降级");
  assert.equal(downgraded.status, "failed");
  console.log("✓ regression lifecycle: diagnostic-only manifest, conclusion gate independent of it, basis compat path, replay/restart/concurrent refresh, all settlements");
} finally {
  await teardown();
}
