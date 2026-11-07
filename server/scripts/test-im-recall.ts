// 卡上那件事在别处了结、任务接着跑了：撤回那张卡，不在聊天里留一张「继续在跑」的灰卡（理由见 reconcile.ts、outbox.ts 的文件头）。
//
// 钉住的几件事：
// ① 网页上答了、任务接着跑 → 撤回那条消息，不另改卡；那一行记成撤回了；
// ② 撤不回（发出超过一天，飞书回 230009）→ 退回成改卡，卡上换成收好的样子；
// ③ 待验收的任务又跑了一轮、成果没变又回到待验收 → 撤回的那条在飞书上已经没了：作废那一行、另推一条新消息，
//    不去改那条撤回的；
// ④ 不是「接着跑」的了结（在别处答了、任务停着）照旧改卡，不撤回。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireTmpDb, releaseTmpDb } from "./tmp-db.js";

const stage = mkdtempSync(join(tmpdir(), "ash-im-recall-"));
process.env.ASH_DB = join(stage, "ash.db");
process.env.ASH_RUNS_DIR = join(stage, "runs");
requireTmpDb("test-im-recall");

let failure: unknown = null;
try {
  const { db, ensureSchema } = await import("../src/db/index.js");
  const { projects, tasks } = await import("../src/db/schema.js");
  const { imBindings, imOutbox } = await import("../src/db/schema-im.js");
  const { eq } = await import("drizzle-orm");
  const { APP, OWNER, FakeFeishu, buildApp, assemble, textOf } = await import("./im-fixture.js");

  await ensureSchema();
  const fake = new FakeFeishu();
  const im = await assemble(buildApp(), fake);
  const at = new Date().toISOString();
  mkdirSync(join(stage, "repo"), { recursive: true });
  await db.insert(projects).values({ id: "p1", name: "飞书项目", repoPath: join(stage, "repo"), apiKeys: null, createdAt: at } as never);
  const task = (over: Record<string, unknown>) => ({ projectId: "p1", body: "", createdAt: at, updatedAt: at, ...over });
  await db.insert(imBindings).values({ channel: "feishu", appId: APP, openId: OWNER, userId: null, boundAt: at });
  await db.insert(tasks).values([
    task({ id: "tr", title: "答了接着跑", status: "paused", question: "继续吗？" }),
    task({ id: "to", title: "太久撤不回", status: "paused", question: "还继续吗？" }),
    task({ id: "ts", title: "答了停着", status: "paused", question: "停一下？" }),
    task({ id: "tb", title: "又跑了一轮", status: "done", endedAt: at }),
  ] as never);
  await im.reconciler.full();
  await im.settle();
  const rowsOf = (taskId: string) => db.select().from(imOutbox).where(eq(imOutbox.taskId, taskId));
  const first = async (taskId: string) => (await rowsOf(taskId))[0]!;
  const [trRow, toRow, tsRow, tbRow] = await Promise.all(["tr", "to", "ts", "tb"].map(first));
  for (const row of [trRow, toRow, tsRow, tbRow]) assert.ok(row.messageId, `${row.taskId} 的卡发出去了`);
  assert.equal(tbRow.kind, "accept");
  const recallsOf = (messageId: string) => fake.recalls().filter((call) => call.path.endsWith(`/messages/${messageId}`));
  const patchesOf = (messageId: string) => fake.patches().filter((call) => call.path.includes(messageId));
  const settleTask = async (taskId: string, set: Record<string, unknown>) => {
    await db.update(tasks).set(set as never).where(eq(tasks.id, taskId));
    fake.reset();
    await im.reconciler.reconcile([taskId]);
    await im.settle();
  };

  // ── ① 网页上答了、任务接着跑：撤回 ───────────────────────────────────────
  await settleTask("tr", { question: null, status: "running" });
  assert.equal(recallsOf(trRow.messageId!).length, 1, "开始跑了不用告诉人：撤回那张卡");
  assert.equal(patchesOf(trRow.messageId!).length, 0, "不另改成一张灰卡");
  const recalled = await first("tr");
  assert.equal(recalled.state, "resolved");
  assert.equal(recalled.patchState, "recalled");
  await im.reconciler.full();
  await im.settle();
  assert.equal(recallsOf(trRow.messageId!).length, 1, "撤回过的不再撤");

  // ── ② 撤不回：退回成改卡 ─────────────────────────────────────────────────
  fake.recallCode = 230009;
  await settleTask("to", { question: null, status: "running" });
  fake.recallCode = 0;
  assert.equal(recallsOf(toRow.messageId!).length, 1);
  assert.equal(patchesOf(toRow.messageId!).length, 1, "撤不回就改卡");
  assert.match(textOf(JSON.parse(patchesOf(toRow.messageId!)[0]!.body.content)), /已答复，任务继续在跑/);
  assert.notEqual((await first("to")).patchState, "recalled");

  // ── ③ 撤回之后同一件事又回来了：另推一条新的 ─────────────────────────────
  await settleTask("tb", { status: "running" });
  assert.equal(recallsOf(tbRow.messageId!).length, 1, "待验收的任务又开始跑了：撤回");
  await settleTask("tb", { status: "done" });
  const back = await rowsOf("tb");
  assert.equal(back.length, 1, "撤回的那一行作废，换成新的一行");
  assert.equal(back[0]!.state, "sent");
  assert.notEqual(back[0]!.id, tbRow.id, "新行（新 uuid，飞书按 uuid 判重）");
  assert.notEqual(back[0]!.messageId, tbRow.messageId, "推的是一条新消息");
  assert.equal(fake.sends().length, 1);
  assert.equal(patchesOf(tbRow.messageId!).length, 0, "不去改那条已经撤回的");

  // ── ④ 在别处答了、任务停着：照旧改卡 ─────────────────────────────────────
  await settleTask("ts", { question: null });
  assert.equal(recallsOf(tsRow.messageId!).length, 0, "不是接着跑：不撤回");
  assert.match(textOf(JSON.parse(patchesOf(tsRow.messageId!)[0]!.body.content)), /已在别处答复/);

  im.reconciler.stop();
  im.sender.stop();
  console.log("test-im-recall: ok");
} catch (error) {
  failure = error;
} finally {
  await new Promise((resolve) => setTimeout(resolve, 300));
  await releaseTmpDb();
  rmSync(stage, { recursive: true, force: true });
}
if (failure) {
  console.error(failure);
  process.exit(1);
}
