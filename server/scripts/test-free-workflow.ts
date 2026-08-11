import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";

const root = mkdtempSync(join(tmpdir(), "harness-free-workflow-"));
process.env.HARNESS_DB = join(root, "harness.db");
process.env.HARNESS_RUNS_DIR = join(root, "runs");

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

try {
  const { ensureSchema, db } = await import("../src/db/index.js");
  const { agents, freeReviewRounds, freeReviewRuns, projects, sessions, tasks } = await import("../src/db/schema.js");
  const { createTasks } = await import("../src/task-store.js");
  const {
    mountFreeWorkflowRoutes,
    freeReviewOutcome,
    freeReviewPrompt,
    freeRepairPrompt,
    freeReviewResumeOptions,
    handleFreeWorkflowSettlement,
  } = await import("../src/free-workflow.js");
  const { releaseFreeWorkflowAction, tryAcquireFreeWorkflowAction } = await import("../src/free-workflow-lock.js");
  const {
    finishFreeTaskExecution,
    recordFreePreviewEvent,
    recordFreeTaskExecutionStartIfFree,
  } = await import("../src/free-workflow-events.js");
  const { claimTurn } = await import("../src/runs.js");
  const { prepareWorktree } = await import("../src/git.js");
  const { mountReviewerProfileRoutes } = await import("../src/reviewer-profiles.js");
  const { mountTaskRoutes } = await import("../src/task-routes.js");
  const { mountTaskStageRoutes } = await import("../src/task-stage.js");
  const { acceptTask } = await import("../src/task-accept.js");
  const { sessionTranscriptPath } = await import("../src/transcript.js");
  const { ACCEPTANCE_REMINDER } = await import("../src/orchestrator.js");
  await ensureSchema();

  const freeAcceptanceReminder = ACCEPTANCE_REMINDER("free-task", false, false, true);
  assert.match(freeAcceptanceReminder, /任务完成后由用户从统一验收页验收/, "自由任务完成协议应指向统一验收页");
  assert.doesNotMatch(freeAcceptanceReminder, /合并.?清理/, "自由任务完成协议不得再指向已删除的合并快捷操作");

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

  const [task] = await createTasks([{
    id: "free-task", projectId: "p", groupId: null, parentId: null,
    title: "free", body: "test", mode: "single", status: "backlog", priority: "none",
    labels: "[]", dependsOn: "[]", resumeDependsOn: "[]", agentType: "codex",
    executorId: "reviewer-executor", model: null, reasoningEffort: null, autoTitle: false,
    duet: null, team: null, reportBack: false, scheduleId: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    useWorktree: false, worktreeBase: null, originTaskId: null, workflowMode: "free",
  }]);
  assert.equal(task?.workflowMode, "free");
  assert.equal(task?.workflow, null, "自由任务不能被 createTasks 偷偷补上默认起手式");

  const directiveAt = "2026-08-09T07:23:33.985Z";
  await db.insert(sessions).values({
    id: "skill-directive-session", taskId: "free-task", role: "lead", agentType: "codex",
    executor: "codex@test", target: '{"kind":"local"}', startedAt: directiveAt,
  });
  const directivePath = sessionTranscriptPath("free-task", "skill-directive-session");
  mkdirSync(dirname(directivePath), { recursive: true });
  writeFileSync(directivePath, `\x1e${JSON.stringify({
    t: "user", agent: "codex", text: "把排队需求也一起做完\n/grill-me", at: directiveAt,
  })}\n`);
  const promptTask = (await db.select().from(tasks).where(eq(tasks.id, "free-task"))).at(0)!;
  const promptRun: Parameters<typeof freeReviewPrompt>[1] = {
    id: "skill-review", taskId: "free-task", reviewerId: "reviewer", reviewerName: "Codex logic",
    agentType: "codex", executorId: "reviewer-executor", model: null, reasoningEffort: "high",
    checkMode: "logic", retryLimit: 1, currentRound: 1, status: "reviewing",
    createdAt: directiveAt, updatedAt: directiveAt, finishedAt: null,
  };
  const skillPrompt = await freeReviewPrompt({
    ...promptTask,
    title: "标题也可能点名 /grill-me",
    body: "原始正文要求运行 /grill-me",
  }, promptRun, 1, root);
  assert.doesNotMatch(skillPrompt, /grill-me|把排队需求也一起做完/, "自由审查 prompt 不得原样夹带技能名或用户追问");
  assert.match(skillPrompt, /request-context\.md/, "自由审查应改为引用需求文件");
  const skillContext = readFileSync(join(root, "runs", "free-task", "free-review", "skill-review", "round-1", "request-context.md"), "utf8");
  assert.match(skillContext, /标题也可能点名 \/grill-me/);
  assert.match(skillContext, /原始正文要求运行 \/grill-me/);
  assert.match(skillContext, /把排队需求也一起做完[\s\S]*\/grill-me/, "需求文件仍须完整保留后续追问");
  const repair = freeRepairPrompt("free-task", promptRun, ["shot.png"]);
  assert.match(repair, /\[report\.md\]\([^\n]+report\.md\)/, "修复交接应引用唯一的 report.md");
  assert.match(repair, /\[shot\.png\]\([^\n]+shot\.png\)/, "截图证据应以路径交接");
  assert.doesNotMatch(repair, /审查报告：\n#/, "修复交接不得复制报告正文");

  await createTasks([{
    id: "free-accept-task", projectId: "p", groupId: null, parentId: null,
    title: "free accept", body: "test", mode: "single", status: "done", priority: "none",
    labels: "[]", dependsOn: "[]", resumeDependsOn: "[]", agentType: "codex",
    executorId: "reviewer-executor", model: null, reasoningEffort: null, autoTitle: false,
    duet: null, team: null, reportBack: false, scheduleId: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    useWorktree: false, worktreeBase: null, originTaskId: null, workflowMode: "free",
  }]);

  const [worktreeTask] = await createTasks([{
    id: "free-worktree-task", projectId: "p-git", groupId: null, parentId: null,
    title: "free worktree accept", body: "test", mode: "single", status: "done", priority: "none",
    labels: "[]", dependsOn: "[]", resumeDependsOn: "[]", agentType: "codex",
    executorId: "reviewer-executor", model: null, reasoningEffort: null, autoTitle: false,
    duet: null, team: null, reportBack: false, scheduleId: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    useWorktree: true, worktreeBase: "main", originTaskId: null, workflowMode: "free",
  }]);
  assert.equal(worktreeTask?.useWorktree, true);
  const worktree = await prepareWorktree(repo, "free-worktree-task", "main");
  writeFileSync(join(worktree.path, "accepted.txt"), "accepted\n");
  git(worktree.path, "add", "accepted.txt");
  git(worktree.path, "commit", "-m", "free worktree result");
  const mainBeforeAcceptance = git(repo, "rev-parse", "main");

  await createTasks([{
    id: "free-reservation-task", projectId: "p", groupId: null, parentId: null,
    title: "free reservation", body: "test", mode: "single", status: "running", priority: "none",
    labels: "[]", dependsOn: "[]", resumeDependsOn: "[]", agentType: "codex",
    executorId: "reviewer-executor", model: null, reasoningEffort: null, autoTitle: false,
    duet: null, team: null, reportBack: false, scheduleId: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    useWorktree: false, worktreeBase: null, originTaskId: null, workflowMode: "free",
  }]);

  assert.equal(freeReviewOutcome({ turnOk: true, conclusion: "verify_failed", currentRound: 1, retryLimit: 1 }), "repair");
  assert.equal(freeReviewOutcome({ turnOk: true, conclusion: "verify_failed", currentRound: 2, retryLimit: 1 }), "exhausted");
  assert.equal(freeReviewOutcome({ turnOk: true, conclusion: "verified", currentRound: 1, retryLimit: 1 }), "passed");
  assert.equal(freeReviewOutcome({ turnOk: false, conclusion: "verified", currentRound: 1, retryLimit: 1 }), "failed");

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
  assert.ok(reviewer.id);

  const reserveReview = async (checkMode: "logic" | "syntax", retryLimit: number) => api.request(
    "/tasks/free-reservation-task/free-workflow/review-reservation",
    { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ reviewerId: reviewer.id, checkMode, retryLimit }) },
  );
  let reserved = await reserveReview("logic", 1);
  assert.equal(reserved.status, 200);
  let reservedState = await reserved.json() as { reviewReservation: { armed: boolean; checkMode: string | null; retryLimit: number | null } };
  assert.deepEqual(reservedState.reviewReservation, { armed: true, reviewerId: reviewer.id, checkMode: "logic", retryLimit: 1 });

  reserved = await reserveReview("syntax", 2);
  assert.equal(reserved.status, 200);
  reservedState = await reserved.json() as typeof reservedState;
  assert.deepEqual(reservedState.reviewReservation, { armed: true, reviewerId: reviewer.id, checkMode: "syntax", retryLimit: 2 }, "重复预约应覆盖同一份配置");

  const canceledReservation = await api.request("/tasks/free-reservation-task/free-workflow/review-reservation", { method: "DELETE" });
  assert.equal(canceledReservation.status, 200);
  assert.equal((await canceledReservation.json() as { reviewReservation: { armed: boolean } }).reviewReservation.armed, false);

  await reserveReview("logic", 2);
  await db.update(tasks).set({ status: "failed" }).where(eq(tasks.id, "free-reservation-task"));
  await handleFreeWorkflowSettlement("free-reservation-task", "failed", false, false);
  assert.equal((await api.request("/tasks/free-reservation-task/free-workflow").then((response) => response.json()) as { reviewReservation: { armed: boolean } }).reviewReservation.armed, true, "失败结算应保留预约");

  await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, "free-reservation-task"));
  assert.equal(claimTurn("free-reservation-task"), true);
  await handleFreeWorkflowSettlement("free-reservation-task", "done", true, true);
  const triggered = await api.request("/tasks/free-reservation-task/free-workflow");
  const triggeredState = await triggered.json() as { reviewReservation: { armed: boolean }; reviews: Array<{ status: string; checkMode: string; retryLimit: number }> };
  assert.equal(triggeredState.reviewReservation.armed, false);
  assert.deepEqual(triggeredState.reviews.map(({ status, checkMode, retryLimit }) => ({ status, checkMode, retryLimit })), [
    { status: "reviewing", checkMode: "logic", retryLimit: 2 },
  ], "confirmed done 应按预约配置自动派出且只派一份审查");

  // 删除审查者时必须同步 disarm：否则 UI 仍显示已预约，结算因 reviewerId 为空静默不派审。
  await createTasks([{
    id: "free-deleted-reviewer-task", projectId: "p", groupId: null, parentId: null,
    title: "free deleted reviewer", body: "test", mode: "single", status: "running", priority: "none",
    labels: "[]", dependsOn: "[]", resumeDependsOn: "[]", agentType: "codex",
    executorId: "reviewer-executor", model: null, reasoningEffort: null, autoTitle: false,
    duet: null, team: null, reportBack: false, scheduleId: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    useWorktree: false, worktreeBase: null, originTaskId: null, workflowMode: "free",
  }]);
  const disposableReviewerRes = await api.request("/reviewer-profiles", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Disposable", agentType: "codex", executorId: "reviewer-executor", model: null, reasoningEffort: "high" }),
  });
  assert.equal(disposableReviewerRes.status, 201);
  const disposableReviewer = await disposableReviewerRes.json() as { id: string };
  const reservedDisposable = await api.request(
    "/tasks/free-deleted-reviewer-task/free-workflow/review-reservation",
    { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ reviewerId: disposableReviewer.id, checkMode: "logic", retryLimit: 1 }) },
  );
  assert.equal(reservedDisposable.status, 200);
  assert.equal((await reservedDisposable.json() as { reviewReservation: { armed: boolean } }).reviewReservation.armed, true);

  const deletedReviewer = await api.request(`/reviewer-profiles/${disposableReviewer.id}`, { method: "DELETE" });
  assert.equal(deletedReviewer.status, 200);
  const afterDeleteState = await api.request("/tasks/free-deleted-reviewer-task/free-workflow").then((response) => response.json()) as {
    reviewReservation: { armed: boolean; reviewerId: string | null };
  };
  assert.deepEqual(afterDeleteState.reviewReservation, { armed: false, reviewerId: null, checkMode: null, retryLimit: null },
    "删除审查者后预约必须取消，不能留下 armed 且 reviewerId 为空");

  await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, "free-deleted-reviewer-task"));
  assert.equal(claimTurn("free-deleted-reviewer-task"), true);
  await handleFreeWorkflowSettlement("free-deleted-reviewer-task", "done", true, true);
  const afterDeleteSettle = await api.request("/tasks/free-deleted-reviewer-task/free-workflow").then((response) => response.json()) as {
    reviewReservation: { armed: boolean }; reviews: unknown[];
  };
  assert.equal(afterDeleteSettle.reviewReservation.armed, false);
  assert.deepEqual(afterDeleteSettle.reviews, [], "审查者已删除时 confirmed done 不得静默保留空预约，也不应派出审查");

  // 结算守底：历史脏数据 armed=true 且 reviewerId=null 时必须 disarm 并留痕，不能静默跳过。
  await createTasks([{
    id: "free-orphan-arm-task", projectId: "p", groupId: null, parentId: null,
    title: "free orphan arm", body: "test", mode: "single", status: "done", priority: "none",
    labels: "[]", dependsOn: "[]", resumeDependsOn: "[]", agentType: "codex",
    executorId: "reviewer-executor", model: null, reasoningEffort: null, autoTitle: false,
    duet: null, team: null, reportBack: false, scheduleId: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    useWorktree: false, worktreeBase: null, originTaskId: null, workflowMode: "free",
  }]);
  const { freeWorkflowStates } = await import("../src/db/schema.js");
  await db.insert(freeWorkflowStates).values({
    taskId: "free-orphan-arm-task", selectedReviewerId: null, reviewArmed: true,
    reviewCheckMode: "logic", reviewRetryLimit: 1,
    updatedAt: new Date().toISOString(),
  });
  assert.equal(
    (await api.request("/tasks/free-orphan-arm-task/free-workflow").then((response) => response.json()) as { reviewReservation: { armed: boolean } }).reviewReservation.armed,
    false,
    "读状态时 armed 且无 reviewerId 不得对外表现为已预约",
  );
  assert.equal(claimTurn("free-orphan-arm-task"), true);
  await handleFreeWorkflowSettlement("free-orphan-arm-task", "done", true, true);
  const orphanAfter = await api.request("/tasks/free-orphan-arm-task/free-workflow").then((response) => response.json()) as {
    reviewReservation: { armed: boolean }; reviews: unknown[];
  };
  assert.equal(orphanAfter.reviewReservation.armed, false);
  assert.deepEqual(orphanAfter.reviews, [], "脏预约结算后应 disarm 且不派审");
  const orphanRow = (await db.select().from(freeWorkflowStates).where(eq(freeWorkflowStates.taskId, "free-orphan-arm-task"))).at(0);
  assert.equal(orphanRow?.reviewArmed, false, "结算守底应把 DB 里的 reviewArmed 清掉");

  const state = await api.request("/tasks/free-task/free-workflow");
  assert.equal(state.status, 200);
  const initialState = await state.json() as { reviews: unknown[]; executions: Array<{ status: string }>; merge?: unknown };
  assert.deepEqual(initialState.reviews, []);
  assert.equal(initialState.executions.length, 1, "历史自由任务没有执行事件时仍应保留一条兼容记录");
  assert.equal("merge" in initialState, false, "自由工作流状态不应再暴露第二套合并状态");

  const firstExecution = await recordFreeTaskExecutionStartIfFree("free-task", "2026-08-08T09:00:00.000Z");
  assert.ok(firstExecution);
  assert.equal(
    await recordFreeTaskExecutionStartIfFree("free-task", "2026-08-08T09:00:00.000Z"),
    firstExecution,
    "服务重启接回同一回合时不得重复新增任务执行记录",
  );
  await finishFreeTaskExecution(firstExecution, "completed", "2026-08-08T09:10:00.000Z");
  const secondExecution = await recordFreeTaskExecutionStartIfFree("free-task", "2026-08-08T11:00:00.000Z");
  assert.ok(secondExecution);
  await finishFreeTaskExecution(secondExecution, "completed", "2026-08-08T11:04:00.000Z");
  const executionHistory = await api.request("/tasks/free-task/free-workflow").then((response) => response.json()) as {
    executions: Array<{ id: string; status: string; startedAt: string; endedAt: string | null }>;
  };
  assert.deepEqual(executionHistory.executions, [
    { id: firstExecution, status: "completed", startedAt: "2026-08-08T09:00:00.000Z", endedAt: "2026-08-08T09:10:00.000Z" },
    { id: secondExecution, status: "completed", startedAt: "2026-08-08T11:00:00.000Z", endedAt: "2026-08-08T11:04:00.000Z" },
  ], "每次任务执行必须独立保留起止时间，不能被后一次覆盖");

  await recordFreePreviewEvent("free-task", {
    kind: "preview_opened", source: "user", detail: "http://127.0.0.1:4567",
    occurredAt: "2026-08-08T10:00:00.000Z",
  });
  await recordFreePreviewEvent("free-task", {
    kind: "preview_closed", source: "user", detail: "http://127.0.0.1:4567",
    occurredAt: "2026-08-08T10:01:00.000Z",
  });
  const previewHistory = await api.request("/tasks/free-task/free-workflow");
  assert.deepEqual(
    (await previewHistory.json() as { previewEvents: Array<{ kind: string; source: string; detail: string | null; occurredAt: string }> }).previewEvents
      .map(({ kind, source, detail, occurredAt }) => ({ kind, source, detail, occurredAt })),
    [
      { kind: "preview_opened", source: "user", detail: "http://127.0.0.1:4567", occurredAt: "2026-08-08T10:00:00.000Z" },
      { kind: "preview_closed", source: "user", detail: "http://127.0.0.1:4567", occurredAt: "2026-08-08T10:01:00.000Z" },
    ],
    "预览关闭后，打开与关闭事件仍应按实际发生顺序保留",
  );

  const review = await api.request("/tasks/free-task/free-workflow/review", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ reviewerId: reviewer.id, checkMode: "logic", retryLimit: 1 }),
  });
  assert.equal(review.status, 409, "未运行的自由任务不能派审");

  const stage = await api.request("/tasks/free-task/stage", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ stage: "awaiting_acceptance" }),
  });
  assert.equal(stage.status, 409, "自由任务不能写入旧起手式 stage");

  const accepted = await acceptTask("free-task");
  assert.equal(accepted.accepted, false);
  if (!accepted.accepted) assert.equal(accepted.reason, "free_workflow_not_ready_for_acceptance");

  const derived = await api.request("/tasks", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId: "p", title: "derived", parentId: "free-task", workflowMode: "free" }),
  });
  assert.equal(derived.status, 409, "自由工作流不能用于派生任务");
  const mixed = await api.request("/tasks", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId: "p", title: "mixed", workflowMode: "free", workflowId: "standard" }),
  });
  assert.equal(mixed.status, 400, "自由工作流不能夹带起手式引用");

  const removedMerge = await api.request("/tasks/free-accept-task/free-workflow/merge", { method: "POST" });
  assert.equal(removedMerge.status, 404, "自由工作流专属合并接口应删除");
  const freeAccepted = await acceptTask("free-accept-task");
  assert.equal(freeAccepted.accepted, true, "已完成的自由任务应走统一验收路径");
  let acceptedTask = (await db.select().from(tasks).where(eq(tasks.id, "free-accept-task"))).at(0);
  assert.equal(acceptedTask?.stage, "accepted", "统一验收成功后应把自由任务标为已验收");
  const acceptedAgain = await acceptTask("free-accept-task");
  assert.equal(acceptedAgain.accepted, true, "自由任务重复验收应沿用统一幂等语义");
  acceptedTask = (await db.select().from(tasks).where(eq(tasks.id, "free-accept-task"))).at(0);
  assert.equal(acceptedTask?.stage, "accepted");
  assert.equal(tryAcquireFreeWorkflowAction("free-worktree-task"), true);
  try {
    const lockedAcceptance = await acceptTask("free-worktree-task");
    assert.equal(lockedAcceptance.accepted, false, "其它自由操作持锁时不得开始验收");
    if (!lockedAcceptance.accepted) assert.equal(lockedAcceptance.reason, "free_workflow_action_in_progress");
    const lockedReview = await api.request("/tasks/free-worktree-task/free-workflow/review", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ reviewerId: reviewer.id, checkMode: "logic", retryLimit: 1 }),
    });
    assert.equal(lockedReview.status, 409, "统一验收与派审必须共用同一把自由操作锁");
    assert.equal(git(repo, "rev-parse", "main"), mainBeforeAcceptance, "自由操作互斥时不得推进目标分支");
    assert.equal(existsSync(worktree.path), true, "自由操作互斥时不得清理任务 worktree");
  } finally {
    releaseFreeWorkflowAction("free-worktree-task");
  }
  const blockingReviewAt = new Date().toISOString();
  await db.insert(freeReviewRuns).values({
    id: "blocking-review", taskId: "free-worktree-task", reviewerId: reviewer.id, reviewerName: "Codex logic",
    agentType: "codex", executorId: "reviewer-executor", model: "gpt-review", reasoningEffort: "high",
    checkMode: "logic", retryLimit: 1, currentRound: 1, status: "reviewing",
    createdAt: blockingReviewAt, updatedAt: blockingReviewAt, finishedAt: null,
  });
  let reviewBlocked = await acceptTask("free-worktree-task");
  assert.equal(reviewBlocked.accepted, false, "自由审查进行中不得验收");
  if (!reviewBlocked.accepted) assert.equal(reviewBlocked.reason, "free_review_in_progress");
  assert.equal(git(repo, "rev-parse", "main"), mainBeforeAcceptance, "审查中不得推进目标分支");
  assert.equal(existsSync(worktree.path), true, "审查中不得清理任务 worktree");
  await db.update(freeReviewRuns).set({ status: "repairing", updatedAt: new Date().toISOString() })
    .where(eq(freeReviewRuns.id, "blocking-review"));
  reviewBlocked = await acceptTask("free-worktree-task");
  assert.equal(reviewBlocked.accepted, false, "等待修复时不得验收");
  if (!reviewBlocked.accepted) assert.equal(reviewBlocked.reason, "free_review_in_progress");
  await db.update(freeReviewRuns).set({ status: "manual_repairing", updatedAt: new Date().toISOString() })
    .where(eq(freeReviewRuns.id, "blocking-review"));
  reviewBlocked = await acceptTask("free-worktree-task");
  assert.equal(reviewBlocked.accepted, false, "人工修复中不得验收");
  if (!reviewBlocked.accepted) assert.equal(reviewBlocked.reason, "free_review_in_progress");
  await db.update(freeReviewRuns).set({ status: "reworking", updatedAt: new Date().toISOString() })
    .where(eq(freeReviewRuns.id, "blocking-review"));
  reviewBlocked = await acceptTask("free-worktree-task");
  assert.equal(reviewBlocked.accepted, false, "任务重新修改中不得验收");
  if (!reviewBlocked.accepted) assert.equal(reviewBlocked.reason, "free_review_in_progress");
  await db.update(freeReviewRuns).set({ status: "passed", updatedAt: new Date().toISOString(), finishedAt: new Date().toISOString() })
    .where(eq(freeReviewRuns.id, "blocking-review"));
  const worktreeAccepted = await acceptTask("free-worktree-task");
  assert.equal(worktreeAccepted.accepted, true, "自由任务的独立 worktree 应复用统一安全合并与清理");
  assert.notEqual(git(repo, "rev-parse", "main"), mainBeforeAcceptance, "统一验收应推进目标分支");
  assert.equal(existsSync(worktree.path), false, "统一验收应清理自由任务 worktree");
  assert.equal(git(repo, "branch", "--list", "harness/free-worktree-task"), "", "统一验收应删除已合并任务分支");

  const reviewAt = new Date().toISOString();
  await db.insert(freeReviewRuns).values({
    id: "active-review", taskId: "free-task", reviewerId: reviewer.id, reviewerName: "Codex logic",
    agentType: "codex", executorId: "reviewer-executor", model: "gpt-review", reasoningEffort: "high",
    checkMode: "logic", retryLimit: 1, currentRound: 1, status: "reviewing",
    createdAt: reviewAt, updatedAt: reviewAt, finishedAt: null,
  });
  await db.insert(freeReviewRounds).values({
    id: "active-review-round-1", runId: "active-review", round: 1, status: "reviewing",
    conclusion: null, startedAt: reviewAt, endedAt: null,
  });
  assert.deepEqual(await freeReviewResumeOptions("free-task"), {
    agent: "codex", executorId: "reviewer-executor", model: "gpt-review", reasoningEffort: "high", sessionRole: "reviewer",
  });

  const evidence = join(root, "runs", "free-task", "free-review", "active-review", "round-1");
  mkdirSync(evidence, { recursive: true });
  writeFileSync(join(evidence, "report.md"), "# 审查报告\n\n内容可读。\n");
  writeFileSync(join(evidence, "shot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const reportFile = await api.request("/tasks/free-task/free-workflow/review-file?run=active-review&round=1&name=report.md");
  assert.equal(reportFile.status, 200);
  assert.match(reportFile.headers.get("content-type") ?? "", /^text\/markdown; charset=utf-8/i);
  assert.equal(await reportFile.text(), "# 审查报告\n\n内容可读。\n");
  const screenshotFile = await api.request("/tasks/free-task/free-workflow/review-file?run=active-review&round=1&name=shot.png");
  assert.equal(screenshotFile.status, 200);
  assert.equal(screenshotFile.headers.get("content-type"), "image/png");

  console.log("✓ 自由任务不携带起手式快照");
  console.log("✓ 默认 1 次自动复审的轮数语义正确");
  console.log("✓ 审查者 CRUD 与自由工作流初始状态可用");
  console.log("✓ 运行中可预约、覆盖、取消，失败保留且 confirmed done 后只自动派出一次");
  console.log("✓ 删除审查者会取消预约；脏 armed 状态读路径与结算路径均不会静默失效");
  console.log("✓ 预览打开与关闭事件持久保留且按发生顺序返回");
  console.log("✓ 每次自由任务执行都独立保留起止时间与状态");
  console.log("✓ backlog 与旧 stage 路径仍被隔离，完成后可统一验收");
  console.log("✓ 派生任务与起手式引用不能混入自由工作流");
  console.log("✓ 自由合并接口已删除，共享操作锁、活跃审查门禁、统一验收与 worktree 清理可用");
  console.log("✓ 审查续跑保持独立 reviewer 会话与原模型配置");
  console.log("✓ 技能名与斜杠命令只进入需求参考文件，不进入自由审查 prompt");
  console.log("✓ 自由审查报告与截图接口返回正确内容类型");
} finally {
  rmSync(root, { recursive: true, force: true });
}
