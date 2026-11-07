// 任务停下来的那一刻，机器自己马上就会接着跑：不推「等你验收」，免得一张卡发出去转眼就撤回（理由见 reconcile.ts 文件头、
// shared task-attention.ts humanTurnOf）。
//
// 钉住的几件事：
// ① 状态落了 done、回合锁还占着（这一轮还在结算）→ 不推；锁一放开自己再对一次，没人接着跑就推出去；
// ② 锁放开的那一下就被下一轮占上（预约的审查）→ 一张卡都不推，状态落 running 也没有卡要撤；
// ③ 托盘里排着马上要送进去的消息（审查没过的修复意见）→ 不推；消息送走、任务又停下来才推；
// ④ 卡已经发出去，又排进一条马上要送的消息 → 撤回那张卡；
// ⑤ 定在以后的定时消息不算：照常推；
// ⑥ 失败卡同理：排着消息的失败任务不推失败卡。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireTmpDb, releaseTmpDb } from "./tmp-db.js";

const stage = mkdtempSync(join(tmpdir(), "ash-im-settling-"));
process.env.ASH_DB = join(stage, "ash.db");
process.env.ASH_RUNS_DIR = join(stage, "runs");
requireTmpDb("test-im-settling");

let failure: unknown = null;
try {
  const { db, ensureSchema } = await import("../src/db/index.js");
  const { projects, scheduledMessages, tasks } = await import("../src/db/schema.js");
  const { imBindings, imOutbox } = await import("../src/db/schema-im.js");
  const { claimOwnTurn, releaseTurn } = await import("../src/turn-lock.js");
  const { eq } = await import("drizzle-orm");
  const { APP, OWNER, FakeFeishu, buildApp, assemble } = await import("./im-fixture.js");

  await ensureSchema();
  const fake = new FakeFeishu();
  const im = await assemble(buildApp(), fake);
  const at = new Date().toISOString();
  mkdirSync(join(stage, "repo"), { recursive: true });
  await db.insert(projects).values({ id: "p1", name: "飞书项目", repoPath: join(stage, "repo"), apiKeys: null, createdAt: at } as never);
  await db.insert(imBindings).values({ channel: "feishu", appId: APP, openId: OWNER, userId: null, boundAt: at });
  const task = (over: Record<string, unknown>) => ({ projectId: "p1", body: "", createdAt: at, updatedAt: at, ...over });
  const message = (over: Record<string, unknown>) => ({
    text: "继续", sendAt: at, status: "pending", mode: "queued", createdAt: at, ...over,
  });
  const rowsOf = (taskId: string) => db.select().from(imOutbox).where(eq(imOutbox.taskId, taskId));
  const reconcile = async (taskId: string) => {
    await im.reconciler.reconcile([taskId]);
    await im.settle();
  };

  // ── ① 回合锁还占着：先不推，锁放开再推 ─────────────────────────────────
  await db.insert(tasks).values(task({ id: "ta", title: "结算中", status: "running" }) as never);
  const settling = claimOwnTurn("ta")!;
  await db.update(tasks).set({ status: "done", endedAt: at } as never).where(eq(tasks.id, "ta"));
  await reconcile("ta");
  await reconcile("ta");
  assert.equal((await rowsOf("ta")).length, 0, "这一轮还在结算：不推");
  releaseTurn("ta", settling);
  await im.settle();
  const ta = await rowsOf("ta");
  assert.equal(ta.length, 1, "锁放开自己再对一次：同一把锁只挂一次，推一张");
  assert.equal(ta[0]!.kind, "accept");
  assert.ok(ta[0]!.messageId, "发出去了");

  // ── ② 锁一放开就被下一轮占上（预约的审查）：一张都不推 ─────────────────
  await db.insert(tasks).values(task({ id: "tb", title: "接着审查", status: "running" }) as never);
  const executor = claimOwnTurn("tb")!;
  await db.update(tasks).set({ status: "done", endedAt: at } as never).where(eq(tasks.id, "tb"));
  await reconcile("tb");
  let reviewer: ReturnType<typeof claimOwnTurn> = null;
  // 预约的审查排在放锁那一下同步占位（turn-idle-delivery.ts continueWhenIdle）。
  const { whenTurnIdle } = await import("../src/turn-lock.js");
  whenTurnIdle("tb", () => { reviewer = claimOwnTurn("tb", "reviewer"); });
  releaseTurn("tb", executor);
  assert.ok(reviewer, "审查占上了");
  await im.settle();
  assert.equal((await rowsOf("tb")).length, 0, "下一轮已经占了位：不推");
  await db.update(tasks).set({ status: "running" } as never).where(eq(tasks.id, "tb"));
  await reconcile("tb");
  assert.equal((await rowsOf("tb")).length, 0);
  assert.equal(fake.recalls().length, 0, "没推过就没有要撤的");
  releaseTurn("tb", reviewer!);
  await im.settle();

  // ── ③ 托盘里排着马上要送的消息：不推；送走、又停下来才推 ───────────────
  await db.insert(tasks).values(task({ id: "tc", title: "审查没过", status: "done", endedAt: at }) as never);
  await db.insert(scheduledMessages).values(message({ id: "mc", taskId: "tc", origin: "review-settlement:r1", text: "按审查意见修复" }) as never);
  await reconcile("tc");
  assert.equal((await rowsOf("tc")).length, 0, "修复意见马上就送进去：不推");
  await db.update(scheduledMessages).set({ status: "sent", sentAt: at } as never).where(eq(scheduledMessages.id, "mc"));
  await reconcile("tc");
  assert.equal((await rowsOf("tc")).length, 1, "托盘空了、任务停着：推");

  // ── ④ 卡发出去之后又排进一条：撤回 ─────────────────────────────────────
  const taRow = (await rowsOf("ta"))[0]!;
  fake.reset();
  await db.insert(scheduledMessages).values(message({ id: "ma", taskId: "ta", text: "再改一处" }) as never);
  await reconcile("ta");
  assert.equal(fake.recalls().filter((call) => call.path.endsWith(`/messages/${taRow.messageId}`)).length, 1, "马上要接着跑：撤回");
  assert.equal((await rowsOf("ta"))[0]!.patchState, "recalled");

  // ── ⑤ 定在以后的定时消息不算 ───────────────────────────────────────────
  await db.insert(tasks).values(task({ id: "td", title: "明天再说", status: "done", endedAt: at }) as never);
  await db.insert(scheduledMessages).values(message({
    id: "md", taskId: "td", mode: "timed", sendAt: new Date(Date.now() + 86_400_000).toISOString(),
  }) as never);
  await reconcile("td");
  const td = await rowsOf("td");
  assert.equal(td.length, 1, "还没到钟点：照常推");
  assert.equal(td[0]!.kind, "accept");

  // ── ⑥ 失败卡同理 ───────────────────────────────────────────────────────
  await db.insert(tasks).values(task({ id: "te", title: "失败了还排着话", status: "failed", endedAt: at }) as never);
  await db.insert(scheduledMessages).values(message({ id: "me", taskId: "te" }) as never);
  await reconcile("te");
  assert.equal((await rowsOf("te")).length, 0, "排着的话一送进去就接着跑：不推失败卡");
  await db.update(scheduledMessages).set({ status: "canceled" } as never).where(eq(scheduledMessages.id, "me"));
  await reconcile("te");
  const te = await rowsOf("te");
  assert.equal(te.length, 1);
  assert.equal(te[0]!.kind, "failed");

  im.reconciler.stop();
  im.sender.stop();
  console.log("test-im-settling: ok");
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
