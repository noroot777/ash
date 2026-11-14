// 任务「看过没有」的后端回归(为什么进库见 server/src/db/schema-task-reads.ts，新旧口径见 shared/src/task-reads.ts):
//  · 新旧只认 round：迟到的旧一轮(断网后补送、停在旧数据上的页面)盖不掉已经记下的新一轮；
//  · round 按库里任务此刻的轮次封顶(团队看执行者)，不存在 / 看不见的任务不写、列在 rejected 里；
//  · 一个人一份，回执带 owner；PUT 写明的账号跟认证出来的人对不上就 409、一条不写(审查第 2 轮 F1)；
//    别人的读不到、也收不到别人的「记录变了」信号；
//  · 回执带 rev，每写一次加一(前端据此丢先发后到的旧回执)；
//  · 满额时留最近看到的：刚看过的旧任务留得住(审查第 2 轮 F3)；
//  · 坏请求体不 500，删任务连这几行一起收。
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

const [{ db, ensureSchema }, schema, readRoutes, { TASK_READS_MAX }, { bus }, context, { makeEventFilter }, { deleteTaskCompletely }] = await Promise.all([
  import("../src/db/index.js"),
  import("../src/db/schema.js"),
  import("../src/task-reads.js"),
  import("@ash/shared/task-reads"),
  import("../src/bus.js"),
  import("../src/auth/context.js"),
  import("../src/auth/event-filter.js"),
  import("../src/task-delete-routes.js"),
]);
const { projects, taskReads, tasks } = schema;
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
const putRaw = (body: unknown) =>
  call("/task-reads", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
/** 照前端那样写明「这批是谁看的」：当前身份的那个人。 */
const ownerNow = () => context.ownerIdOf(actor) ?? "";
const put = (body: { reads: unknown }) => putRaw({ owner: ownerNow(), ...body });
const reads = async () => (await call("/task-reads")).body.reads as Record<string, { event: string; round: number }>;

const T0 = Date.parse("2026-11-13T00:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const created = iso(T0 - 60_000);
await db.insert(projects).values({ id: "p1", name: "reads", repoPath: root, createdAt: created });
const addTask = (id: string, updatedMs: number, extra: Partial<typeof tasks.$inferInsert> = {}) =>
  db.insert(tasks).values({
    id, projectId: "p1", title: id, body: "", status: "done", mode: "single", createdAt: created, updatedAt: iso(updatedMs), ...extra,
  });
await addTask("t1", T0);
await addTask("t2", T0);
await addTask("lead", T0, { mode: "team", status: "idle" });
await addTask("w1", T0 + 5_000, { parentId: "lead" });

// ── 读写 ────────────────────────────────────────────────────────────────────
{
  const empty = await call("/task-reads");
  assert.deepEqual(empty.body, { owner: "", rev: 0, reads: {} }, "什么都没看过：空的；自用模式 owner 是空串");
  const res = await put({ reads: { t1: { event: "done:a", round: T0 } } });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { owner: "", rev: 1, reads: { t1: { event: "done:a", round: T0 } }, rejected: [] }, "回执就是写完以后的整份");
  await put({ reads: { t1: { event: "done:a", round: T0 } } });
  assert.equal((await call("/task-reads")).body.rev, 2, "每写一次 rev 加一");
  assert.deepEqual(events.at(-1), { type: "task.reads", ownerUserId: null }, "写完要叫这个人的其它页面重拉");
}

// ── 迟到的旧一轮盖不掉新一轮(审查第 1 轮 F1 的复现：A 断网，B 看了新一轮，A 恢复后补送旧的) ───────
{
  await db.update(tasks).set({ updatedAt: iso(T0 + 60_000) }).where(eq(tasks.id, "t1"));
  await put({ reads: { t1: { event: "done:b", round: T0 + 60_000 } } }); // B 看了新一轮
  await put({ reads: { t1: { event: "done:a", round: T0 } } }); // A 补送断网前那一批
  assert.deepEqual((await reads()).t1, { event: "done:b", round: T0 + 60_000 }, "补送的旧一轮不许盖掉新一轮");
}

// ── 封顶 / 不存在 ────────────────────────────────────────────────────────────
{
  await put({ reads: { t2: { event: "done:future", round: T0 + 3_600_000 } } });
  assert.equal((await reads()).t2!.round, T0, "round 不许超过任务此刻的轮次");
  await put({ reads: { lead: { event: "team:x", round: T0 + 3_600_000 } } });
  assert.equal((await reads()).lead!.round, T0 + 5_000, "团队的轮次看执行者里最晚的那个");
  const res = await put({ reads: { ghost: { event: "done:g", round: T0 }, t2: { event: "done:t2", round: T0 } } });
  assert.deepEqual(res.body.rejected, ["ghost"], "不存在的任务列进 rejected");
  assert.equal(res.body.reads.ghost, undefined, "也不落库");
}

// ── 坏请求体 ────────────────────────────────────────────────────────────────
{
  const count = events.length;
  for (const body of [{ reads: null }, { reads: [1] }, { reads: { t2: { event: 1, round: 1 } } }, { reads: { t2: { event: "x", round: -1 } } }, { reads: { t2: { event: "x", readAt: 1 } } }]) {
    const res = await put(body);
    assert.equal(res.status, 200, `坏请求体 ${JSON.stringify(body)} 不该 500`);
  }
  for (const body of [null, 3, "x", [], { reads: { t2: { event: "x", round: T0 } } }]) {
    const res = await putRaw(body);
    assert.equal(res.status, 409, `没写明是谁看的 ${JSON.stringify(body)}：当成账号对不上，一条不写`);
  }
  const bad = await call("/task-reads", { method: "PUT", headers: { "content-type": "application/json" }, body: "{oops" });
  assert.equal(bad.status, 409, "解析不了的 JSON 也不 500");
  assert.equal((await reads()).t2!.event, "done:t2", "形状不对的那条不落库");
  assert.equal(events.length, count, "什么都没写就不叫别人重拉");
}

// ── 一个人一份 ──────────────────────────────────────────────────────────────
{
  actor = userActor("alice");
  assert.deepEqual((await call("/task-reads")).body, { owner: "alice", rev: 0, reads: {} }, "alice 看不到本机那份，回执说明这是她的");
  await put({ reads: { t1: { event: "done:alice", round: T0 } } });
  assert.deepEqual(events.at(-1), { type: "task.reads", ownerUserId: "alice" });
  actor = userActor("bob");
  assert.deepEqual(await reads(), {}, "bob 看不到 alice 那份");
  // 同一个浏览器另一个标签页换成 bob 登录，alice 那一页攒着的记录借 bob 的 cookie 送上来。
  const stray = await putRaw({ owner: "alice", reads: { t2: { event: "done:alice-offline", round: T0 } } });
  assert.equal(stray.status, 409, "账号对不上：拒");
  assert.equal(stray.body.owner, "bob", "回执说明现在是谁，前端据此整页重载");
  assert.deepEqual(await reads(), {}, "alice 的记录没记到 bob 头上");
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

// ── 满额时留最近看到的(审查第 2 轮 F3 的复现：看满 500 个新任务之后再看一个很老的任务) ───────────────
{
  actor = userActor("carol");
  const total = TASK_READS_MAX + 20;
  for (let i = 0; i < total; i += 1) await addTask(`m${i}`, T0 + i);
  await addTask("ancient", Date.parse("2020-01-01T00:00:00.000Z"));
  const first = Object.fromEntries(Array.from({ length: total }, (_, i) => [`m${i}`, { event: `done:${i}`, round: T0 + i }]));
  await put({ reads: first });
  let saved = await reads();
  assert.equal(Object.keys(saved).length, TASK_READS_MAX, "一次送超了：只收上限那么多条");
  await new Promise((resolve) => setTimeout(resolve, 5));
  await put({ reads: { ancient: { event: "done:ancient", round: Date.parse("2020-01-01T00:00:00.000Z") } } });
  saved = await reads();
  assert.equal(Object.keys(saved).length, TASK_READS_MAX, "再写一条也不超");
  assert.ok(saved.ancient, "刚看过的旧任务留得住(它的 round 比谁都老)");
  actor = context.SINGLE_ACTOR;
}

// ── 删任务连已读记录一起收 ─────────────────────────────────────────────────────
{
  assert.ok((await db.select().from(taskReads).where(eq(taskReads.taskId, "t1"))).length >= 2, "本机和 alice、carol 各有一条");
  await deleteTaskCompletely("t1");
  assert.equal((await db.select().from(taskReads).where(eq(taskReads.taskId, "t1"))).length, 0, "删任务要清掉各人的已读记录");
}

await releaseTmpDb();
rmSync(root, { recursive: true, force: true });
console.log("✓ task reads");
