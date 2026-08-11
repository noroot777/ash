// 第 1 轮审查修复回归（从 test-free-workflow.ts 拆出，纯行数拆分）：
// turn 锁窗口、结论证据门禁、证据路径 symlink、验收重试快照、旧状态迁移语义。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";

const root = mkdtempSync(join(tmpdir(), "harness-free-hardening-"));
process.env.HARNESS_DB = join(root, "harness.db");
process.env.HARNESS_RUNS_DIR = join(root, "runs");

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

try {
  const { ensureSchema, db } = await import("../src/db/index.js");
  const { agents, freeReviewRounds, freeReviewRuns, freeWorkflowStates, projects, tasks } = await import("../src/db/schema.js");
  const { createTasks } = await import("../src/task-store.js");
  const { mountFreeWorkflowRoutes } = await import("../src/free-workflow.js");
  const { claimTurn, releaseTurn } = await import("../src/runs.js");
  const { prepareWorktree } = await import("../src/git.js");
  const { mountReviewerProfileRoutes } = await import("../src/reviewer-profiles.js");
  const { mountTaskRoutes } = await import("../src/task-routes.js");
  const { mountTaskStageRoutes } = await import("../src/task-stage.js");
  const { acceptTask } = await import("../src/task-accept.js");
  await ensureSchema();

  await db.insert(projects).values({ id: "p", name: "test", repoPath: root, apiKeys: null, workflowId: null, createdAt: new Date().toISOString() });
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Harness Test");
  writeFileSync(join(repo, "base.txt"), "base\n");
  git(repo, "add", "base.txt");
  git(repo, "commit", "-m", "base");
  await db.insert(projects).values({ id: "p-git", name: "git test", repoPath: repo, apiKeys: null, workflowId: null, createdAt: new Date().toISOString() });
  await db.insert(agents).values({
    id: "reviewer-executor", name: "codex@test", type: "codex", target: '{"kind":"local"}',
    model: "gpt-test", extraArgs: "[]", reasoningEffort: "high", speed: null, providerId: null, isDefault: true,
  });

  const api = new Hono();
  mountReviewerProfileRoutes(api);
  mountFreeWorkflowRoutes(api);
  mountTaskStageRoutes(api);
  mountTaskRoutes(api);
  const created = await api.request("/reviewer-profiles", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Codex logic", agentType: "codex", executorId: "reviewer-executor", model: null, reasoningEffort: "high" }),
  });
  assert.equal(created.status, 201);
  const reviewer = await created.json() as { id: string };

  // symlink 段用的 free-task（只要 runs 目录名字存在即可，不需要真任务行以外的东西）
  await createTasks([{
    id: "free-task", projectId: "p", groupId: null, parentId: null,
    title: "free", body: "test", mode: "single", status: "done",
    labels: "[]", dependsOn: "[]", resumeDependsOn: "[]", agentType: "codex",
    executorId: "reviewer-executor", model: null, reasoningEffort: null, autoTitle: false,
    duet: null, team: null, reportBack: false, scheduleId: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    useWorktree: false, worktreeBase: null, originTaskId: null, workflowMode: "free",
  }]);

  // ── 第 1 轮审查修复回归 ──
  
  // turn 锁窗口：claimTurn 之后、status 落 running 之前，验收与派审都必须被拦。
  await createTasks([{
    id: "free-turn-window-task", projectId: "p", groupId: null, parentId: null,
    title: "free turn window", body: "test", mode: "single", status: "done",
    labels: "[]", dependsOn: "[]", resumeDependsOn: "[]", agentType: "codex",
    executorId: "reviewer-executor", model: null, reasoningEffort: null, autoTitle: false,
    duet: null, team: null, reportBack: false, scheduleId: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    useWorktree: false, worktreeBase: null, originTaskId: null, workflowMode: "free",
  }]);
  assert.equal(claimTurn("free-turn-window-task"), true);
  const turnBlockedAccept = await acceptTask("free-turn-window-task");
  assert.equal(turnBlockedAccept.accepted, false, "回合已被占（status 未落 running）时不得验收");
  if (!turnBlockedAccept.accepted) assert.equal(turnBlockedAccept.reason, "task_in_flight");
  const turnBlockedDispatch = await api.request("/tasks/free-turn-window-task/free-workflow/review", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ reviewerId: reviewer.id, checkMode: "logic", retryLimit: 1 }),
  });
  assert.equal(turnBlockedDispatch.status, 409, "回合已被占时不得派审");
  releaseTurn("free-turn-window-task");
  
  // 结论证据门禁：没有非空 report.md 的 verified/verify_failed 一律拒收。
  const evidenceAt = new Date().toISOString();
  await db.insert(freeReviewRuns).values({
    id: "evidence-review", taskId: "free-turn-window-task", reviewerId: reviewer.id, reviewerName: "Codex logic",
    agentType: "codex", executorId: "reviewer-executor", model: "gpt-review", reasoningEffort: "high",
    checkMode: "logic", retryLimit: 1, currentRound: 1, status: "reviewing",
    createdAt: evidenceAt, updatedAt: evidenceAt, finishedAt: null,
  });
  await db.insert(freeReviewRounds).values({
    id: "evidence-review-round-1", runId: "evidence-review", round: 1, status: "reviewing",
    conclusion: null, startedAt: evidenceAt, endedAt: null,
  });
  const noReport = await api.request("/tasks/free-turn-window-task/stage", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ stage: "verified" }),
  });
  assert.equal(noReport.status, 409, "没有报告的审查结论必须被拒收");
  const evidenceDir = join(root, "runs", "free-turn-window-task", "free-review", "evidence-review", "round-1");
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(join(evidenceDir, "report.md"), "# 有报告\n\n结论有效。\n");
  const withReport = await api.request("/tasks/free-turn-window-task/stage", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ stage: "verified" }),
  });
  assert.equal(withReport.status, 200, "报告就位后同一结论应被接受");
  const evidenceRound = (await db.select().from(freeReviewRounds)
    .where(eq(freeReviewRounds.id, "evidence-review-round-1"))).at(0);
  assert.equal(evidenceRound?.conclusion, "verified");
  await db.update(freeReviewRuns).set({ status: "passed", finishedAt: new Date().toISOString() })
    .where(eq(freeReviewRuns.id, "evidence-review"));
  
  // 证据路径安全：round 目录被换成 symlink 指到证据根之外时必须整体拒绝。
  const { freeReviewFile: safeFreeReviewFile } = await import("../src/free-review-files.js");
  const outside = join(root, "outside-evidence");
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "secret.txt"), "TOP-SECRET\n");
  const evilParent = join(root, "runs", "free-task", "free-review", "evil-run");
  mkdirSync(evilParent, { recursive: true });
  symlinkSync(outside, join(evilParent, "round-1"));
  assert.equal(safeFreeReviewFile("free-task", "evil-run", 1, "secret.txt"), null, "symlink 祖先必须被拒绝");
  const evilFetch = await api.request("/tasks/free-task/free-workflow/review-file?run=evil-run&round=1&name=secret.txt");
  assert.equal(evilFetch.status, 404, "review-file 接口不得跟随 symlink 祖先读到证据根之外");
  
  // 部分成功重试：首次合并的 base 不能被 already_merged 的同值区间覆盖。
  await createTasks([{
    id: "free-retry-task", projectId: "p-git", groupId: null, parentId: null,
    title: "free retry accept", body: "test", mode: "single", status: "done",
    labels: "[]", dependsOn: "[]", resumeDependsOn: "[]", agentType: "codex",
    executorId: "reviewer-executor", model: null, reasoningEffort: null, autoTitle: false,
    duet: null, team: null, reportBack: false, scheduleId: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    useWorktree: true, worktreeBase: "main", originTaskId: null, workflowMode: "free",
  }]);
  const retryWorktree = await prepareWorktree(repo, "free-retry-task", "main");
  writeFileSync(join(retryWorktree.path, "retry.txt"), "retry\n");
  git(retryWorktree.path, "add", "retry.txt");
  git(retryWorktree.path, "commit", "-m", "retry result");
  const retryBase = git(repo, "rev-parse", "main");
  writeFileSync(join(retryWorktree.path, "blocking.tmp"), "dirty\n");
  const retryFirst = await acceptTask("free-retry-task");
  assert.equal(retryFirst.accepted, false, "脏 worktree 应让首次验收停在清理阶段");
  const afterFirstRetry = (await db.select().from(tasks).where(eq(tasks.id, "free-retry-task"))).at(0);
  assert.equal(afterFirstRetry?.stage, "merged", "合并成功但清理失败应停在 merged");
  assert.equal(afterFirstRetry?.acceptedBaseCommit, retryBase, "首次合并应记录真实 base");
  rmSync(join(retryWorktree.path, "blocking.tmp"));
  const retrySecond = await acceptTask("free-retry-task");
  assert.equal(retrySecond.accepted, true, "清障后重试应完成验收");
  const afterSecondRetry = (await db.select().from(tasks).where(eq(tasks.id, "free-retry-task"))).at(0);
  assert.equal(afterSecondRetry?.acceptedBaseCommit, retryBase, "重试不得用 already_merged 的同值区间覆盖首次 base");
  assert.notEqual(afterSecondRetry?.acceptedBaseCommit, afterSecondRetry?.acceptedMergeCommit, "合并区间不能塌缩成空区间");
  
  // 迁移语义：repairing 回填自动续轮预约；superseded 打上「已过期」哨兵锚点；
  // 已验收自由任务的遗留预约被注销。
  await createTasks([{
    id: "free-legacy-task", projectId: "p", groupId: null, parentId: null,
    title: "free legacy", body: "test", mode: "single", status: "done",
    labels: "[]", dependsOn: "[]", resumeDependsOn: "[]", agentType: "codex",
    executorId: "reviewer-executor", model: null, reasoningEffort: null, autoTitle: false,
    duet: null, team: null, reportBack: false, scheduleId: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    useWorktree: false, worktreeBase: null, originTaskId: null, workflowMode: "free",
  }, {
    id: "free-legacy-superseded", projectId: "p", groupId: null, parentId: null,
    title: "free legacy superseded", body: "test", mode: "single", status: "done",
    labels: "[]", dependsOn: "[]", resumeDependsOn: "[]", agentType: "codex",
    executorId: "reviewer-executor", model: null, reasoningEffort: null, autoTitle: false,
    duet: null, team: null, reportBack: false, scheduleId: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    useWorktree: false, worktreeBase: null, originTaskId: null, workflowMode: "free",
  }]);
  const legacyAt = new Date().toISOString();
  await db.insert(freeReviewRuns).values([{
    id: "legacy-repairing", taskId: "free-legacy-task", reviewerId: reviewer.id, reviewerName: "Codex logic",
    agentType: "codex", executorId: "reviewer-executor", model: "gpt-review", reasoningEffort: "high",
    checkMode: "logic", retryLimit: 2, currentRound: 1, status: "repairing",
    createdAt: legacyAt, updatedAt: legacyAt, finishedAt: null,
  }, {
    id: "legacy-superseded", taskId: "free-legacy-superseded", reviewerId: reviewer.id, reviewerName: "Codex logic",
    agentType: "codex", executorId: "reviewer-executor", model: "gpt-review", reasoningEffort: "high",
    checkMode: "logic", retryLimit: 1, currentRound: 1, status: "superseded",
    createdAt: legacyAt, updatedAt: legacyAt, finishedAt: legacyAt,
  }]);
  await db.insert(freeReviewRounds).values([{
    id: "legacy-repairing-round-1", runId: "legacy-repairing", round: 1, status: "failed",
    conclusion: "verify_failed", startedAt: legacyAt, endedAt: legacyAt,
  }, {
    id: "legacy-superseded-round-1", runId: "legacy-superseded", round: 1, status: "failed",
    conclusion: "verify_failed", startedAt: legacyAt, endedAt: legacyAt,
  }]);
  await db.update(tasks).set({ stage: "accepted" }).where(eq(tasks.id, "free-legacy-superseded"));
  await db.insert(freeWorkflowStates).values({
    taskId: "free-legacy-superseded", selectedReviewerId: reviewer.id, reviewArmed: true,
    reviewCheckMode: "logic", reviewRetryLimit: 1, updatedAt: legacyAt,
  }).onConflictDoUpdate({
    target: freeWorkflowStates.taskId,
    set: { reviewArmed: true, updatedAt: legacyAt },
  });
  await ensureSchema();
  const migratedRepairing = (await db.select().from(freeReviewRuns).where(eq(freeReviewRuns.id, "legacy-repairing"))).at(0);
  assert.equal(migratedRepairing?.status, "stopped", "旧 repairing 应收敛为 stopped");
  const migratedReservation = (await db.select().from(freeWorkflowStates)
    .where(eq(freeWorkflowStates.taskId, "free-legacy-task"))).at(0);
  assert.equal(migratedReservation?.reviewArmed, true, "旧 repairing 的自动续轮语义必须回填为预约");
  assert.equal(migratedReservation?.reviewRunId, "legacy-repairing", "续轮预约必须指回原 run");
  const migratedSuperseded = (await db.select().from(freeReviewRuns).where(eq(freeReviewRuns.id, "legacy-superseded"))).at(0);
  assert.equal(migratedSuperseded?.status, "stopped");
  const migratedSupersededRound = (await db.select().from(freeReviewRounds)
    .where(eq(freeReviewRounds.id, "legacy-superseded-round-1"))).at(0);
  assert.equal(migratedSupersededRound?.reviewedCommit, "legacy-superseded",
    "旧 superseded 应打上哨兵锚点，让新鲜度推导识别为已过期而不是当前待办");
  const acceptedLegacyReservation = (await db.select().from(freeWorkflowStates)
    .where(eq(freeWorkflowStates.taskId, "free-legacy-superseded"))).at(0);
  assert.equal(acceptedLegacyReservation?.reviewArmed, false, "已验收自由任务的遗留预约必须被迁移注销");

  console.log("✓ turn 锁窗口拦验收与派审；结论必须携报告；symlink 祖先被拒；重试不覆盖合并快照；旧状态迁移保语义");
} finally {
  rmSync(root, { recursive: true, force: true });
}
