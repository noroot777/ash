import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { releaseTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "ash-task-steer-hardening-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");

const [
  { db, ensureSchema },
  schema,
  runs,
  steer,
  { mountTaskRunRoutes },
  { mountTaskRoutes },
  { mountTaskStageRoutes },
  { setTaskStatus },
] = await Promise.all([
  import("../src/db/index.js"),
  import("../src/db/schema.js"),
  import("../src/runs.js"),
  import("../src/task-steer.js"),
  import("../src/task-run-routes.js"),
  import("../src/task-routes.js"),
  import("../src/task-stage.js"),
  import("../src/status.js"),
]);
const { projects, scheduledMessages, tasks } = schema;
await ensureSchema();

const at = new Date().toISOString();
await db.insert(projects).values({ id: "p", name: "steer", repoPath: root, apiKeys: null, createdAt: at });
const task = (id: string, extra: Partial<typeof tasks.$inferInsert> = {}): typeof tasks.$inferInsert => ({
  id,
  projectId: "p",
  title: id,
  body: "test",
  mode: "single",
  status: "running",
  labels: "[]",
  dependsOn: "[]",
  resumeDependsOn: "[]",
  createdAt: at,
  updatedAt: at,
  ...extra,
});
const message = (
  id: string,
  taskId: string,
  order = at,
): typeof scheduledMessages.$inferInsert => ({
  id,
  taskId,
  text: id,
  attachments: "[]",
  mode: "queued",
  sendAt: order,
  status: "pending",
  createdAt: order,
  sentAt: null,
  deliveringSince: null,
});

try {
  // 两阶段预约：旧流先结束时必须等 commit；cancel 则回到普通结算，不 kill、不续送。
  assert.equal(runs.claimTurn("reservation", "single"), true);
  let kills = 0;
  let continued = 0;
  const handle = { kill: () => { kills++; } };
  runs.trackRun("reservation", handle);
  const reservation = runs.reserveSteerTask("reservation", () => { continued++; });
  assert.ok(reservation, "活动 handle 应能预约引导");
  let decided = false;
  const decision = runs.takeSteered("reservation").then((value) => {
    decided = true;
    return value;
  });
  await Promise.resolve();
  assert.equal(decided, false, "DB 清理尚未提交时，已结束的旧流必须等待决定");
  reservation.commit();
  assert.equal(kills, 1, "提交后才 kill 当前 handle");
  assert.equal(await decision, true, "提交后旧回合跳过普通结算");
  runs.untrackRun("reservation", handle);
  runs.releaseTurn("reservation");
  assert.equal(continued, 1, "释放 turn 后只续送一次");

  assert.equal(runs.claimTurn("reservation-cancel", "single"), true);
  const cancelHandle = { kill: () => { kills++; } };
  runs.trackRun("reservation-cancel", cancelHandle);
  const canceled = runs.reserveSteerTask("reservation-cancel", () => { continued++; });
  assert.ok(canceled);
  const canceledDecision = runs.takeSteered("reservation-cancel");
  canceled.cancel();
  assert.equal(await canceledDecision, false, "撤销预约后旧回合应照常结算");
  runs.untrackRun("reservation-cancel", cancelHandle);
  runs.releaseTurn("reservation-cancel");
  assert.equal(kills, 1, "撤销不得 kill");
  assert.equal(continued, 1, "撤销不得续送");
  console.log("✓ steering reservation 覆盖自然结束竞态，并支持无副作用撤销");

  await db.insert(tasks).values([
    task("verify", { verifyRound: 1 }),
    task("native", { nativeTurn: true }),
    task("review-task", { reviewOf: "target" }),
    task("reviewer-role"),
    task("ordered"),
    task("token", { activeTurnToken: "new-token" }),
    task("patch-source", { activeTurnToken: "source-token" }),
    task("patch-target", { activeTurnToken: "target-token" }),
    task("team-patcher", { mode: "team", status: "idle", activeTurnToken: null }),
    task("team-ask", { mode: "team", status: "idle", activeTurnToken: null }),
  ]);
  await db.insert(scheduledMessages).values([
    message("m-verify", "verify"),
    message("m-native", "native"),
    message("m-review-task", "review-task"),
    message("m-reviewer-role", "reviewer-role"),
    message("ordered-a", "ordered"),
    message("ordered-b", "ordered"),
  ]);

  for (const [messageId, pattern] of [
    ["m-verify", /验证/],
    ["m-native", /CLI 命令/],
    ["m-review-task", /审查任务/],
  ] as const) {
    const result = await steer.steerQueuedMessage(messageId);
    assert.equal(result.ok, false, `${messageId} 不得被引导`);
    if (!result.ok) assert.match(result.error, pattern);
    const row = (await db.select().from(scheduledMessages).where(eq(scheduledMessages.id, messageId))).at(0)!;
    assert.equal(row.status, "pending");
    assert.equal(row.deliveringSince, null, "旁路拒绝不得抢消息租约");
  }
  assert.equal(runs.claimTurn("reviewer-role", "reviewer"), true);
  const reviewerResult = await steer.steerQueuedMessage("m-reviewer-role");
  runs.releaseTurn("reviewer-role");
  assert.equal(reviewerResult.ok, false, "自由 reviewer 回合不得被引导");
  if (!reviewerResult.ok) assert.match(reviewerResult.error, /旁路|审查/);
  console.log("✓ 验证、审查、reviewer 与原生命令回合全部留队，不消耗旁路轮次");

  assert.equal(runs.claimTurn("ordered", "single"), true);
  let orderedKills = 0;
  const orderedHandle = { kill: () => { orderedKills++; } };
  runs.trackRun("ordered", orderedHandle);
  const outOfOrder = await steer.steerQueuedMessage("ordered-b");
  assert.equal(outOfOrder.ok, false, "后端必须拒绝绕过 UI 引导较晚消息");
  if (!outOfOrder.ok) assert.match(outOfOrder.error, /排队顺序|最早/);
  assert.equal(orderedKills, 0, "顺序拒绝发生在预约/kill 之前");
  runs.untrackRun("ordered", orderedHandle);
  runs.releaseTurn("ordered");
  console.log("✓ 引导只能消费队首，API 无法把较晚消息反序提前");

  const api = new Hono();
  mountTaskRunRoutes(api);
  mountTaskRoutes(api);
  mountTaskStageRoutes(api);
  const complete = (token?: string) => api.request("/tasks/token/complete", {
    method: "POST",
    headers: token ? { "x-ash-turn-token": token } : undefined,
  });
  const stale = await complete("old-token");
  assert.equal(stale.status, 409, "旧回合完成确认必须被拒绝");
  assert.equal(
    (await db.select().from(tasks).where(eq(tasks.id, "token"))).at(0)!.completeConfirmedAt,
    null,
    "旧 token 不得写入完成票",
  );
  const current = await complete("new-token");
  assert.equal(current.status, 200, "当前回合 token 应能确认完成");
  assert.ok((await db.select().from(tasks).where(eq(tasks.id, "token"))).at(0)!.completeConfirmedAt);
  runs.takeConfirmed("token");

  const postTurnAction = (path: string, body: unknown, token?: string) => api.request(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { "x-ash-turn-token": token } : {}),
    },
    body: JSON.stringify(body),
  });
  await db.update(tasks).set({ completeConfirmedAt: null, resumePrompt: null, question: null })
    .where(eq(tasks.id, "token"));
  for (const token of ["old-token", undefined]) {
    const paused = await postTurnAction("/tasks/token/pause", { resumePrompt: "stale checkpoint" }, token);
    assert.equal(paused.status, 409, "旧 token 或缺 token 的 pause_task 必须被拒绝");
  }
  assert.equal(
    (await db.select().from(tasks).where(eq(tasks.id, "token"))).at(0)!.resumePrompt,
    null,
    "旧回合不得写入检查点",
  );
  assert.equal(
    (await postTurnAction("/tasks/token/pause", { resumePrompt: "current checkpoint" }, "new-token")).status,
    200,
    "当前回合 pause_task 应继续可用",
  );
  await db.update(tasks).set({ resumePrompt: null }).where(eq(tasks.id, "token"));

  for (const token of ["old-token", undefined]) {
    const asked = await postTurnAction("/tasks/token/ask", { question: "stale question" }, token);
    assert.equal(asked.status, 409, "旧 token 或缺 token 的 ask_question 必须被拒绝");
  }
  assert.equal(
    (await db.select().from(tasks).where(eq(tasks.id, "token"))).at(0)!.question,
    null,
    "旧回合不得写入提问",
  );
  assert.equal(
    (await postTurnAction("/tasks/token/ask", { question: "current question" }, "new-token")).status,
    200,
    "当前回合 ask_question 应继续可用",
  );
  assert.equal(
    (await postTurnAction("/tasks/team-ask/ask", { question: "team question" })).status,
    200,
    "团队常驻提问没有一次性回合 token，必须保持兼容",
  );
  console.log("✓ pause_task / ask_question 与 complete_task 一样绑定当前回合 token");

  const reportStage = (token?: string) => api.request("/tasks/token/stage", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { "x-ash-turn-token": token } : {}),
    },
    body: JSON.stringify({ stage: "implemented" }),
  });
  for (const token of ["old-token", undefined]) {
    assert.equal((await reportStage(token)).status, 409, "旧 token 或缺 token 的 report_stage 必须被拒绝");
  }
  assert.equal((await db.select().from(tasks).where(eq(tasks.id, "token"))).at(0)!.stage, null);
  assert.equal((await reportStage("new-token")).status, 200, "当前回合 report_stage 应继续可用");
  assert.equal((await db.select().from(tasks).where(eq(tasks.id, "token"))).at(0)!.stage, "implemented");
  await db.update(tasks).set({ stage: null }).where(eq(tasks.id, "token"));

  const patchTask = (taskId: string, title: string, headers: Record<string, string> = {}) => api.request(`/tasks/${taskId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ title }),
  });
  const noIdentityPatch = await patchTask("token", "stale-no-token");
  assert.equal(noIdentityPatch.status, 409, "无来源的运行中 PATCH 必须拒绝");
  assert.match(
    ((await noIdentityPatch.json()) as { error: string }).error,
    /缺少.*回合身份|外部 MCP/,
    "没有身份的外部调用不能误报成旧回合",
  );
  assert.equal((await patchTask("token", "stale-old-token", {
    "x-ash-source-task-id": "token",
    "x-ash-turn-token": "old-token",
  })).status, 409, "旧回合 PATCH 必须拒绝");
  assert.equal((await patchTask("token", "current-turn", {
    "x-ash-source-task-id": "token",
    "x-ash-turn-token": "new-token",
  })).status, 200, "当前回合 PATCH 应继续可用");
  assert.equal((await patchTask("token", "human-edit", {
    "x-ash-user-action": "1",
  })).status, 200, "真人界面修改运行中任务必须保持兼容");
  assert.equal((await patchTask("patch-target", "cross-task", {
    "x-ash-source-task-id": "patch-source",
    "x-ash-turn-token": "source-token",
  })).status, 200, "当前回合应能跨任务 PATCH");
  await db.update(tasks).set({ activeTurnToken: "source-next-token" }).where(eq(tasks.id, "patch-source"));
  assert.equal((await patchTask("patch-target", "stale-cross-task", {
    "x-ash-source-task-id": "patch-source",
    "x-ash-turn-token": "source-token",
  })).status, 409, "跨任务 PATCH 也必须绑定发起者当前回合");
  assert.equal((await patchTask("patch-target", "team-cross-task", {
    "x-ash-source-task-id": "team-patcher",
  })).status, 200, "团队常驻调度者跨任务 PATCH 必须保持兼容");
  assert.equal((await db.select().from(tasks).where(eq(tasks.id, "patch-target"))).at(0)!.title, "team-cross-task");
  console.log("✓ report_stage / patch_task 拒绝旧回合，并保留用户操作与团队跨任务修改");

  await setTaskStatus("token", "failed");
  assert.equal(
    (await db.select().from(tasks).where(eq(tasks.id, "token"))).at(0)!.activeTurnToken,
    null,
    "离开 running 后应清掉活动回合 token",
  );
  console.log("✓ complete_task 严格绑定当前回合 token，旧回合迟到确认返回 409");
} finally {
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
}
