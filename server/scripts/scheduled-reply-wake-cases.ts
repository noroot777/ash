// 「回复撞上上一轮的收尾窗口」:任务已经落了终态、会话也记了结束,run loop 却还在收尾
// (基线对账、afterSettlement 那几步)、回合锁还没放。这时来的回复起不了回合,原话只能
// 入队等 —— 而上一轮落终态时那次补送扫描早就扫过了(那时还没有这一行),锁放开时又没有
// 任何人登记过「放开了就送」,于是它只能干等 30 秒一次的兜底 tick。门禁满载时用户看到的
// 就是:回复发出去了,托盘里挂着「等待当前一轮结束」,而那一轮明明已经结束了。
//
// 本组跑在主脚本的 startScheduler 之前:这里能送出去,只可能是入队那一刻登记的唤醒。
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import type { HandoffCaseContext } from "./scheduled-handoff-cases.js";

export async function runReplyWakeCases(ctx: HandoffCaseContext): Promise<void> {
  const { leadLog, waitFor, countIn, taskRow } = ctx;
  const [{ db }, schema, runs, runRoutes, { Hono }] = await Promise.all([
    import("../src/db/index.js"),
    import("../src/db/schema.js"),
    import("../src/runs.js"),
    import("../src/task-run-routes.js"),
    import("hono"),
  ]);
  const { scheduledMessages, sessions, tasks } = schema;
  const api = new Hono();
  runRoutes.mountTaskRunRoutes(api);

  const taskId = "scheduled-single-reply-settling";
  const text = "上一轮刚收尾就发的这句话不许干等兜底(reply-wake)";
  await db.insert(tasks).values({ ...taskRow(taskId, "claude", "done"), mode: "single", team: null });
  // 上一轮还在收尾:状态已是终态,回合锁还占着(run loop 的 finally 还没走到 releaseTurn)。
  assert.equal(runs.claimTurn(taskId), true, "测试自身前提:收尾中的那一轮应该占得到锁");
  const reply = await api.request(`/tasks/${taskId}/reply`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }),
  });
  assert.equal(reply.status, 202);
  const pendingRow = async () => (await db.select().from(scheduledMessages)
    .where(eq(scheduledMessages.taskId, taskId))).at(0);
  await waitFor(async () => (await pendingRow())?.status === "pending", "锁还占着时这条回复应该原话入队");
  assert.equal((await db.select().from(sessions).where(eq(sessions.taskId, taskId))).length, 0,
    "锁还占着就不该起下一轮");

  runs.releaseTurn(taskId); // 上一轮的 run loop 收尾完毕
  await waitFor(() => countIn(leadLog, "reply-wake") > 0,
    "上一轮的锁一放,排着的回复就该送进会话 —— 没人登记唤醒的话它要干等 30 秒兜底 tick");
  await waitFor(async () => (await pendingRow())?.status === "sent", "送进会话之后这一行应标 sent");
  await waitFor(async () => {
    const s = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0)!.status;
    return s !== "running" && s !== "queued";
  }, "排着的回复送出去的那一轮没有结算");
  console.log("✓ 回复撞上收尾窗口:原话入队,上一轮的锁一放立刻送达,不等兜底 tick");

  // 同一个窗口的**答复**形态:提问那一轮已经落了 paused(所以答复不再被 409 挡回),run loop
  // 却还在收尾、锁没放。团队调度者收到【执行者提问】就答,正好落在这一段里。
  const askId = "scheduled-single-answer-settling";
  const answer = "提问那一轮刚收尾就给的答复不许干等兜底(answer-wake)";
  await db.insert(tasks).values({
    ...taskRow(askId, "claude", "paused"), mode: "single", team: null, question: "接下来采用新方案还是旧方案？",
  });
  await db.insert(sessions).values({
    id: "scheduled-answer-settling-prev", taskId: askId, role: "single", agentType: "claude",
    executor: "claude@test", cwd: ctx.root, cliSessionId: "scheduled-answer-settling-cli", startedAt: ctx.at,
  });
  assert.equal(runs.claimTurn(askId), true, "测试自身前提:收尾中的提问那一轮应该占得到锁");
  const answered = await api.request(`/tasks/${askId}/answer`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ answer }),
  });
  assert.equal(answered.status, 200, "提问回合已落 paused,答复应被接住");
  const answerRow = async () => (await db.select().from(scheduledMessages)
    .where(eq(scheduledMessages.taskId, askId))).at(0);
  await waitFor(async () => (await answerRow())?.status === "pending", "锁还占着时这条答复应该原话入队");
  assert.equal((await answerRow())?.execution, true, "被回合挡回的答复仍是执行型");
  assert.equal(countIn(leadLog, "answer-wake"), 0, "锁还占着就不该把答复送进任何 stdin");

  runs.releaseTurn(askId); // 提问那一轮的 run loop 收尾完毕
  await waitFor(() => countIn(leadLog, "answer-wake") > 0,
    "提问那一轮的锁一放,排着的答复就该送进会话 —— 没人登记唤醒的话它要干等 30 秒兜底 tick");
  await waitFor(async () => (await answerRow())?.status === "sent", "答复送进会话之后这一行应标 sent");
  await waitFor(async () => {
    const s = (await db.select().from(tasks).where(eq(tasks.id, askId))).at(0)!.status;
    return s !== "running" && s !== "queued";
  }, "排着的答复送出去的那一轮没有结算");
  assert.equal(countIn(leadLog, "answer-wake"), 1, "同一条答复只送一次");
  console.log("✓ 答复撞上收尾窗口:原话入队,提问那一轮的锁一放立刻送达,不等兜底 tick");
}
