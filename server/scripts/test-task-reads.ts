// 任务「看过没有」的后端回归(为什么进库见 server/src/db/schema-task-reads.ts):
//  · 写进去读得回来，谁后到谁算数，看的时刻按服务端的钟记(设备的钟快慢都不作数)；
//  · 一个人一份，别人的读不到、也收不到别人的「记录变了」信号；
//  · 坏请求体不 500，条数裁到上限，删任务连这几行一起收。
//
// 跑：npx tsx server/scripts/test-task-reads.ts
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { ServerEvent } from "@ash/shared";
import { requireTmpDb, releaseTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "ash-task-reads-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
requireTmpDb("task-reads");

const [{ db, ensureSchema }, schema, readRoutes, { TASK_READS_MAX }, { bus }, context, { makeEventFilter }] = await Promise.all([
  import("../src/db/index.js"),
  import("../src/db/schema.js"),
  import("../src/task-reads.js"),
  import("@ash/shared/task-reads"),
  import("../src/bus.js"),
  import("../src/auth/context.js"),
  import("../src/auth/event-filter.js"),
]);
const { taskReads } = schema;
type Actor = import("../src/auth/context.js").Actor;

await ensureSchema();

const userActor = (userId: string): Actor => ({ kind: "user", userId, role: "member", name: userId });
let actor: Actor = context.SINGLE_ACTOR;
const api = new Hono();
api.use("*", async (c, next) => { context.setActor(c, actor); await next(); });
readRoutes.mountTaskReadRoutes(api);

const events: ServerEvent[] = [];
bus.subscribe((event) => { events.push(event); });

const call = async (path: string, init?: RequestInit) => {
  const response = await api.request(`http://x${path}`, init);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
};
const put = (body: unknown) =>
  call("/task-reads", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const reads = async () => (await call("/task-reads")).body.reads as Record<string, { event: string; readAt: number }>;

// ── 读写 ────────────────────────────────────────────────────────────────────
assert.deepEqual(await reads(), {}, "什么都没看过：空的");
{
  const start = Date.now();
  const res = await put({ reads: { t1: { event: "done:a", readAt: 1 } } });
  assert.equal(res.status, 200);
  assert.equal(res.body.reads.t1.event, "done:a", "回执就是写完以后的整份");
  assert.ok(res.body.reads.t1.readAt >= start && res.body.reads.t1.readAt <= Date.now(), "看的时刻按服务端此刻记");
  assert.deepEqual(events.at(-1), { type: "task.reads", ownerUserId: null }, "写完要叫这个人的其它页面重拉");
}

// ── 谁后到谁算数，设备的钟不作数 ─────────────────────────────────────────────────
{
  // 钟慢一小时的设备刚看过新一轮：照样写进去(拿它的钟比先后，这一下会被当成「更早」丢掉)。
  await put({ reads: { t1: { event: "done:b", readAt: Date.now() - 3_600_000 } } });
  assert.equal((await reads()).t1!.event, "done:b", "钟慢的设备后到，也算数");
  const start = Date.now();
  await put({ reads: { t2: { event: "done:x", readAt: start + 3_600_000 } } });
  const saved = (await reads()).t2!;
  assert.ok(saved.readAt <= Date.now() && saved.readAt >= start, `钟快的设备不能把时刻写到未来：${saved.readAt}`);
}

// ── 坏请求体 ────────────────────────────────────────────────────────────────
{
  const count = events.length;
  for (const body of [null, 3, "x", [], { reads: null }, { reads: [1] }, { reads: { t9: { event: 1, readAt: 1 } } }]) {
    const res = await put(body);
    assert.equal(res.status, 200, `坏请求体 ${JSON.stringify(body)} 不该 500`);
  }
  const bad = await call("/task-reads", { method: "PUT", headers: { "content-type": "application/json" }, body: "{oops" });
  assert.equal(bad.status, 200, "解析不了的 JSON 也不 500");
  assert.equal((await reads()).t9, undefined, "形状不对的那条不落库");
  assert.equal(events.length, count, "什么都没写就不叫别人重拉");
}

// ── 一个人一份 ──────────────────────────────────────────────────────────────
{
  actor = userActor("alice");
  assert.deepEqual(await reads(), {}, "alice 看不到本机那份");
  await put({ reads: { t1: { event: "done:alice", readAt: Date.now() } } });
  assert.deepEqual(events.at(-1), { type: "task.reads", ownerUserId: "alice" });
  actor = userActor("bob");
  assert.deepEqual(await reads(), {}, "bob 看不到 alice 那份");
  actor = context.SINGLE_ACTOR;
  assert.equal((await reads()).t1!.event, "done:b", "alice 写的不影响本机那份");

  const alice = makeEventFilter(userActor("alice"));
  const bob = makeEventFilter(userActor("bob"));
  const single = makeEventFilter(context.SINGLE_ACTOR);
  await Promise.all([alice.refresh(), bob.refresh(), single.refresh()]);
  const signal: ServerEvent = { type: "task.reads", ownerUserId: "alice" };
  assert.equal(alice.allow(signal), true, "alice 自己的信号推给她");
  assert.equal(bob.allow(signal), false, "别人的信号不推给 bob");
  assert.equal(single.allow(signal), false, "自用身份也不收 alice 的信号");
  assert.equal(single.allow({ type: "task.reads", ownerUserId: null }), true, "自用模式自己那份照推");
  for (const filter of [alice, bob, single]) filter.stop();
}

// ── 裁到上限 ────────────────────────────────────────────────────────────────
{
  actor = userActor("carol");
  const base = Date.now() - 1_000_000;
  const many = Object.fromEntries(
    Array.from({ length: TASK_READS_MAX + 20 }, (_, i) => [`m${i}`, { event: `done:${i}`, readAt: base + i }]),
  );
  await put({ reads: many });
  let saved = await reads();
  assert.equal(Object.keys(saved).length, TASK_READS_MAX, "一次送超了：只留上限那么多条");
  assert.equal(saved.m0, undefined, "留下的是后看的那几条");
  await new Promise((resolve) => setTimeout(resolve, 5));
  await put({ reads: { fresh: { event: "done:fresh", readAt: Date.now() } } });
  saved = await reads();
  assert.equal(Object.keys(saved).length, TASK_READS_MAX, "再写一条也不超");
  assert.ok(saved.fresh, "新写的那条留下");
  actor = context.SINGLE_ACTOR;
}

// ── 删任务连已读记录一起收 ─────────────────────────────────────────────────────
{
  const source = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../src/task-delete-routes.ts", import.meta.url), "utf8"));
  assert.match(source, /db\.delete\(taskReads\)\.where\(eq\(taskReads\.taskId, taskId\)\)/, "删任务要清掉各人的已读记录");
  await db.delete(taskReads).where(eq(taskReads.taskId, "t1"));
  assert.equal((await reads()).t1, undefined);
}

await releaseTmpDb();
rmSync(root, { recursive: true, force: true });
console.log("✓ task reads");
