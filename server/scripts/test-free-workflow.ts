import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

const root = mkdtempSync(join(tmpdir(), "harness-free-workflow-"));
process.env.HARNESS_DB = join(root, "harness.db");

try {
  const { ensureSchema, db } = await import("../src/db/index.js");
  const { agents, freeReviewRuns, projects } = await import("../src/db/schema.js");
  const { createTasks } = await import("../src/task-store.js");
  const { mountFreeWorkflowRoutes, freeReviewOutcome, freeReviewResumeOptions } = await import("../src/free-workflow.js");
  const { mountReviewerProfileRoutes } = await import("../src/reviewer-profiles.js");
  const { mountTaskRoutes } = await import("../src/task-routes.js");
  const { mountTaskStageRoutes } = await import("../src/task-stage.js");
  const { acceptTask } = await import("../src/task-accept.js");
  await ensureSchema();

  await db.insert(projects).values({ id: "p", name: "test", repoPath: root, apiKeys: null, workflowId: null, createdAt: new Date().toISOString() });
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

  const state = await api.request("/tasks/free-task/free-workflow");
  assert.equal(state.status, 200);
  assert.deepEqual((await state.json() as { reviews: unknown[] }).reviews, []);

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
  if (!accepted.accepted) assert.equal(accepted.reason, "free_workflow_acceptance_not_applicable");

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

  const reviewAt = new Date().toISOString();
  await db.insert(freeReviewRuns).values({
    id: "active-review", taskId: "free-task", reviewerId: reviewer.id, reviewerName: "Codex logic",
    agentType: "codex", executorId: "reviewer-executor", model: "gpt-review", reasoningEffort: "high",
    checkMode: "logic", retryLimit: 1, currentRound: 1, status: "reviewing",
    createdAt: reviewAt, updatedAt: reviewAt, finishedAt: null,
  });
  assert.deepEqual(await freeReviewResumeOptions("free-task"), {
    agent: "codex", executorId: "reviewer-executor", model: "gpt-review", reasoningEffort: "high", sessionRole: "reviewer",
  });

  console.log("✓ 自由任务不携带起手式快照");
  console.log("✓ 默认 1 次自动复审的轮数语义正确");
  console.log("✓ 审查者 CRUD 与自由工作流初始状态可用");
  console.log("✓ backlog、旧 stage 与旧 accept 路径均被隔离");
  console.log("✓ 派生任务与起手式引用不能混入自由工作流");
  console.log("✓ 审查续跑保持独立 reviewer 会话与原模型配置");
} finally {
  rmSync(root, { recursive: true, force: true });
}
