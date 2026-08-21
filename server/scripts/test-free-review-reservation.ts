// 预约槽的执行器覆盖与消费/回滚竞态（从 test-free-workflow.ts 拆出，纯行数拆分）：
// 「这次换个模型/智能水平跑」整套存整套落、执行器失效后的降级、启动失败整条回滚，
// 以及消费与清槽之间那个窗口里用户新保存的预约不许被抹掉。
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { releaseTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "ash-free-reservation-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");

try {
  const { ensureSchema, db } = await import("../src/db/index.js");
  const { agents, projects, sessions, tasks } = await import("../src/db/schema.js");
  const { createTasks } = await import("../src/task-store.js");
  const { handleFreeWorkflowSettlement } = await import("../src/free-workflow.js");
  const { mountFreeWorkflowRoutes } = await import("../src/free-workflow-routes.js");
  const {
    clearReservationForDispatch,
    readFreeReviewReservation,
    startReservedFreeReview,
  } = await import("../src/free-review-reservations.js");
  const { claimTurn } = await import("../src/runs.js");
  const { mountReviewerProfileRoutes } = await import("../src/reviewer-profiles.js");
  const { mountTaskRoutes } = await import("../src/task-routes.js");
  const { mountTaskStageRoutes } = await import("../src/task-stage.js");
  const { sessionTranscriptPath } = await import("../src/transcript.js");
  await ensureSchema();

  await db.insert(projects).values({ id: "p", name: "test", repoPath: root, apiKeys: null, workflowId: null, createdAt: new Date().toISOString() });
  await db.insert(agents).values({
    id: "reviewer-executor", name: "codex@test", type: "codex",    model: "gpt-test", extraArgs: "[]", reasoningEffort: "high", speed: null, providerId: null, isDefault: true,
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

  const freeTask = (id: string, title: string) => ({
    id, projectId: "p", groupId: null, parentId: null,
    title, body: "test", mode: "single" as const, status: "running" as const,
    labels: "[]", dependsOn: "[]", resumeDependsOn: "[]", agentType: "codex" as const,
    executorId: "reviewer-executor", model: null, reasoningEffort: null, autoTitle: false,
    duet: null, team: null, reportBack: false, scheduleId: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    useWorktree: false, worktreeBase: null, originTaskId: null, workflowMode: "free" as const,
  });

  // 「这次换个模型/智能水平跑」：覆盖整套存进预约槽、整套落到 run 行，审查者配置一个字不动。
  await createTasks([freeTask("free-override-task", "free override")]);
  const reserveOverride = async (override: unknown) => api.request(
    "/tasks/free-override-task/free-workflow/review-reservation",
    {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ reviewerId: reviewer.id, checkMode: "logic", retryLimit: 1, override }),
    },
  );
  assert.equal((await reserveOverride({ agentType: "claude", executorId: "reviewer-executor", model: null, reasoningEffort: null })).status, 409,
    "覆盖的执行器与智能体类型对不上时必须当场拒绝，不能拖到开跑才炸");
  assert.equal((await reserveOverride({ agentType: "codex", executorId: "ghost-executor", model: null, reasoningEffort: null })).status, 409,
    "覆盖到不存在的执行器必须当场拒绝");
  const overridden = await reserveOverride({ agentType: "codex", executorId: "reviewer-executor", model: "gpt-override", reasoningEffort: "low" });
  assert.equal(overridden.status, 200);
  assert.deepEqual((await overridden.json() as { reviewReservation: { override: unknown } }).reviewReservation.override,
    { agentType: "codex", executorId: "reviewer-executor", model: "gpt-override", reasoningEffort: "low" },
    "预约必须把「这次用什么跑」整套存下来");

  await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, "free-override-task"));
  assert.equal(claimTurn("free-override-task"), true);
  await handleFreeWorkflowSettlement("free-override-task", "done", true, true);
  const overrideState = await api.request("/tasks/free-override-task/free-workflow").then((response) => response.json()) as {
    reviewReservation: { armed: boolean; override: unknown };
    reviews: Array<{ agentType: string; model: string | null; reasoningEffort: string | null }>;
  };
  assert.deepEqual(overrideState.reviews.map(({ agentType, model, reasoningEffort }) => ({ agentType, model, reasoningEffort })), [
    { agentType: "codex", model: "gpt-override", reasoningEffort: "low" },
  ], "预约里的覆盖必须真的落到 run 行，否则审查照旧按审查者的老配置跑");
  assert.equal(overrideState.reviewReservation.armed, false);
  assert.equal(overrideState.reviewReservation.override, null, "派审后覆盖必须随预约一起清掉，不能在下条预约的表单里复活");
  const profilesAfterOverride = await api.request("/reviewer-profiles").then((response) => response.json()) as Array<{ id: string; model: string | null; reasoningEffort: string | null }>;
  const untouched = profilesAfterOverride.find((profile) => profile.id === reviewer.id);
  assert.deepEqual({ model: untouched?.model ?? null, reasoningEffort: untouched?.reasoningEffort ?? null },
    { model: null, reasoningEffort: "high" }, "选了「不保存」的覆盖不得写回审查者配置");

  // 预约里的执行器在任务完成前被删掉：只摘掉执行器这一段，用户改的模型/智能水平照用。
  // 整套丢弃等于按审查者旧配置跑，正是用户改配置想避开的那件事（审查实测）。
  await createTasks([freeTask("free-stale-override-task", "free stale override")]);
  await db.insert(sessions).values({
    id: "stale-override-session", taskId: "free-stale-override-task", role: "lead", agentType: "codex",
    executor: "codex@test", startedAt: new Date().toISOString(),
  });
  await db.insert(agents).values({
    id: "doomed-executor", name: "codex@doomed", type: "codex",    model: "gpt-doomed-default", extraArgs: "[]", reasoningEffort: "low", speed: null, providerId: null, isDefault: false,
  });
  assert.equal((await api.request("/tasks/free-stale-override-task/free-workflow/review-reservation", {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      reviewerId: reviewer.id, checkMode: "logic", retryLimit: 1,
      override: { agentType: "codex", executorId: "doomed-executor", model: "gpt-doomed", reasoningEffort: "xhigh" },
    }),
  })).status, 200);
  await db.delete(agents).where(eq(agents.id, "doomed-executor"));
  await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, "free-stale-override-task"));
  assert.equal(claimTurn("free-stale-override-task"), true);
  await handleFreeWorkflowSettlement("free-stale-override-task", "done", true, true);
  const staleState = await api.request("/tasks/free-stale-override-task/free-workflow").then((response) => response.json()) as {
    reviews: Array<{ status: string; agentType: string; executorId: string | null; model: string | null; reasoningEffort: string | null }>;
  };
  assert.deepEqual(staleState.reviews.map(({ status, agentType, executorId, model, reasoningEffort }) =>
    ({ status, agentType, executorId, model, reasoningEffort })), [
    { status: "reviewing", agentType: "codex", executorId: null, model: "gpt-doomed", reasoningEffort: "xhigh" },
  ], "执行器失效只该摘掉执行器那一段：模型与智能水平仍按用户预约时改的跑");
  const staleTimeline = readFileSync(sessionTranscriptPath("free-stale-override-task", "stale-override-session"), "utf8");
  assert.match(staleTimeline, /预约里选的执行器已不可用/, "降级可以做，但必须在时间线上说一声");

  // 预约启动失败必须把**整条**预约放回去。派审在启动前就把槽清成了空壳，只翻回 armed
  // 会得到一条没有附言、没有覆盖的残缺预约，下次确认完成时按审查者老配置跑。
  await createTasks([freeTask("free-rollback-task", "free rollback")]);
  const rollbackOverride = { agentType: "codex", executorId: "reviewer-executor", model: "gpt-rollback", reasoningEffort: "xhigh" };
  const reserveRollback = async (body: unknown) => api.request("/tasks/free-rollback-task/free-workflow/review-reservation", {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  assert.equal((await reserveRollback({
    reviewerId: reviewer.id, checkMode: "syntax", retryLimit: 2,
    note: "回滚要连附言一起回来", override: rollbackOverride,
  })).status, 200);
  // 复刻 startFreeReview 的真实副作用顺序：先按消费令牌清槽，再在启动环节抛错。
  const failingDispatch = (extra?: () => Promise<unknown>) => ({
    continueRun: async () => { throw new Error("本用例只走新建审查链"); },
    startNew: async (input: { reviewerId: string; slotToken: string }) => {
      await clearReservationForDispatch("free-rollback-task", {
        reviewerId: input.reviewerId, checkMode: "syntax", retryLimit: 2, token: input.slotToken,
      });
      if (extra) await extra();
      throw new Error("投递失败");
    },
  });
  await startReservedFreeReview("free-rollback-task", await readFreeReviewReservation("free-rollback-task"), failingDispatch());
  const rolledBack = await api.request("/tasks/free-rollback-task/free-workflow").then((response) => response.json()) as {
    reviewReservation: { armed: boolean; reviewerId: string | null; checkMode: string | null; retryLimit: number | null; note: string | null; override: unknown; runId: string | null };
  };
  assert.deepEqual(rolledBack.reviewReservation, {
    armed: true, reviewerId: reviewer.id, checkMode: "syntax", retryLimit: 2, note: "回滚要连附言一起回来",
    override: rollbackOverride, runId: null,
  }, "启动失败必须整条预约回滚：附言和执行器覆盖一起回来，否则下次自动审查会按老配置跑");

  // 用户在启动失败前又保存了新预约：那条是他最新的意思，回滚一个字都不许碰。
  await startReservedFreeReview("free-rollback-task", await readFreeReviewReservation("free-rollback-task"), failingDispatch(
    () => reserveRollback({ reviewerId: reviewer.id, checkMode: "logic", retryLimit: 0, note: "我改主意了", override: null }),
  ));
  const kept = await api.request("/tasks/free-rollback-task/free-workflow").then((response) => response.json()) as {
    reviewReservation: { armed: boolean; checkMode: string | null; retryLimit: number | null; note: string | null; override: unknown };
  };
  assert.deepEqual({
    armed: kept.reviewReservation.armed, checkMode: kept.reviewReservation.checkMode,
    retryLimit: kept.reviewReservation.retryLimit, note: kept.reviewReservation.note,
    override: kept.reviewReservation.override,
  }, { armed: true, checkMode: "logic", retryLimit: 0, note: "我改主意了", override: null },
    "回滚不得盖掉用户在这中间保存的新预约");

  // 同一个窗口的另一半：用户抢在派审清槽**之前**保存。清槽只能收拾自己腾出的那个空位，
  // 否则这条迟到的 upsert 会把新预约连 armed 带附言、覆盖一起抹平。
  const raceDispatch = {
    continueRun: async () => { throw new Error("本用例只走新建审查链"); },
    startNew: async (input: { reviewerId: string; slotToken: string }) => {
      await reserveRollback({
        reviewerId: reviewer.id, checkMode: "syntax", retryLimit: 3,
        note: "清槽前抢先保存", override: rollbackOverride,
      });
      await clearReservationForDispatch("free-rollback-task", {
        reviewerId: input.reviewerId, checkMode: "logic", retryLimit: 0, token: input.slotToken,
      });
      throw new Error("投递失败");
    },
  };
  await startReservedFreeReview("free-rollback-task", await readFreeReviewReservation("free-rollback-task"), raceDispatch);
  const raced = await api.request("/tasks/free-rollback-task/free-workflow").then((response) => response.json()) as {
    reviewReservation: { armed: boolean; checkMode: string | null; retryLimit: number | null; note: string | null; override: unknown };
  };
  assert.deepEqual({
    armed: raced.reviewReservation.armed, checkMode: raced.reviewReservation.checkMode,
    retryLimit: raced.reviewReservation.retryLimit, note: raced.reviewReservation.note,
    override: raced.reviewReservation.override,
  }, { armed: true, checkMode: "syntax", retryLimit: 3, note: "清槽前抢先保存", override: rollbackOverride },
    "派审清槽不得抹掉消费之后、清槽之前保存的新预约");

  console.log("✓ 预约覆盖整套存整套落，审查者配置不受影响");
  console.log("✓ 预约里的执行器失效只摘执行器那一段，模型与智能水平照用且时间线有交代");
  console.log("✓ 预约启动失败整条回滚；消费与清槽窗口内用户新保存的预约不被抹掉");
} finally {
  // 删舞台前先松开库文件,否则 Windows 上必然 EBUSY(理由见 tmp-db.ts 的 releaseTmpDb)。
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
}
