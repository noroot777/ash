// 验收确认层点确认时记什么的后端回归(写入规则见 server/src/accept-memory.ts，到达序号见
// server/src/db/schema-accept-commit-order.ts):
//  · 「运行」那一勾**不记**(用户 2026-11-16：跳过只管当次)：门禁状态里不带「上次跳没跳过」，取消过一次
//    之后下一次读到的还是照常跑；老页面照旧送来的 skipGate 不收、不落库、不推门禁；
//  · 升级：老库里记着跳过的那张表 accept_memory 启动时退役，记着的跳过不再生效；发号用库里最大号垫底，
//    时钟往回校再重启也不回头；
//  · 「提交」那一勾就是项目设置：管理员确认时写回 projects.accept_commit(变了才推 project.updated)，
//    没有管理权限就不写、回执说 commitSaved:false；别处刚改过也照写（不凭早先的快照省掉赋值）；
//    看不见项目 403，项目不在 404，含糊的真值 400；
//  · 后到的确认算数：服务端卡住、浏览器已经放弃的旧确认晚做完，也盖不掉之后那次确认或设置页的改动；
//  · 回合凭证写不动它(个人面写闸)；服务端、shared、前端源码里没有任何一处还认「运行」那一勾的记忆。
//
// 跑：npx tsx server/scripts/test-accept-memory.ts
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { ServerEvent } from "@ash/shared";
import { requireTmpDb, releaseTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "ash-accept-memory-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
requireTmpDb("accept-memory");

const [{ db, dbClient, ensureSchema }, schema, memory, gateRoutes, { bus }, context, mode, store, visibility, personalGate, projectRoutes, arrival] = await Promise.all([
  import("../src/db/index.js"),
  import("../src/db/schema.js"),
  import("../src/accept-memory.js"),
  import("../src/accept-gate-routes.js"),
  import("../src/bus.js"),
  import("../src/auth/context.js"),
  import("../src/auth/mode.js"),
  import("../src/auth/store.js"),
  import("../src/auth/visibility.js"),
  import("../src/auth/personal-gate.js"),
  import("../src/project-routes.js"),
  import("../src/db/arrival-seq.js"),
]);
const { projects, tasks } = schema;
type Actor = import("../src/auth/context.js").Actor;

// 升级前的样子：用户在 p-old 里取消过一次「运行」，库里记着跳过（accept_memory，线上那一版的形状）；
// accept_commit_order 里留着一个比现在的时钟还大的号（时钟往回校过、又重启了，第 3 轮审查 N1）。
// 启动之后记着的跳过不再生效，「提交」的新确认也不会被那个大号挡掉。
const future = Date.now() * 1000 + 10 ** 12;
await dbClient.executeMultiple(`
  CREATE TABLE accept_memory (owner TEXT NOT NULL, project_id TEXT NOT NULL,
    skip_gate INTEGER NOT NULL DEFAULT 0, seq INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL,
    PRIMARY KEY (owner, project_id));
  INSERT INTO accept_memory VALUES ('', 'p-old', 1, 7, '2026-11-15T00:00:00.000Z');
  CREATE TABLE accept_commit_order (project_id TEXT PRIMARY KEY, seq INTEGER NOT NULL);
  INSERT INTO accept_commit_order VALUES ('p-old', ${future});
`);
await ensureSchema();

let actor: Actor = context.SINGLE_ACTOR;
const api = new Hono();
api.use("*", async (c, next) => { context.setActor(c, actor); await next(); });
memory.mountAcceptMemoryRoutes(api);
gateRoutes.mountAcceptGateRoutes(api);

const events: ServerEvent[] = [];
bus.subscribe((event) => { events.push(event); });

const call = async (path: string, init?: RequestInit) => {
  const response = await api.request(`http://x${path}`, init);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
};
const remember = (projectId: string, body: unknown) =>
  call(`/accept-memory/${projectId}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
/** 门禁状态里有没有带「上次跳没跳过」（确认层「运行」那一勾的默认只可能从这儿来）。 */
const skipCarried = async (taskId: string) => {
  const res = await call(`/tasks/${taskId}/accept-gate`);
  assert.equal(res.status, 200);
  return "skipRemembered" in res.body;
};
const memoryTable = async () =>
  (await dbClient.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'accept_memory'")).rows.length;
const acceptCommitOf = async (projectId: string) =>
  (await db.select({ acceptCommit: projects.acceptCommit }).from(projects).where(eq(projects.id, projectId))).at(0)!.acceptCommit;

const at = new Date().toISOString();
const repo = join(root, "repo");
mkdirSync(repo, { recursive: true });
await db.insert(projects).values([
  { id: "p1", name: "一", repoPath: repo, createdAt: at },
  { id: "p2", name: "二", repoPath: repo, createdAt: at },
]);
const addTask = (id: string, projectId: string, stage: string | null) =>
  db.insert(tasks).values({ id, projectId, title: id, body: "", status: "done", mode: "single", stage, createdAt: at, updatedAt: at });
await addTask("t1", "p1", "verified");
await addTask("t2", "p1", null);
await addTask("t3", "p1", "accepted");
await addTask("u1", "p2", "verified");

// ── 升级：记着的跳过不再生效，发号不回头 ───────────────────────────────────────────
{
  await db.insert(projects).values({ id: "p-old", name: "旧", repoPath: repo, createdAt: at });
  await addTask("old1", "p-old", "verified");
  assert.equal(await memoryTable(), 0, "记「运行」那一勾的表退役了：老库里记着的跳过跟着没");
  assert.equal(await skipCarried("old1"), false, "旧库里记着跳过的项目：门禁状态不带它，确认层默认是跑");
  assert.ok(arrival.nextArrivalSeq() > future, "启动时用库里最大的号垫底");
  const res = await remember("p-old", { commit: false });
  assert.deepEqual(res.body, { commit: false, commitSaved: true }, "时钟回退过也照写：不被旧的大号挡掉");
  assert.equal(await acceptCommitOf("p-old"), false);
}

// ── 「运行」那一勾不记：取消过一次，下一次读到的还是照常跑 ───────────────────────────
{
  assert.equal(await skipCarried("t1"), false);
  events.length = 0;
  // 升级那一刻还开着的老页面，确认时照旧把「跳过」送来：不收这一项，也不因为它拒掉「提交」那一半。
  const res = await remember("p1", { skipGate: true, commit: true });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { commit: true, commitSaved: true }, "回执里也没有「跳没跳过」");
  for (const taskId of ["t1", "t2", "u1"]) assert.equal(await skipCarried(taskId), false, `${taskId}：下一次验收照常跑`);
  assert.equal(await memoryTable(), 0, "没有地方存它");
  assert.equal(events.length, 0, "什么都没变：不推门禁，也不推项目变化");
}

// ── 「提交」那一勾就是项目设置 ─────────────────────────────────────────────────────
{
  events.length = 0;
  const res = await remember("p1", { commit: false });
  assert.deepEqual(res.body, { commit: false, commitSaved: true });
  assert.equal(await acceptCommitOf("p1"), false, "写回项目设置：设置页看到的就是这一个值");
  assert.equal(events.filter((event) => event.type === "project.updated").length, 1, "设置变了，推一次项目变化");
  assert.equal(events.some((event) => event.type === "task.acceptGate"), false, "门禁状态里没有它的份");
  events.length = 0;
  assert.deepEqual((await remember("p1", { commit: false })).body, { commit: false, commitSaved: true }, "下一次确认读到的还是改过的样子");
  assert.equal(events.length, 0, "跟项目设置一样：什么都不推");
  await remember("p1", { commit: true });
  assert.equal(await acceptCommitOf("p1"), true);
  // 别处（设置页、另一个确认）刚把它改掉：这一次确认照样写进去，回执报实际存下的值（第 1 轮审查 F4）。
  await db.update(projects).set({ acceptCommit: false }).where(eq(projects.id, "p1"));
  events.length = 0;
  assert.deepEqual((await remember("p1", { commit: true })).body, { commit: true, commitSaved: true });
  assert.equal(await acceptCommitOf("p1"), true, "写的时候才读库里的值，不凭早先读到的值省掉赋值");
  assert.equal(events.filter((event) => event.type === "project.updated").length, 1);
  await remember("p1", { commit: true });
}

// ── 后到的确认算数：晚做完的旧确认盖不掉它（第 2 轮审查 F1）────────────────────────────
// 复现的是真实那一幕：A 先确认、服务端卡住（这里用慢请求体，审查用的是数据库写锁），浏览器等到超时
// 放弃，用户又确认了一次 B；B 先落库，A 随后醒来做完。A 不能写进去，回执报库里实际的样子。
{
  const encoder = new TextEncoder();
  const slowPut = (projectId: string, head: string, tail: string) => {
    let finish!: () => void;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(head));
        finish = () => { controller.enqueue(encoder.encode(tail)); controller.close(); };
      },
    });
    const pending = api.request(new Request(`http://x/accept-memory/${projectId}`, {
      method: "PUT", headers: { "content-type": "application/json" }, body, duplex: "half",
    } as RequestInit & { duplex: "half" })).then(async (response) => ({ status: response.status, body: await response.json() }));
    return { finish, pending };
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

  await remember("p1", { commit: true });
  const older = slowPut("p1", '{"commit":', "false}");
  await settle();
  const newer = await remember("p1", { commit: true });
  assert.deepEqual(newer.body, { commit: true, commitSaved: true });
  events.length = 0;
  older.finish();
  const late = await older.pending;
  assert.equal(late.status, 200);
  assert.deepEqual(late.body, { commit: true, commitSaved: true }, "旧确认被挡住：回执报那次更新的选择");
  assert.equal(await acceptCommitOf("p1"), true, "后到的那一次算数");
  assert.equal(events.length, 0, "什么都没写就什么都不推");

  // 没有更新的确认：等不及放弃了也照样记住 —— 那就是用户最后确认的选择。
  const alone = slowPut("p1", '{"commit":', "false}");
  await settle();
  alone.finish();
  assert.deepEqual((await alone.pending).body, { commit: false, commitSaved: true });
  assert.equal(await acceptCommitOf("p1"), false);

  // 设置页是另一个写入方，同一套顺序：比它晚到的设置页改动算数，比它早到的旧确认盖不掉设置页。
  const projectApi = new Hono();
  projectApi.use("*", async (c, next) => { context.setActor(c, actor); await next(); });
  projectRoutes.mountProjectRoutes(projectApi);
  const patchCommit = async (acceptCommit: boolean) => {
    const response = await projectApi.request("http://x/projects/p1", {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ acceptCommit }),
    });
    return { status: response.status, body: await response.json() as { acceptCommit: boolean } };
  };
  const beforeSettings = slowPut("p1", '{"commit":', "false}");
  await settle();
  const patched = await patchCommit(true);
  assert.equal(patched.status, 200);
  assert.equal(patched.body.acceptCommit, true);
  beforeSettings.finish();
  assert.equal((await beforeSettings.pending).body.commit, true, "早于设置页的确认被挡住");
  assert.equal(await acceptCommitOf("p1"), true, "设置页后改的算数");
  assert.equal((await patchCommit(false)).body.acceptCommit, false);
  assert.equal(await acceptCommitOf("p1"), false, "设置页晚到：照写");
  assert.equal((await remember("p1", { commit: true })).body.commit, true, "设置页之后的确认算数");
}

// ── 坏请求 ───────────────────────────────────────────────────────────────────
{
  for (const body of [{ commit: "true" }, { commit: 0 }, {}, { skipGate: true }, null, [true]]) {
    const res = await remember("p1", body);
    assert.equal(res.status, 400, `含糊的值不收：${JSON.stringify(body)}`);
  }
  assert.equal((await remember("nope", { commit: false })).status, 404);
  assert.equal(await acceptCommitOf("p1"), true, "坏请求一条不写");
}

// ── 多人模式：提交要项目管理权限 ───────────────────────────────────────────────
{
  const people = join(root, "people");
  mkdirSync(people, { recursive: true });
  await mode.setInstanceMode("multi", people);
  const alice = await store.createUser({ name: "alice", role: "member", dirName: "alice", gitName: "A", gitEmail: "a@x", createdBy: null });
  const bob = await store.createUser({ name: "bob", role: "member", dirName: "bob", gitName: "B", gitEmail: "b@x", createdBy: alice.id });
  const carol = await store.createUser({ name: "carol", role: "member", dirName: "carol", gitName: "C", gitEmail: "c@x", createdBy: alice.id });
  for (const user of [alice, bob, carol]) await store.updateUser(user.id, { status: "active" });
  await visibility.addProjectMember({ projectId: "p1", userId: alice.id, role: "admin", addedBy: null });
  await visibility.addProjectMember({ projectId: "p1", userId: bob.id, role: "member", addedBy: alice.id });
  const as = (user: { id: string; name: string }): Actor => ({ kind: "user", userId: user.id, role: "member", name: user.name });

  actor = as(bob);
  const res = await remember("p1", { commit: false });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { commit: true, commitSaved: false }, "没有管理权限：提交不写，回执说没记住");
  assert.equal(await acceptCommitOf("p1"), true, "项目设置没被成员改掉");
  actor = as(alice);
  assert.deepEqual((await remember("p1", { commit: false })).body, { commit: false, commitSaved: true }, "管理员写得回项目设置");
  assert.equal(await acceptCommitOf("p1"), false);
  assert.equal(await skipCarried("t1"), false, "多人模式下门禁状态同样不带「上次跳没跳过」");
  actor = as(carol);
  assert.equal((await remember("p1", { commit: true })).status, 403, "看不见这个项目：不许记");
  actor = context.SINGLE_ACTOR;
}

// ── 只有人能写；「运行」那一勾的记忆拆干净了 ────────────────────────────────────────
{
  assert.equal(personalGate.isPersonalWritePath("/api/accept-memory/p1"), true, "回合凭证写不动它");
  // 存、写、随门禁状态带出去、前端读是一整套：哪一截留着，另一截迟早又接回来。退役表那一行只提表名。
  const repoRoot = join(import.meta.dirname, "../..");
  const leftovers = ["server/src", "shared/src", "web/src"].flatMap((dir) =>
    readdirSync(join(repoRoot, dir), { recursive: true, encoding: "utf8" })
      .filter((file) => /\.tsx?$/.test(file)
        && /skipRemembered|rememberedSkipGate|skipGate|skip_gate|acceptMemory\b/.test(readFileSync(join(repoRoot, dir, file), "utf8")))
      .map((file) => `${dir}/${file}`));
  assert.deepEqual(leftovers, [], `还有地方认「运行」那一勾的记忆：${leftovers.join(", ")}`);
}

await releaseTmpDb();
rmSync(root, { recursive: true, force: true });
console.log("✓ accept memory");
