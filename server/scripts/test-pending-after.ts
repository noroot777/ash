// 「等某任务完成后发送」(mode=after)与「已结束任务不能入队」的回归。
//   ① 纯判定:afterGateOf / isDueForDelivery / deliveryVerdict / finishedMembers
//   ② 落库:/reply 带 afterTaskId 的校验与落行(含原生命令不当场执行、团队调度台拒收)、
//      withAfterGates 批量贴判定并补锁存、完成锁存后前置重跑也撤不回、续聊中的已完成任务不算完成、
//      hasDeliverablePendingMessages 不把没等到前置任务的消息算成「该发」、send-now 改成排队、
//      前置任务的终态钩子(flushPendingAfterTask)按事件锁存并把等它的消息扫一遍
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
const { afterGateOf, flushPendingAfterTask, withAfterGates } = await import("../src/pending-after.js");
const { deliveryVerdict, isDueForDelivery } = await import("../src/pending-verdict.js");
const { enqueueMessage, hasDeliverablePendingMessages } = await import("../src/pending-messages.js");
const { finishedMembers, mountQueueRoutes } = await import("../src/queues.js");
const { replyToTask } = await import("../src/task-reply.js");
const { mountTaskRunRoutes } = await import("../src/task-run-routes.js");
await ensureSchema();

try {
  // ── ① 纯判定 ──────────────────────────────────────────────────────────────
  const facts = (status: string, extra: Partial<NonNullable<Parameters<typeof afterGateOf>[1]>> = {}) =>
    ({ id: "p", title: "前置", mode: "single", status, archived: false, endedAt: null, ...extra });
  assert.equal(afterGateOf(null, facts("done", { endedAt: "2026-11-04T00:00:00.000Z" })).afterDone, true);
  assert.equal(afterGateOf(null, facts("done", { endedAt: "2026-11-04T00:00:00.000Z" })).afterEndedAt, "2026-11-04T00:00:00.000Z");
  for (const status of ["backlog", "running", "queued", "paused", "awaiting_review", "failed", "canceled"]) {
    const gate = afterGateOf(null, facts(status));
    assert.equal(gate.afterDone, false, `${status} 不算完成`);
    assert.ok(gate.afterWaitReason, `${status} 要说清在等什么`);
  }
  assert.match(afterGateOf(null, facts("canceled")).afterWaitReason!, /重跑完成后才会发/);
  assert.match(afterGateOf(null, facts("paused", { archived: true })).afterWaitReason!, /已归档/);
  assert.match(afterGateOf(null, null).afterWaitReason!, /已删除/);
  assert.match(afterGateOf(null, facts("idle", { mode: "team" })).afterWaitReason!, /团队调度台/, "调度台收工落 idle,不会完成");
  // 锁存优先于此刻的状态:等到过就是等到了,前置任务被删/重跑/失败都不撤回。
  for (const task of [null, facts("running"), facts("failed")]) {
    const gate = afterGateOf("2026-11-04T09:00:00.000Z", task);
    assert.equal(gate.afterDone, true);
    assert.equal(gate.afterEndedAt, "2026-11-04T09:00:00.000Z");
  }

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
    { ...task("lead", "idle"), mode: "team" }, { ...task("fu", "running"), followUpFrom: "done" }, task("pre2", "running"),
    task("q-head", "running"), task("q-done", "done"), task("q-canceled", "canceled"), task("q-fresh", "backlog"),
  ] as never);

  const api = new Hono();
  api.post("/tasks/:id/reply", (c) => replyToTask(c, c.req.param("id")));
  mountTaskRunRoutes(api);
  mountQueueRoutes(api);
  // 投递扫描是后台跑的:轮询到这一行离开 pending(或超时)为止,返回最后看到的状态。
  const settled = async (messageId: string) => {
    let status = "pending";
    for (let i = 0; i < 40 && status === "pending"; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      status = (await db.select().from(scheduledMessages).where(eq(scheduledMessages.id, messageId))).at(0)!.status;
    }
    return status;
  };
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
  assert.equal((await post("/tasks/me/reply", { text: "x", afterTaskId: "lead" })).status, 400, "团队调度台等不到完成,拒收");
  assert.equal((await post("/tasks/me/reply", { text: "x", sendAt: "2000-01-01T00:00:00.000Z" })).status, 400, "定时须是将来");
  // 原生命令选了「等任务完成」:不当场执行,落成待发送消息;不合法的延期请求在命令之前就拦下。
  assert.equal((await post("/tasks/me/reply", { text: "/goal", afterTaskId: "me" })).status, 400, "命令也先过延期校验");
  const command = await post("/tasks/me/reply", { text: "/goal", afterTaskId: "pre" });
  assert.equal(command.status, 202, `原生命令不能当场执行:${JSON.stringify(command.body)}`);
  assert.equal(command.body.command, undefined);
  assert.equal((command.body.message as { mode: string }).mode, "after");
  await db.update(scheduledMessages).set({ status: "canceled" })
    .where(eq(scheduledMessages.id, (command.body.message as { id: string }).id));

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
  assert.equal((await db.select().from(scheduledMessages).where(eq(scheduledMessages.id, message.id))).at(0)!.afterDoneAt,
    "2026-11-04T10:00:00.000Z", "读到 done 就补锁存");
  // 本任务还忙着、前置随后又被重跑(以至失败):已经等到的完成不能被撤回。
  await db.update(tasks).set({ status: "running", endedAt: null }).where(eq(tasks.id, "pre"));
  const latched = (await db.select().from(scheduledMessages).where(eq(scheduledMessages.id, message.id))).at(0)!;
  assert.equal((await withAfterGates([latched]))[0]!.afterDone, true, "前置重跑不撤回已等到的完成");
  await db.update(tasks).set({ status: "failed" }).where(eq(tasks.id, "pre"));
  assert.equal(await hasDeliverablePendingMessages("me"), true, "前置重跑后失败也不撤回");

  // 已完成任务正在处理新消息(续聊):候选里显示「运行中」,这里也不算完成,不锁存。
  const followUp = await enqueueMessage({ taskId: "me", text: "等 fu 这一轮", mode: "after", afterTaskId: "fu" });
  const [fuGate] = await withAfterGates([followUp]);
  assert.equal(fuGate!.afterDone, false, "续聊中的已完成任务不算完成");
  assert.equal((await db.select().from(scheduledMessages).where(eq(scheduledMessages.id, followUp.id))).at(0)!.afterDoneAt, null);
  await db.update(scheduledMessages).set({ status: "canceled" }).where(eq(scheduledMessages.id, followUp.id));

  // 「不等了」:改成普通排队消息,依赖清掉;再按一次是 409。
  await db.update(tasks).set({ status: "canceled" }).where(eq(tasks.id, "pre"));
  await db.update(tasks).set({ archived: true }).where(eq(tasks.id, "me"));
  const released = await post(`/scheduled-messages/${message.id}/send-now`, {});
  assert.equal(released.status, 200);
  const after = (await db.select().from(scheduledMessages).where(eq(scheduledMessages.id, message.id))).at(0)!;
  assert.equal(after.mode, "queued");
  assert.equal(after.afterTaskId, null);
  assert.equal((await post(`/scheduled-messages/${message.id}/send-now`, {})).status, 409);
  // send-now 触发的那一扫(任务已归档 → 取消)先收完,下面那条才是干净的现场。
  assert.equal(await settled(message.id), "canceled");

  // 前置任务落终态的钩子会扫「等它的那些消息所在的任务」:me 已归档,扫描判取消 ——
  // 取消落库就证明这一扫确实因 pre 而发生(不靠 30s tick)。
  const waiting = await enqueueMessage({ taskId: "me", text: "第二句", mode: "after", afterTaskId: "pre" });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal((await db.select().from(scheduledMessages).where(eq(scheduledMessages.id, waiting.id))).at(0)!.status,
    "pending", "没有触发就没人扫它");
  await flushPendingAfterTask("pre", "canceled");
  assert.equal(await settled(waiting.id), "canceled", "前置任务的终态钩子要把等它的消息所在任务扫一遍");

  // 落 done 的那个事件就锁存 —— 哪怕库里那一行随后已经又变回 running(紧接着被重跑)。
  const latchOnEvent = await enqueueMessage({ taskId: "me", text: "第三句", mode: "after", afterTaskId: "pre2" });
  await flushPendingAfterTask("pre2", "done");
  assert.ok((await db.select().from(scheduledMessages).where(eq(scheduledMessages.id, latchOnEvent.id))).at(0)!.afterDoneAt,
    "终态钩子落 done 即锁存");
  await settled(latchOnEvent.id);

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
