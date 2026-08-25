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

const [{ db, ensureSchema }, schema, runs, steer, { mountTaskRunRoutes }, { setTaskStatus }] = await Promise.all([
  import("../src/db/index.js"),
  import("../src/db/schema.js"),
  import("../src/runs.js"),
  import("../src/task-steer.js"),
  import("../src/task-run-routes.js"),
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
