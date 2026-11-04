// 「等某任务完成后发送」(mode=after)与「已结束任务不能入队」的回归。
//   ① 纯判定:afterBaselineOf / afterGateOf / isDueForDelivery / deliveryVerdict / finishedMembers
//   ② 落库:/reply 带 afterTaskId 的校验与落行(含原生命令不当场执行、团队调度台拒收、登记基线)、
//      只有声明为完成的那一笔 done 才加计数(真实结算:续聊被停止/出错/提问只是放回原状态,
//      正常结束才算)、withAfterGates 按计数判定并按消息补锁存、完成后崩溃再重跑也撤不回、
//      迟到的完成处理不带走续聊期间新排下的消息、登记与依赖校验同一 batch(前置不在就落不下)、
//      删前置时锁存与删行同一 batch、
//      hasDeliverablePendingMessages 不把没等到前置任务的消息算成「该发」、send-now 改成排队、
//      前置任务的终态钩子(flushPendingAfterTask)确实把等它的消息扫一遍
//   ③ 队列写入口:insert / create 拒绝已结束的任务
// 全程不投递,不会拉起真 agent:接收任务在消息到期之前就置成 running;send-now 那一下会触发
// 一次扫描,所以先把任务归档,让扫描判「取消」而不是续跑;队列那一组的队头是 running,推进
// 不会再拉起任何成员。
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
const { AfterTargetGoneError, afterBaselineOf, afterGateOf, flushPendingAfterTask, withAfterGates } = await import("../src/pending-after.js");
const { settleTaskStatus } = await import("../src/settle-status.js");
const { setTaskStatus } = await import("../src/status.js");
const { deleteTaskCompletely } = await import("../src/task-delete-routes.js");
const { deliveryVerdict, isDueForDelivery } = await import("../src/pending-verdict.js");
const { enqueueMessage, hasDeliverablePendingMessages } = await import("../src/pending-messages.js");
const { finishedMembers, mountQueueRoutes } = await import("../src/queues.js");
const { replyToTask } = await import("../src/task-reply.js");
const { mountTaskRunRoutes } = await import("../src/task-run-routes.js");
await ensureSchema();

try {
  // ── ① 纯判定 ──────────────────────────────────────────────────────────────
  const facts = (status: string, extra: Partial<NonNullable<Parameters<typeof afterGateOf>[1]>> = {}) =>
    ({ id: "p", title: "前置", mode: "single", status, archived: false, endedAt: null, doneSeq: 0, ...extra });
  const wait = (afterSeq: number | null) => ({ afterDoneAt: null, afterSeq });
  // 基线:停在 done 上 = 那次完成就算;在跑(含已完成任务的续聊)= 等下一次。
  assert.equal(afterBaselineOf({ status: "done", doneSeq: 3 }), 2);
  assert.equal(afterBaselineOf({ status: "running", doneSeq: 3 }), 3, "续聊中的已完成任务要等这一轮结束");
  assert.equal(afterBaselineOf({ status: "failed", doneSeq: 0 }), 0);
  // 判据只看计数有没有越过基线,不看此刻的状态:完成之后再跑、再失败都还算等到了。
  for (const status of ["done", "running", "failed", "canceled"]) {
    assert.equal(afterGateOf(wait(2), facts(status, { doneSeq: 3 })).afterDone, true, `越过基线后前置 ${status} 仍算等到`);
  }
  assert.equal(afterGateOf(wait(3), facts("done", { doneSeq: 3 })).afterDone, false, "没越过基线:是更早那次完成");
  assert.equal(afterGateOf(wait(1), facts("done", { doneSeq: 2, endedAt: "2026-11-04T00:00:00.000Z" })).afterEndedAt,
    "2026-11-04T00:00:00.000Z");
  for (const status of ["backlog", "running", "queued", "paused", "awaiting_review", "failed", "canceled"]) {
    const gate = afterGateOf(wait(0), facts(status));
    assert.equal(gate.afterDone, false, `${status} 不算完成`);
    assert.ok(gate.afterWaitReason, `${status} 要说清在等什么`);
  }
  assert.equal(afterGateOf(wait(null), facts("done")).afterDone, true, "升级前没有基线的行退回看状态");
  assert.equal(afterGateOf(wait(null), facts("running")).afterDone, false);
  assert.match(afterGateOf(wait(0), facts("canceled")).afterWaitReason!, /重跑完成后才会发/);
  assert.match(afterGateOf(wait(0), facts("paused", { archived: true })).afterWaitReason!, /已归档/);
  assert.match(afterGateOf(wait(0), null).afterWaitReason!, /已删除/);
  assert.match(afterGateOf(wait(0), facts("idle", { mode: "team" })).afterWaitReason!, /团队调度台/, "调度台收工落 idle,不会完成");
  // 锁存优先于一切:等到过就是等到了,前置任务被删也不撤回。
  for (const task of [null, facts("running"), facts("failed")]) {
    const gate = afterGateOf({ afterDoneAt: "2026-11-04T09:00:00.000Z", afterSeq: 0 }, task);
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
    { ...task("lead", "idle"), mode: "team" }, { ...task("fu", "running"), followUpFrom: "done", doneSeq: 1 },
    task("seq", "running"), task("del", "running"), task("busy", "running"),
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
  // 从这里起让 me 忙着:后面这条消息会到期,me 空闲的话哪次全局扫描碰上它就真去投递(拉起执行器)。
  await db.update(tasks).set({ status: "running" }).where(eq(tasks.id, "me"));
  // 落 done 与完成计数是同一条 UPDATE(状态钩子在这个任务上无事可做:不在队列、没人等它)。
  const seqOf = async (id: string) => (await db.select().from(tasks).where(eq(tasks.id, id))).at(0)!.doneSeq;
  await setTaskStatus("seq", "done", { completion: true });
  assert.equal(await seqOf("seq"), 1);
  await setTaskStatus("seq", "running");
  await setTaskStatus("seq", "done", { completion: true });
  assert.equal(await seqOf("seq"), 2, "每完成一次加一");
  await setTaskStatus("seq", "running");
  await setTaskStatus("seq", "done");
  assert.equal(await seqOf("seq"), 2, "没声明是完成的 done(放回原状态)不加");

  // 真实结算:已完成任务的续聊这一轮被停止、出错、留了提问 —— 状态放回 done,但不是又完成了一次。
  for (const [id, exit, stopped, question] of [
    ["fu-stop", 1, "canceled", null], ["fu-crash", 1, null, null], ["fu-ask", 0, null, "还要你拍板"], ["fu-ok", 0, null, null],
  ] as const) {
    await db.insert(tasks).values({ ...task(id, "running"), followUpFrom: "done", doneSeq: 4, question } as never);
    const waiter = await enqueueMessage({ taskId: "busy", text: id, mode: "after", afterTaskId: id });
    assert.equal(waiter.afterSeq, 4);
    const settlement = await settleTaskStatus(id, exit, stopped);
    assert.equal(settlement.status, "done", `${id}:状态照旧放回 done`);
    const counted = id === "fu-ok";
    assert.equal(await seqOf(id), counted ? 5 : 4, counted ? "续聊正常结束是一次完成" : `${id}:不是一次完成`);
    assert.equal((await withAfterGates([waiter]))[0]!.afterDone, counted, `${id}:等它这一轮的消息${counted ? "等到了" : "照旧等"}`);
  }
  const row = (await db.select().from(scheduledMessages).where(eq(scheduledMessages.id, message.id))).at(0)!;
  assert.equal(row.status, "pending");
  assert.equal(row.execution, false, "等前置任务的消息不是执行型");
  assert.equal(row.afterSeq, 0, "前置在跑:基线是它此刻的计数");

  const [gated] = await withAfterGates([row]);
  assert.equal(gated!.afterDone, false);
  assert.equal(await hasDeliverablePendingMessages("me"), false, "前置没完成,不算「此刻该送」的消息(不挡结算)");

  await db.update(tasks).set({ status: "failed" }).where(eq(tasks.id, "pre"));
  assert.equal(await hasDeliverablePendingMessages("me"), false, "前置失败也不发");
  // 前置落 done(状态与计数同一笔),紧接着进程退出、完成钩子没跑;重启前它又被重跑起来。
  // 计数还在,判得出那次完成 —— 不靠钩子,也不靠扫描恰好赶在重跑之前。
  await db.update(tasks).set({ status: "done", doneSeq: 1, endedAt: "2026-11-04T10:00:00.000Z" }).where(eq(tasks.id, "pre"));
  await db.update(tasks).set({ status: "running", endedAt: null }).where(eq(tasks.id, "pre"));
  assert.equal((await db.select().from(scheduledMessages).where(eq(scheduledMessages.id, message.id))).at(0)!.afterDoneAt, null);
  const [ready] = await withAfterGates([row]);
  assert.equal(ready!.afterDone, true, "完成后崩溃再重跑,已等到的完成不丢");
  assert.ok(ready!.afterDoneAt, "返回的行带上刚补的锁存(托盘不读旧值)");
  assert.ok((await db.select().from(scheduledMessages).where(eq(scheduledMessages.id, message.id))).at(0)!.afterDoneAt, "补锁存落库");
  await db.update(tasks).set({ status: "failed" }).where(eq(tasks.id, "pre"));
  assert.equal(await hasDeliverablePendingMessages("me"), true, "前置重跑后失败也不撤回");

  // 已完成任务正在处理新消息(续聊):候选里显示「运行中」,这里也不算完成。上一次完成的处理
  // 迟到了(钩子此刻才跑)也不能把这条带走 —— 它等的是这一轮之后的那次。
  const followUp = await post("/tasks/me/reply", { text: "等 fu 这一轮", afterTaskId: "fu" });
  assert.equal(followUp.status, 202);
  const followUpId = (followUp.body.message as { id: string }).id;
  const followUpRow = () => db.select().from(scheduledMessages).where(eq(scheduledMessages.id, followUpId)).then((r) => r.at(0)!);
  assert.equal((await followUpRow()).afterSeq, 1, "续聊中:基线是已落过的那一次");
  await flushPendingAfterTask("fu");
  assert.equal((await followUpRow()).afterDoneAt, null, "迟到的完成处理不放行续聊期间新排下的消息");
  assert.equal((await withAfterGates([await followUpRow()]))[0]!.afterDone, false, "续聊中的已完成任务不算完成");
  await db.update(tasks).set({ status: "done", doneSeq: 2, followUpFrom: null }).where(eq(tasks.id, "fu"));
  assert.equal((await withAfterGates([await followUpRow()]))[0]!.afterDone, true, "这一轮落 done 才算");
  await db.update(scheduledMessages).set({ status: "canceled" }).where(eq(scheduledMessages.id, followUpId));

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
  await flushPendingAfterTask("pre");
  assert.equal(await settled(waiting.id), "canceled", "前置任务的终态钩子要把等它的消息所在任务扫一遍");

  // 登记跟依赖校验同一个 batch:前置不在、不在同一项目、是调度台,这一行都落不下(不靠调用方先核过)。
  for (const gone of ["nope", "other", "lead"]) {
    await assert.rejects(enqueueMessage({ taskId: "me", text: gone, mode: "after", afterTaskId: gone }), AfterTargetGoneError);
  }
  assert.equal((await db.select().from(scheduledMessages).where(eq(scheduledMessages.text, "nope"))).length, 0, "落不下就一行不留");

  // 删前置时锁存与删行同一批:删了就查不到它完成过。没等到的那条照旧等(托盘显示不存在、给直接发送)。
  const doneBeforeDelete = await enqueueMessage({ taskId: "me", text: "删前已等到", mode: "after", afterTaskId: "del" });
  // 直接改库,不走 setTaskStatus:它的终态钩子会先把等到的锁存掉,就证明不了删除那一批自己会锁。
  await db.update(tasks).set({ status: "done", doneSeq: 1 }).where(eq(tasks.id, "del"));
  const notYet = await enqueueMessage({ taskId: "me", text: "删前没等到", mode: "after", afterTaskId: "del" });
  await db.update(tasks).set({ status: "running" }).where(eq(tasks.id, "del"));
  assert.equal(notYet.afterSeq, 0, "停在 done 上登记:基线退一格");
  await db.update(scheduledMessages).set({ afterSeq: 1 }).where(eq(scheduledMessages.id, notYet.id));
  const legacy = await enqueueMessage({ taskId: "me", text: "升级前的行", mode: "after", afterTaskId: "del" });
  await db.update(scheduledMessages).set({ afterSeq: null }).where(eq(scheduledMessages.id, legacy.id));
  await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, "del"));
  await deleteTaskCompletely("del");
  const afterDelete = async (mid: string) => (await db.select().from(scheduledMessages).where(eq(scheduledMessages.id, mid))).at(0)!;
  assert.ok((await afterDelete(doneBeforeDelete.id)).afterDoneAt, "删除前已等到的完成被锁存");
  assert.equal((await withAfterGates([await afterDelete(doneBeforeDelete.id)]))[0]!.afterDone, true);
  assert.equal((await afterDelete(notYet.id)).afterDoneAt, null);
  assert.match((await withAfterGates([await afterDelete(notYet.id)]))[0]!.afterWaitReason!, /已删除/);
  assert.ok((await afterDelete(legacy.id)).afterDoneAt, "没有基线的老行:前置停在 done 上被删也锁存");

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
