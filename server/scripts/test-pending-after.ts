// 「等某任务完成后发送」(mode=after)与「已结束任务不能入队」的回归。
//   ① 纯判定:afterGateOf / isDueForDelivery / deliveryVerdict / finishedMembers
//   ② 落库:/reply 带 afterTaskId 的校验与落行、withAfterGates 批量贴判定、
//      hasDeliverablePendingMessages 不把没等到前置任务的消息算成「该发」、send-now 改成排队
//   ③ 队列写入口:insert / create 拒绝已结束的任务
// 全程不投递,不会拉起真 agent:send-now 那一下会触发一次扫描,所以先把任务归档,让扫描
// 判「取消」而不是续跑;队列那一组的队头是 running,推进不会再拉起任何成员。
// 跑:npm -w server run test:pending-after
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { eq } from "drizzle-orm";

const root = mkdtempSync(join(tmpdir(), "ash-pending-after-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");

const { releaseTmpDb } = await import("./tmp-db.js");
const { db, ensureSchema } = await import("../src/db/index.js");
const { projects, tasks, scheduledMessages, queueItems } = await import("../src/db/schema.js");
const { afterGateOf, withAfterGates } = await import("../src/pending-after.js");
const { deliveryVerdict, isDueForDelivery } = await import("../src/pending-verdict.js");
const { hasDeliverablePendingMessages } = await import("../src/pending-messages.js");
const { finishedMembers, mountQueueRoutes } = await import("../src/queues.js");
const { replyToTask } = await import("../src/task-reply.js");
const { mountTaskRunRoutes } = await import("../src/task-run-routes.js");
await ensureSchema();

try {
  // ── ① 纯判定 ──────────────────────────────────────────────────────────────
  const facts = (status: string, extra: Partial<Parameters<typeof afterGateOf>[0] & object> = {}) =>
    ({ id: "p", title: "前置", status, followUpFrom: null, archived: false, endedAt: null, ...extra });
  assert.equal(afterGateOf(facts("done", { endedAt: "2026-11-04T00:00:00.000Z" })).afterDone, true);
  assert.equal(afterGateOf(facts("done", { endedAt: "2026-11-04T00:00:00.000Z" })).afterEndedAt, "2026-11-04T00:00:00.000Z");
  assert.equal(afterGateOf(facts("running", { followUpFrom: "done" })).afterDone, true, "已完成任务的续聊回合仍算完成");
  assert.equal(afterGateOf(facts("running", { followUpFrom: "failed" })).afterDone, false, "失败任务的续聊不算完成");
  for (const status of ["backlog", "running", "queued", "paused", "awaiting_review", "failed", "canceled"]) {
    const gate = afterGateOf(facts(status));
    assert.equal(gate.afterDone, false, `${status} 不算完成`);
    assert.ok(gate.afterWaitReason, `${status} 要说清在等什么`);
  }
  assert.match(afterGateOf(facts("canceled")).afterWaitReason!, /重跑完成后才会发/);
  assert.match(afterGateOf(facts("paused", { archived: true })).afterWaitReason!, /已归档/);
  assert.match(afterGateOf(null).afterWaitReason!, /已删除/);

  const at = new Date("2026-11-04T12:00:00.000Z");
  const past = "2026-11-04T11:00:00.000Z";
  // sendAt 对 after 只是入队时刻:哪怕早于此刻,前置没完成就不到期(不能落进钟点那一支)。
  assert.equal(isDueForDelivery({ mode: "after", sendAt: past }, at), false);
  assert.equal(isDueForDelivery({ mode: "after", sendAt: past, afterDone: false }, at), false);
  assert.equal(isDueForDelivery({ mode: "after", sendAt: past, afterDone: true }, at), true);
  assert.equal(isDueForDelivery({ mode: "timed", sendAt: past }, at), true, "定时消息照旧看钟点");
  assert.equal(isDueForDelivery({ mode: "queued", sendAt: "2099-01-01T00:00:00.000Z" }, at), true, "排队消息照旧不看钟点");

  const idle = { mode: "single", status: "done", archived: false };
  assert.deepEqual(deliveryVerdict({ mode: "after", sendAt: past, afterDone: false }, idle, at), { action: "wait" },
    "前置没完成:等,不是取消");
  assert.deepEqual(deliveryVerdict({ mode: "after", sendAt: past, afterDone: true }, idle, at), { action: "deliver" });
  assert.deepEqual(deliveryVerdict({ mode: "after", sendAt: past, afterDone: true }, { ...idle, status: "running" }, at),
    { action: "wait" }, "前置完成了,本任务还在跑:照旧等这一轮结束");

  assert.deepEqual(finishedMembers([
    { id: "a", status: "backlog" }, { id: "b", status: "done" }, { id: "c", status: "failed" },
    { id: "d", status: "canceled" }, { id: "e", status: "running", followUpFrom: "done" },
    { id: "f", status: "running" }, { id: "g", status: "paused" },
  ]), ["b", "c", "d", "e"]);

  // ── ② 落库 ────────────────────────────────────────────────────────────────
  const ts = "2026-11-04T00:00:00.000Z";
  await db.insert(projects).values([
    { id: "pa-p", name: "p", repoPath: join(root, "repo"), createdAt: ts },
    { id: "pa-q", name: "q", repoPath: join(root, "repo2"), createdAt: ts },
  ] as never);
  const task = (id: string, status: string, projectId = "pa-p") =>
    ({ id, projectId, title: id, status, mode: "single", createdAt: ts, updatedAt: ts });
  await db.insert(tasks).values([
    task("me", "done"), task("pre", "running"), task("other", "backlog", "pa-q"),
    task("q-head", "running"), task("q-done", "done"), task("q-canceled", "canceled"), task("q-fresh", "backlog"),
  ] as never);

  const api = new Hono();
  api.post("/tasks/:id/reply", (c) => replyToTask(c, c.req.param("id")));
  mountTaskRunRoutes(api);
  mountQueueRoutes(api);
  const post = async (path: string, body: unknown) => {
    const res = await api.request(path, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  };

  assert.equal((await post("/tasks/me/reply", { text: "x", afterTaskId: "me" })).status, 400, "不能等自己");
  assert.equal((await post("/tasks/me/reply", { text: "x", afterTaskId: "nope" })).status, 404, "不存在的前置任务");
  assert.equal((await post("/tasks/me/reply", { text: "x", afterTaskId: "other" })).status, 400, "跨项目");
  assert.equal((await post("/tasks/me/reply", { text: "x", afterTaskId: "pre", sendAt: "2099-01-01T00:00:00.000Z" })).status,
    400, "定时与等任务二选一");

  // 本任务是 done(空闲)也要落成待发送消息,而不是立刻续聊 —— 等的是前置任务。
  const queued = await post("/tasks/me/reply", { text: "等 pre 跑完再看", afterTaskId: "pre" });
  assert.equal(queued.status, 202);
  const message = queued.body.message as { id: string; mode: string; afterTaskId: string };
  assert.equal(message.mode, "after");
  assert.equal(message.afterTaskId, "pre");
  const row = (await db.select().from(scheduledMessages).where(eq(scheduledMessages.id, message.id))).at(0)!;
  assert.equal(row.status, "pending");
  assert.equal(row.execution, false, "等前置任务的消息不是执行型");

  const [gated] = await withAfterGates([row]);
  assert.equal(gated!.afterDone, false);
  assert.equal(await hasDeliverablePendingMessages("me"), false, "前置没完成,不算「此刻该送」的消息(不挡结算)");

  await db.update(tasks).set({ status: "failed" }).where(eq(tasks.id, "pre"));
  assert.equal(await hasDeliverablePendingMessages("me"), false, "前置失败也不发");
  await db.update(tasks).set({ status: "done", endedAt: "2026-11-04T10:00:00.000Z" }).where(eq(tasks.id, "pre"));
  const [ready] = await withAfterGates([row]);
  assert.equal(ready!.afterDone, true);
  assert.equal(ready!.afterEndedAt, "2026-11-04T10:00:00.000Z");
  assert.equal(await hasDeliverablePendingMessages("me"), true, "前置完成 = 到期");

  // 「不等了」:改成普通排队消息,依赖清掉;再按一次是 409。
  await db.update(tasks).set({ status: "canceled" }).where(eq(tasks.id, "pre"));
  await db.update(tasks).set({ archived: true }).where(eq(tasks.id, "me"));
  const released = await post(`/scheduled-messages/${message.id}/send-now`, {});
  assert.equal(released.status, 200);
  const after = (await db.select().from(scheduledMessages).where(eq(scheduledMessages.id, message.id))).at(0)!;
  assert.equal(after.mode, "queued");
  assert.equal(after.afterTaskId, null);
  assert.equal((await post(`/scheduled-messages/${message.id}/send-now`, {})).status, 409);
  await db.update(scheduledMessages).set({ status: "canceled" }).where(eq(scheduledMessages.id, message.id));

  // ── ③ 队列写入口 ──────────────────────────────────────────────────────────
  assert.equal((await post("/queues", { taskIds: ["q-head", "q-done"] })).status, 409, "建队不收已完成的");
  assert.equal((await post("/queues", { taskIds: ["q-canceled", "q-fresh"] })).status, 409, "建队不收已取消的");
  const created = await post("/queues", { taskIds: ["q-head"] });
  assert.equal(created.status, 201);
  const qid = created.body.queueId as string;
  const rejected = await post(`/queues/${qid}/insert`, { taskId: "q-canceled" });
  assert.equal(rejected.status, 409, "已取消的不能插进队列");
  assert.match(String(rejected.body.error), /已结束/);
  assert.equal((await post(`/queues/${qid}/insert`, { taskId: "q-done" })).status, 409, "已完成的不能插进队列");
  assert.equal((await db.select().from(queueItems).where(eq(queueItems.queueId, qid))).length, 1, "被拒的一个都没落库");
  assert.equal((await post(`/queues/${qid}/insert`, { taskId: "q-fresh" })).status, 200, "待办任务照常入队");

  console.log("test-pending-after ok");
} finally {
  // 入队/建队会在后台推一次队列(advanceQueueInBackground),等它跑完再关库,免得关库后它
  // 再醒来刷一串「database is not open」。
  await new Promise((resolve) => setTimeout(resolve, 300));
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
}
