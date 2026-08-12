// 第 1 轮审查修复回归（从 test-free-workflow.ts 拆出，纯行数拆分）：
// turn 锁窗口、结论证据门禁、证据路径 symlink、验收重试快照、旧状态迁移语义。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
  const { agents, freeReviewRounds, freeReviewRuns, freeWorkflowStates, projects, sessions, tasks } = await import("../src/db/schema.js");
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

  // 结论证据与身份门禁：结论必须出自活跃的 reviewer 回合（turn 的运行时身份），
  // 且必须已有非空 report.md。
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
  const evidenceDir = join(root, "runs", "free-turn-window-task", "free-review", "evidence-review", "round-1");
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(join(evidenceDir, "report.md"), "# 有报告\n\n结论有效。\n");
  const noTurn = await api.request("/tasks/free-turn-window-task/stage", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ stage: "verified" }),
  });
  assert.equal(noTurn.status, 409, "没有活跃审查回合的结论（迟到/误投）必须被拒收");
  assert.equal(claimTurn("free-turn-window-task", "single"), true);
  const wrongRole = await api.request("/tasks/free-turn-window-task/stage", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ stage: "verified" }),
  });
  assert.equal(wrongRole.status, 409, "普通实现回合里的结论调用必须被拒收");
  releaseTurn("free-turn-window-task");
  assert.equal(claimTurn("free-turn-window-task", "reviewer"), true);
  writeFileSync(join(evidenceDir, "report.md"), " \n");
  const blankReport = await api.request("/tasks/free-turn-window-task/stage", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ stage: "verified" }),
  });
  assert.equal(blankReport.status, 409, "只有空白字节的报告不算报告");
  writeFileSync(join(evidenceDir, "report.md"), "# 有报告\n\n结论有效。\n");
  const withReport = await api.request("/tasks/free-turn-window-task/stage", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ stage: "verified" }),
  });
  assert.equal(withReport.status, 200, "活跃审查回合 + 非空报告的结论应被接受");
  releaseTurn("free-turn-window-task");
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
  // 硬链接 lstat 探测不出来：同 inode 的外部文件链接进证据目录也必须被拒（nlink>1）。
  const hardParent = join(root, "runs", "free-task", "free-review", "hard-run", "round-1");
  mkdirSync(hardParent, { recursive: true });
  linkSync(join(outside, "secret.txt"), join(hardParent, "report.md"));
  assert.equal(safeFreeReviewFile("free-task", "hard-run", 1, "report.md"), null, "硬链接证据文件必须被拒绝");

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
  const firstMergeCommit = afterFirstRetry?.acceptedMergeCommit;
  rmSync(join(retryWorktree.path, "blocking.tmp"));
  // 重试前制造两种漂移：main 被无关提交推进 + 项目 checkout 切到别的分支。
  // 一次验收生命周期内 target/base/merge 都必须冻结在首次值，不能跟着世界漂。
  writeFileSync(join(repo, "unrelated.txt"), "unrelated\n");
  git(repo, "add", "unrelated.txt");
  git(repo, "commit", "-m", "unrelated advance");
  git(repo, "checkout", "-b", "release");
  const retrySecond = await acceptTask("free-retry-task");
  assert.equal(retrySecond.accepted, true, "清障后重试应完成验收");
  git(repo, "checkout", "main");
  const afterSecondRetry = (await db.select().from(tasks).where(eq(tasks.id, "free-retry-task"))).at(0);
  assert.equal(afterSecondRetry?.acceptedTargetBranch, "main", "重试不得跟着项目 checkout 换目标分支");
  assert.equal(afterSecondRetry?.acceptedBaseCommit, retryBase, "重试不得用 already_merged 的同值区间覆盖首次 base");
  assert.equal(afterSecondRetry?.acceptedMergeCommit, firstMergeCommit, "重试不得把 merge 端覆盖成含无关提交的新 tip");
  assert.notEqual(afterSecondRetry?.acceptedBaseCommit, afterSecondRetry?.acceptedMergeCommit, "合并区间不能塌缩成空区间");

  // reopen = 新验收生命周期：摘牌后再验收，快照三列必须整体换成第二版的值。
  const { reopenAcceptedStage } = await import("../src/task-stage.js");
  assert.equal((await reopenAcceptedStage("free-retry-task"))?.stage, "accepted");
  const reopenedRow = (await db.select().from(tasks).where(eq(tasks.id, "free-retry-task"))).at(0);
  assert.equal(reopenedRow?.acceptedTargetBranch, null, "reopen 应清空上一生命周期的目标锁定");
  assert.equal(reopenedRow?.acceptedBaseCommit, null, "reopen 应清空上一生命周期的合并快照");
  const secondWorktree = await prepareWorktree(repo, "free-retry-task", "main");
  writeFileSync(join(secondWorktree.path, "retry2.txt"), "second life\n");
  git(secondWorktree.path, "add", "retry2.txt");
  git(secondWorktree.path, "commit", "-m", "second life result");
  const secondBase = git(repo, "rev-parse", "main");
  assert.notEqual(secondBase, retryBase, "第二个生命周期的 base 应该已经不同");
  const secondAccept = await acceptTask("free-retry-task");
  assert.equal(secondAccept.accepted, true, "reopen 后的第二次验收应成功");
  const afterReopenAccept = (await db.select().from(tasks).where(eq(tasks.id, "free-retry-task"))).at(0);
  assert.equal(afterReopenAccept?.acceptedBaseCommit, secondBase, "新生命周期不得沿用上一版的 base");

  // 归档 = 冻结：验收后端必须拒绝归档任务。
  await db.update(tasks).set({ archived: true }).where(eq(tasks.id, "free-turn-window-task"));
  const archivedAccept = await acceptTask("free-turn-window-task");
  assert.equal(archivedAccept.accepted, false, "归档任务不得验收");
  if (!archivedAccept.accepted) assert.equal(archivedAccept.reason, "task_archived");
  await db.update(tasks).set({ archived: false }).where(eq(tasks.id, "free-turn-window-task"));

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

  // 删除 reviewer profile：手动预约取消，但 runId 续轮预约的配置冻结在 run 快照，必须保留。
  const disposable = await api.request("/reviewer-profiles", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Disposable auto", agentType: "codex", executorId: "reviewer-executor", model: null, reasoningEffort: "high" }),
  });
  const disposableReviewer = await disposable.json() as { id: string };
  await db.update(freeWorkflowStates).set({
    selectedReviewerId: disposableReviewer.id, reviewArmed: true, reviewRunId: "legacy-repairing",
    updatedAt: new Date().toISOString(),
  }).where(eq(freeWorkflowStates.taskId, "free-legacy-task"));
  const deletedAuto = await api.request(`/reviewer-profiles/${disposableReviewer.id}`, { method: "DELETE" });
  assert.equal(deletedAuto.status, 200);
  const autoAfterDelete = (await db.select().from(freeWorkflowStates)
    .where(eq(freeWorkflowStates.taskId, "free-legacy-task"))).at(0);
  assert.equal(autoAfterDelete?.reviewArmed, true, "删除 profile 不得取消自动续轮预约（配置冻结在 run 快照）");
  assert.equal(autoAfterDelete?.reviewRunId, "legacy-repairing");
  assert.equal(autoAfterDelete?.selectedReviewerId, null, "悬空的 profile 引用应被清掉");

  // 启动对账：judgment 用任务运行事实，不看 sessions——
  // 等待答复（question 挂着）的审查回合是正常状态，不得误杀；
  // 真正的孤儿（任务空闲且无等待态）才落 failed 并撤预约。
  const { reconcileFreeReviews } = await import("../src/free-workflow.js");
  const orphanAt = new Date().toISOString();
  await db.insert(freeReviewRuns).values({
    id: "orphan-reviewing", taskId: "free-legacy-task", reviewerId: null, reviewerName: "Codex logic",
    agentType: "codex", executorId: "reviewer-executor", model: "gpt-review", reasoningEffort: "high",
    checkMode: "logic", retryLimit: 1, currentRound: 1, status: "reviewing",
    createdAt: orphanAt, updatedAt: orphanAt, finishedAt: null,
  });
  await db.insert(freeReviewRounds).values({
    id: "orphan-reviewing-round-1", runId: "orphan-reviewing", round: 1, status: "reviewing",
    conclusion: null, startedAt: orphanAt, endedAt: null,
  });
  await db.update(tasks).set({ question: "请确认边界" }).where(eq(tasks.id, "free-legacy-task"));
  await reconcileFreeReviews();
  const waitingAfter = (await db.select().from(freeReviewRuns).where(eq(freeReviewRuns.id, "orphan-reviewing"))).at(0);
  assert.equal(waitingAfter?.status, "reviewing", "等待答复的审查回合不得被对账误杀");
  await db.update(tasks).set({ question: null }).where(eq(tasks.id, "free-legacy-task"));
  await reconcileFreeReviews();
  const orphanAfter = (await db.select().from(freeReviewRuns).where(eq(freeReviewRuns.id, "orphan-reviewing"))).at(0);
  assert.equal(orphanAfter?.status, "failed", "重启后无 reviewer 会话的 reviewing run 必须被收拾成 failed");
  const orphanReservation = (await db.select().from(freeWorkflowStates)
    .where(eq(freeWorkflowStates.taskId, "free-legacy-task"))).at(0);
  assert.equal(orphanReservation?.reviewArmed, false, "对账时同任务的预约应一并注销，避免反复撞失败链");

  // 意见过期后不得按旧报告修复：锚点 ≠ 当前工作区 HEAD → 409，指向「审查新改动」。
  await createTasks([{
    id: "free-stale-task", projectId: "p-git", groupId: null, parentId: null,
    title: "free stale repair", body: "test", mode: "single", status: "done",
    labels: "[]", dependsOn: "[]", resumeDependsOn: "[]", agentType: "codex",
    executorId: "reviewer-executor", model: null, reasoningEffort: null, autoTitle: false,
    duet: null, team: null, reportBack: false, scheduleId: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    useWorktree: false, worktreeBase: null, originTaskId: null, workflowMode: "free",
  }]);
  const staleAt = new Date().toISOString();
  await db.insert(freeReviewRuns).values({
    id: "stale-review", taskId: "free-stale-task", reviewerId: null, reviewerName: "Codex logic",
    agentType: "codex", executorId: "reviewer-executor", model: "gpt-review", reasoningEffort: "high",
    checkMode: "logic", retryLimit: 0, currentRound: 1, status: "stopped",
    createdAt: staleAt, updatedAt: staleAt, finishedAt: staleAt,
  });
  await db.insert(freeReviewRounds).values({
    id: "stale-review-round-1", runId: "stale-review", round: 1, status: "failed",
    conclusion: "verify_failed", reviewedCommit: "0000000000000000000000000000000000000000",
    startedAt: staleAt, endedAt: staleAt,
  });
  const staleDir = join(root, "runs", "free-stale-task", "free-review", "stale-review", "round-1");
  mkdirSync(staleDir, { recursive: true });
  writeFileSync(join(staleDir, "report.md"), "# 意见\n\n针对旧代码。\n");
  const staleRepair = await api.request("/tasks/free-stale-task/free-workflow/review/repair", { method: "POST" });
  assert.equal(staleRepair.status, 409, "结论过期（锚点≠HEAD）时不得按旧意见发起修复");

  // 派审必须先处理遗留的提问/续跑指令，否则新审查链会被旧字段永远卡在 reviewing。
  await db.update(tasks).set({ question: "实现回合遗留的问题" }).where(eq(tasks.id, "free-stale-task"));
  const dispatchWithQuestion = await api.request("/tasks/free-stale-task/free-workflow/review", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ reviewerId: reviewer.id, checkMode: "logic", retryLimit: 1 }),
  });
  assert.equal(dispatchWithQuestion.status, 409, "任务挂着遗留提问时不得派审");
  // reviewer 已交卷（round 有结论）时，遗留 question 不能挡住结算。
  const { handleFreeWorkflowSettlement } = await import("../src/free-workflow.js");
  const strayAt = new Date().toISOString();
  await db.insert(freeReviewRuns).values({
    id: "stray-question-review", taskId: "free-stale-task", reviewerId: reviewer.id, reviewerName: "Codex logic",
    agentType: "codex", executorId: "reviewer-executor", model: "gpt-review", reasoningEffort: "high",
    checkMode: "logic", retryLimit: 0, currentRound: 1, status: "reviewing",
    createdAt: strayAt, updatedAt: strayAt, finishedAt: null,
  });
  await db.insert(freeReviewRounds).values({
    id: "stray-question-round-1", runId: "stray-question-review", round: 1, status: "reviewing",
    conclusion: "verified", startedAt: strayAt, endedAt: null,
  });
  await handleFreeWorkflowSettlement("free-stale-task", "done", false, true, "reviewer");
  const strayAfter = (await db.select().from(freeReviewRuns)
    .where(eq(freeReviewRuns.id, "stray-question-review"))).at(0);
  assert.equal(strayAfter?.status, "passed", "已交卷的审查不得被遗留 question 卡在 reviewing");
  await db.update(tasks).set({ question: null }).where(eq(tasks.id, "free-stale-task"));

  // squash 清理失败后的重试：目标已含内容，再次 squash 的空提交必须判为 already_merged
  // （问 git 暂存区，不猜错误文本），否则任务永远越不过 merge 阶段。
  const { mergeTaskBranch } = await import("../src/git-accept.js");
  const squashWt = await prepareWorktree(repo, "free-squash-retry", "main");
  writeFileSync(join(squashWt.path, "squash.txt"), "squash\n");
  git(squashWt.path, "add", "squash.txt");
  git(squashWt.path, "commit", "-m", "squash content");
  const firstSquash = await mergeTaskBranch(repo, "free-squash-retry", "main", "squash");
  assert.equal(firstSquash.ok && firstSquash.method, "squash", "首次 squash 合并应成功");
  const retrySquash = await mergeTaskBranch(repo, "free-squash-retry", "main", "squash");
  assert.equal(retrySquash.ok && retrySquash.method, "already_merged",
    "重复 squash（暂存区为空）应判 already_merged，而不是卡死在 merge_failed");

  // Git 已合并、DB 没落快照的崩溃窗口：重试拿到 already_merged 时 base 必须记「不可知」
  // （null），不得伪造 before==after 的空区间。
  await createTasks([{
    id: "free-crash-task", projectId: "p-git", groupId: null, parentId: null,
    title: "free crash window", body: "test", mode: "single", status: "done",
    labels: "[]", dependsOn: "[]", resumeDependsOn: "[]", agentType: "codex",
    executorId: "reviewer-executor", model: null, reasoningEffort: null, autoTitle: false,
    duet: null, team: null, reportBack: false, scheduleId: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    useWorktree: true, worktreeBase: "main", originTaskId: null, workflowMode: "free",
  }]);
  const crashWt = await prepareWorktree(repo, "free-crash-task", "main");
  writeFileSync(join(crashWt.path, "crash.txt"), "crash window\n");
  git(crashWt.path, "add", "crash.txt");
  git(crashWt.path, "commit", "-m", "crash window content");
  // 模拟崩溃窗口：Git 合并真实发生（ref 已动），但 stage/快照都没写。
  const crashMerge = await mergeTaskBranch(repo, "free-crash-task", "main", "safe");
  assert.equal(crashMerge.ok, true);
  const crashAccept = await acceptTask("free-crash-task");
  assert.equal(crashAccept.accepted, true, "崩溃窗口后的重试验收应完成");
  const crashRow = (await db.select().from(tasks).where(eq(tasks.id, "free-crash-task"))).at(0);
  assert.equal(crashRow?.acceptedBaseCommit, null, "合并发生在记录缺失的窗口时 base 必须记不可知，不得伪造空区间");
  assert.equal(crashRow?.acceptedMergeCommit, git(repo, "rev-parse", "main"));

  // 快路的可达性校验：已记录的 merge commit 从目标分支不可达时不得盖 accepted。
  await createTasks([{
    id: "free-unreachable-task", projectId: "p-git", groupId: null, parentId: null,
    title: "free unreachable", body: "test", mode: "single", status: "done",
    labels: "[]", dependsOn: "[]", resumeDependsOn: "[]", agentType: "codex",
    executorId: "reviewer-executor", model: null, reasoningEffort: null, autoTitle: false,
    duet: null, team: null, reportBack: false, scheduleId: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    useWorktree: true, worktreeBase: "main", originTaskId: null, workflowMode: "free",
  }]);
  await db.update(tasks).set({
    stage: "merged", acceptedTargetBranch: "main",
    acceptedBaseCommit: git(repo, "rev-parse", "main"),
    acceptedMergeCommit: "0000000000000000000000000000000000000000",
  }).where(eq(tasks.id, "free-unreachable-task"));
  const unreachableAccept = await acceptTask("free-unreachable-task");
  assert.equal(unreachableAccept.accepted, false, "目标分支不再包含已记录的合并结果时不得盖 accepted");

  // 排队消息要持久化回合身份：审查者提问期间排队的答复必须以 reviewer 身份送回。
  const { enqueueMessage } = await import("../src/pending-messages.js");
  const { scheduledMessages } = await import("../src/db/schema.js");
  const queued = await enqueueMessage({
    taskId: "free-stale-task", text: "【答复】继续", sessionRole: "reviewer",
  });
  const queuedRow = (await db.select().from(scheduledMessages)
    .where(eq(scheduledMessages.id, queued.id))).at(0);
  assert.equal(queuedRow?.sessionRole, "reviewer", "排队消息必须把 sessionRole 落库，投递时才能恢复身份");

  // stateVersion 是修订号：task.review 事件驱动递增，同一毫秒内两份快照也分得出先后。
  const { freeWorkflowState } = await import("../src/free-workflow-state.js");
  const { bus } = await import("../src/bus.js");
  const beforeBump = (await freeWorkflowState("free-stale-task")).stateVersion;
  bus.publish({ type: "task.review", taskId: "free-stale-task" });
  const afterBump = (await freeWorkflowState("free-stale-task")).stateVersion;
  assert.equal(afterBump > beforeBump, true, "状态变更后修订号必须严格递增（不能依赖 wall-clock）");

  // ── 第 6 轮审查修复回归：摘牌 write-ahead + 双锁互斥 + 解析失败不破坏验收事实 ──
  const { continueTask } = await import("../src/orchestrator.js");
  const { beginAccepting, endAccepting } = await import("../src/acceptance-lock.js");
  await createTasks([{
    id: "free-reopen-guard", projectId: "p", groupId: null, parentId: null,
    title: "reopen guard", body: "test", mode: "single", status: "done",
    labels: "[]", dependsOn: "[]", resumeDependsOn: "[]", agentType: "codex",
    executorId: "reviewer-executor", model: null, reasoningEffort: null, autoTitle: false,
    duet: null, team: null, reportBack: false, scheduleId: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    useWorktree: false, worktreeBase: null, originTaskId: null, workflowMode: "free",
  }]);
  const seedAccepted = () => db.update(tasks).set({
    stage: "accepted", acceptedTargetBranch: "main", acceptedBaseCommit: "b1",
    acceptedMergeCommit: "m1", acceptedTailPending: true,
  }).where(eq(tasks.id, "free-reopen-guard"));
  const acceptedRow = async () => (await db.select({
    status: tasks.status, stage: tasks.stage, target: tasks.acceptedTargetBranch,
    base: tasks.acceptedBaseCommit, merge: tasks.acceptedMergeCommit, pending: tasks.acceptedTailPending,
  }).from(tasks).where(eq(tasks.id, "free-reopen-guard"))).at(0);

  // ① turn 被其它回合占用：消息按「未投递」排队，验收事实必须原封不动（摘牌已挪到
  //    claim 成功之后）。
  await seedAccepted();
  assert.equal(claimTurn("free-reopen-guard"), true);
  assert.equal(await continueTask("free-reopen-guard", "改一下"), false, "回合被占时消息按未投递排队");
  let guardRow = await acceptedRow();
  assert.equal(guardRow?.stage, "accepted", "claim 失败的消息不得摘牌");
  assert.equal(guardRow?.pending, true, "claim 失败的消息不得清尾段补跑凭据");
  assert.equal(guardRow?.target, "main", "claim 失败的消息不得清合并快照");
  releaseTurn("free-reopen-guard");

  // ② 验收锁 TOCTOU：验收已开始（beginAccepting 已占）时投递必须退避——continueTask
  //    先占 turn 再查验收锁（两步无 await），与 acceptTask「beginAccepting 后查
  //    isTurnClaimed」互为镜像，任意交错至少一方退避。
  assert.equal(beginAccepting("free-reopen-guard"), true);
  assert.equal(await continueTask("free-reopen-guard", "插一句"), false, "验收进行中消息必须退避");
  guardRow = await acceptedRow();
  assert.equal(guardRow?.stage, "accepted", "验收互斥退避不得摘牌");
  assert.equal(guardRow?.pending, true);
  endAccepting("free-reopen-guard");
  assert.equal(claimTurn("free-reopen-guard"), true, "退避不得泄漏 turn 锁");
  releaseTurn("free-reopen-guard");

  // ③ 执行器前置解析失败（非法思考强度档位）：摘牌在解析之后，catch 恢复 status 的
  //    同时验收事实原封——不再出现「status 恢复了、stage/快照回不来」（审查探针）。
  const parseFailDelivered = await continueTask("free-reopen-guard", "再改点", {
    agent: "codex", reasoningEffort: "ultra-fake",
  });
  assert.equal(parseFailDelivered, true, "解析失败由本次调用接管（catch 落状态）");
  guardRow = await acceptedRow();
  assert.equal(guardRow?.status, "done", "续聊失败回落原终态");
  assert.equal(guardRow?.stage, "accepted", "解析失败不得破坏验收牌子");
  assert.equal(guardRow?.target, "main", "解析失败不得清合并快照");
  assert.equal(guardRow?.pending, true, "解析失败不得清尾段补跑凭据");

  // ── 第 6 轮审查修复回归：DELETE 连带 children 的探测与行同步 ──
  await createTasks([{
    id: "team-del-lead", projectId: "p-git", groupId: null, parentId: null,
    title: "team lead", body: "test", mode: "team", status: "done",
    labels: "[]", dependsOn: "[]", resumeDependsOn: "[]", agentType: "codex",
    executorId: "reviewer-executor", model: null, reasoningEffort: null, autoTitle: false,
    duet: null, team: null, reportBack: false, scheduleId: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    useWorktree: false, worktreeBase: null, originTaskId: null, workflowMode: "preset",
  }, {
    id: "team-del-child", projectId: "p-git", groupId: null, parentId: "team-del-lead",
    title: "isolated child", body: "test", mode: "single", status: "done",
    labels: "[]", dependsOn: "[]", resumeDependsOn: "[]", agentType: "codex",
    executorId: "reviewer-executor", model: null, reasoningEffort: null, autoTitle: false,
    duet: null, team: null, reportBack: false, scheduleId: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    useWorktree: true, worktreeBase: null, originTaskId: null, workflowMode: "preset",
  }]);
  const childWorktree = await prepareWorktree(repo, "team-del-child", "main");
  writeFileSync(join(childWorktree.path, "dirty.txt"), "uncommitted\n");
  // 父任务双 null 也必须把 child 的残留探出来——否则确认框不带清理参数，删完成孤儿。
  const probe = await api.request("/tasks/team-del-lead/workspace").then((r) => r.json()) as {
    path: string | null; branch: string | null;
    children?: Array<{ taskId: string; path: string | null; branch: string | null }>;
  };
  assert.equal(probe.path, null, "lead 自己没有 worktree");
  assert.equal(probe.children?.length, 1, "workspace 探测必须带出 children 的 Git 残留");
  assert.equal(probe.children?.[0]?.taskId, "team-del-child");
  assert.ok(probe.children?.[0]?.path, "child worktree 路径要露出来");
  const delRes = await api.request("/tasks/team-del-lead?worktree=1&branch=1", { method: "DELETE" });
  assert.equal(delRes.status, 200);
  const delBody = await delRes.json() as {
    deletedTaskIds?: string[];
    childLeftovers?: Array<{ taskId: string; leftover: { path: string | null; branch: string | null } }>;
  };
  assert.deepEqual(delBody.deletedTaskIds?.sort(), ["team-del-child", "team-del-lead"],
    "DELETE 必须报出连删的全部行，前端按它同步本地集合");
  assert.equal(delBody.childLeftovers?.[0]?.taskId, "team-del-child",
    "child 脏 worktree 普通清理被拒时必须如实报残留");
  assert.ok(existsSync(childWorktree.path), "普通清理不得强删脏 worktree");

  console.log("✓ turn 锁窗口拦验收与派审；结论必须携报告且出自活跃审查回合；symlink/硬链接被拒；验收快照按生命周期冻结且崩溃窗口不伪造区间；快路验证合并结果可达；归档只读；旧状态迁移保语义；重启对账收拾孤儿审查；过期意见与遗留提问受控；squash 重试可越过；排队消息保身份；stateVersion 为修订号；摘牌 write-ahead（claim 失败/验收互斥/解析失败三路不破坏验收事实）；DELETE 连带 children 探测与行同步");
} finally {
  rmSync(root, { recursive: true, force: true });
}
