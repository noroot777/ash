// 验收确认层「上次怎么勾的」的后端回归(为什么进库见 server/src/db/schema-accept-memory.ts，写入规则见
// server/src/accept-memory.ts):
//  · 「运行」那一勾按人、按项目各记一份，随门禁状态带出去(skipRemembered)；没记过 = 照常跑；
//  · 写了它，这个项目下还没验收的任务各推一次 task.acceptGate(别的标签页、下一个任务立刻跟上)；
//  · 「提交」那一勾就是项目设置：管理员确认时写回 projects.accept_commit(变了才推 project.updated)，
//    没有管理权限就不写、回执说 commitSaved:false；别处刚改过也照写（不凭早先的快照省掉赋值）；
//    看不见项目 403，项目不在 404，含糊的真值 400；
//  · 后到的确认算数：服务端卡住、浏览器已经放弃的旧确认晚做完，也盖不掉之后那次确认或设置页的改动；
//  · 回合凭证写不动它(个人面写闸)；验收接口和别的入口不读它(只有门禁状态那条 GET 读)。
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

const [{ db, ensureSchema }, schema, memory, gateRoutes, { bus }, context, mode, store, visibility, personalGate, projectRoutes] = await Promise.all([
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
]);
const { projects, tasks } = schema;
type Actor = import("../src/auth/context.js").Actor;

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
const skipShown = async (taskId: string) => (await call(`/tasks/${taskId}/accept-gate`)).body.skipRemembered as boolean;
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

// ── 「运行」那一勾：按项目记，随门禁状态带出去 ─────────────────────────────────────
{
  assert.equal(await skipShown("t1"), false, "没记过：照常跑");
  events.length = 0;
  const res = await remember("p1", { skipGate: true });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { skipGate: true, commit: true, commitSaved: false }, "只送了运行那一勾：提交没动");
  assert.equal(await skipShown("t1"), true, "同一项目的这个任务：上次跳过");
  assert.equal(await skipShown("t2"), true, "同一项目的下一个任务也一样");
  assert.equal(await skipShown("u1"), false, "别的项目不受影响");
  const pushed = events.filter((event) => event.type === "task.acceptGate").map((event) => (event as { taskId: string }).taskId).sort();
  assert.deepEqual(pushed, ["t1", "t2"], "只推还没验收的那几个任务");
  assert.equal(events.some((event) => event.type === "project.updated"), false, "没碰项目设置就不推项目变化");
  await remember("p1", { skipGate: false });
  assert.equal(await skipShown("t2"), false, "重新勾上并确认：记成新的");
}

// ── 「提交」那一勾就是项目设置 ─────────────────────────────────────────────────────
{
  events.length = 0;
  const res = await remember("p1", { commit: false });
  assert.deepEqual(res.body, { skipGate: false, commit: false, commitSaved: true });
  assert.equal(await acceptCommitOf("p1"), false, "写回项目设置：设置页看到的就是这一个值");
  assert.equal(events.filter((event) => event.type === "project.updated").length, 1, "设置变了，推一次项目变化");
  assert.equal(events.some((event) => event.type === "task.acceptGate"), false, "没送运行那一勾就不推门禁");
  events.length = 0;
  await remember("p1", { commit: false });
  assert.equal(events.length, 0, "跟项目设置一样：什么都不推");
  await remember("p1", { commit: true, skipGate: false });
  assert.equal(await acceptCommitOf("p1"), true);
  // 别处（设置页、另一个确认）刚把它改掉：这一次确认照样写进去，回执报实际存下的值（第 1 轮审查 F4）。
  await db.update(projects).set({ acceptCommit: false }).where(eq(projects.id, "p1"));
  events.length = 0;
  assert.deepEqual((await remember("p1", { commit: true })).body, { skipGate: false, commit: true, commitSaved: true });
  assert.equal(await acceptCommitOf("p1"), true, "写的时候才读库里的值，不凭早先读到的值省掉赋值");
  assert.equal(events.filter((event) => event.type === "project.updated").length, 1);
  await remember("p1", { commit: true });
}

// ── 后到的确认算数：晚做完的旧确认盖不掉它（第 2 轮审查 F1）────────────────────────────
// 复现的是真实那一幕：A 先确认、服务端卡住（这里用慢请求体，审查用的是数据库写锁），浏览器等到超时
// 放弃，用户又确认了一次 B；B 先落库，A 随后醒来做完。A 的两项都不能写进去，回执报库里实际的样子。
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

  await remember("p1", { skipGate: false, commit: true });
  const older = slowPut("p1", '{"skipGate":true,', '"commit":false}');
  await settle();
  const newer = await remember("p1", { skipGate: false, commit: true });
  assert.deepEqual(newer.body, { skipGate: false, commit: true, commitSaved: true });
  events.length = 0;
  older.finish();
  const late = await older.pending;
  assert.equal(late.status, 200);
  assert.deepEqual(late.body, { skipGate: false, commit: true, commitSaved: true }, "旧确认被挡住：回执报那次更新的选择");
  assert.equal(await acceptCommitOf("p1"), true, "提交：后到的那一次算数");
  assert.equal(await skipShown("t1"), false, "运行：后到的那一次算数");
  assert.equal(events.length, 0, "什么都没写就什么都不推");

  // 更新的那次确认只送了「提交」：旧确认里「提交」那一半被挡住，「运行」那一半没有更新的选择，照写。
  const half = slowPut("p1", '{"skipGate":true,', '"commit":false}');
  await settle();
  await remember("p1", { commit: true });
  half.finish();
  assert.deepEqual((await half.pending).body, { skipGate: true, commit: true, commitSaved: true });
  assert.equal(await acceptCommitOf("p1"), true, "提交那一半被更新的确认挡住");
  assert.equal(await skipShown("t1"), true, "运行那一半没人后来改过：这次确认的选择记住了");
  await remember("p1", { skipGate: false });

  // 没有更新的确认：等不及放弃了也照样记住 —— 那就是用户最后确认的选择。
  const alone = slowPut("p1", '{"skipGate":true,', '"commit":false}');
  await settle();
  alone.finish();
  assert.deepEqual((await alone.pending).body, { skipGate: true, commit: false, commitSaved: true });
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
  assert.equal((await remember("p1", { commit: true, skipGate: false })).body.commit, true, "设置页之后的确认算数");
}

// ── 坏请求 ───────────────────────────────────────────────────────────────────
{
  for (const body of [{ skipGate: "true" }, { commit: 0 }, null, [true]]) {
    const res = await remember("p1", body);
    assert.equal(res.status, 400, `含糊的值不收：${JSON.stringify(body)}`);
  }
  assert.equal((await remember("nope", { skipGate: true })).status, 404);
  assert.equal(await skipShown("t1"), false, "坏请求一条不写");
}

// ── 多人模式：按人记；提交要项目管理权限 ─────────────────────────────────────────
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
  const res = await remember("p1", { skipGate: true, commit: false });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { skipGate: true, commit: true, commitSaved: false }, "没有管理权限：提交不写，回执说没记住");
  assert.equal(await acceptCommitOf("p1"), true, "项目设置没被成员改掉");
  assert.equal(await skipShown("t1"), true, "bob 自己那份记住了");
  actor = as(alice);
  assert.equal(await skipShown("t1"), false, "alice 那份不受 bob 影响");
  assert.deepEqual((await remember("p1", { commit: false })).body, { skipGate: false, commit: false, commitSaved: true }, "管理员写得回项目设置");
  assert.equal(await acceptCommitOf("p1"), false);
  actor = as(carol);
  assert.equal((await remember("p1", { skipGate: true })).status, 403, "看不见这个项目：不许记");
  actor = context.SINGLE_ACTOR;
}

// ── 只有人能写；只有门禁状态那条读 ──────────────────────────────────────────────
{
  assert.equal(personalGate.isPersonalWritePath("/api/accept-memory/p1"), true, "回合凭证写不动它");
  // 不经过确认层的入口(accept_task、飞书、手机)都走验收接口本身：它们一律不该读到这份记忆。
  const src = join(import.meta.dirname, "../src");
  const readers = readdirSync(src, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".ts") && /\/accept-memory\.js|rememberedSkipGate/.test(readFileSync(join(src, file), "utf8")))
    .sort();
  assert.deepEqual(readers, ["accept-gate-routes.ts", "accept-memory.ts", "routes.ts"], `只有门禁状态那条 GET 读它：${readers.join(", ")}`);
}

await releaseTmpDb();
rmSync(root, { recursive: true, force: true });
console.log("✓ accept memory");
