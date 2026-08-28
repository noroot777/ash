// ⌘K 全局搜索的**可见性**回归:它是全库里最危险的一个读口 —— 返回的不是标题列表,
// 而是任务正文、磁盘上的会话原文和随手记正文的**片段**。
//
// 第 1 轮审查(新审查者)P1 实测:`/api/search` 只把「可见项目集合」交给 searchAll,
// 随手记于是只过了项目这一条轴。同一个共享项目里,Alice 搜 Bob 的私有随手记能连
// `snippet` / `preview` 一起拿到 —— 而 §八(`docs/multi-user-plan.md:124`-`130`)把
// 随手记列在**个人面**:逐人隔离,连实例管理员也不例外。`/notes` 早就是两条轴
// (`notes.ts` 的 `visibleNotes`:先 `filterOwned`,再问项目可见),搜索少了一条。
//
// 这条测试钉住两条轴各自的边界,两个路由(`/search` 与 `/search/stream`)都走一遍 ——
// 流式那条是另一段代码在拼应答,「同一个 searchAll」只是当下的实现,不是保证。
// 同时钉住**别收过头**:自用模式下这一层必须完全透明,本人搜自己的照常搜得到,
// 项目轴该给管理员看的照常给。
//
// 一律走真 Request 打进 `authGate → resourceGate → personalWriteGate → 路由` 的完整栈。
//
// 跑法(自带临时库):
//   npm -w server run test:search-visibility
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireTmpDb, releaseTmpDb } from "./tmp-db.js";

const stage = mkdtempSync(join(tmpdir(), "ash-search-visibility-"));
process.env.ASH_DB ||= join(stage, "search-visibility.db");
process.env.ASH_RUNS_DIR ||= join(stage, "runs");
requireTmpDb("test-search-visibility");

// 碰库的模块一律 await import:静态 import 会被提升到设 ASH_DB 之前,那样连的是真库。
const { db, ensureSchema } = await import("../src/db/index.js");
const { noteTasks, notes, projects, tasks } = await import("../src/db/schema.js");
const mode = await import("../src/auth/mode.js");
const store = await import("../src/auth/store.js");
const visibility = await import("../src/auth/visibility.js");
const { Hono } = await import("hono");
const { authGate } = await import("../src/auth/middleware.js");
const { resourceGate } = await import("../src/auth/resource-gate.js");
const { personalWriteGate } = await import("../src/auth/personal-gate.js");
const { api } = await import("../src/routes.js");

await ensureSchema();

const app = new Hono();
app.use("*", authGate());
app.use("/api/*", resourceGate());
app.use("/api/*", personalWriteGate());
app.route("/api", api);

/** 报告里那条钉子词:它在库里只出现一次,谁搜到它谁就读到了 Bob 的私有正文。 */
const BOB_NEEDLE = "bob-private-needle-7c4b";
const BOB_BODY = `${BOB_NEEDLE} should not be searchable by Alice`;
const ALICE_NEEDLE = "alice-note-needle-3d1a";
const ORPHAN_NEEDLE = "orphan-note-needle-9f2e";
const BOB_LINK_NEEDLE = "bob-linked-note-needle-5a8c";
const BOB_TASK_NEEDLE = "bobonlyprojectneedle";

const at = new Date().toISOString();
const ms = Date.parse(at);

await db.insert(projects).values([
  { id: "p-shared", name: "Shared", repoPath: join(stage, "shared"), apiKeys: null, workflowId: null, createdAt: at, ownerUserId: null },
  { id: "p-bob", name: "Bob Only", repoPath: join(stage, "bob"), apiKeys: null, workflowId: null, createdAt: at, ownerUserId: null },
] as never);
await db.insert(tasks).values([
  { id: "t-shared", projectId: "p-shared", title: "shared task", body: "", status: "backlog", createdAt: at, updatedAt: at, ownerUserId: null },
  { id: "t-bob", projectId: "p-bob", title: `${BOB_TASK_NEEDLE} task`, body: "", status: "backlog", createdAt: at, updatedAt: at, ownerUserId: null },
] as never);
const note = (id: string, body: string) => ({
  id, projectId: "p-shared", body, attachments: null, ownerUserId: null, createdAt: ms, updatedAt: ms,
});
await db.insert(notes).values([
  note("note-bob-private", BOB_BODY),
  note("note-alice", `${ALICE_NEEDLE} alice's own note`),
  note("note-bob-linked", `${BOB_LINK_NEEDLE} bob's own note`),
  // 归属为 null 的存量行:转换时该被认领掉,万一还留着,只对实例管理员可见(owned.ts)。
  note("note-orphan", `${ORPHAN_NEEDLE} nobody's note`),
] as never);
// 跨项目回链:两条随手记都挂在 p-shared,却都链着 p-bob 里的那个任务。功能上线前建
// 起来的这种链在存量库里是有的 —— 「随手记看得见」推不出「它链的任务看得见」。
await db.insert(noteTasks).values([
  { noteId: "note-alice", taskId: "t-bob", createdAt: ms },
  { noteId: "note-bob-linked", taskId: "t-bob", createdAt: ms },
] as never);

type Reply = { status: number; hits: Record<string, unknown>[]; text: string };
const search = async (path: string, headers: Record<string, string>): Promise<Reply> => {
  const res = await app.fetch(new Request(`http://127.0.0.1:4317${path}`, { headers }));
  const text = await res.text();
  if (path.startsWith("/api/search/stream")) {
    // NDJSON:一行一条命中,中间夹一行 `{"marker":"local-done"}`。
    const hits = text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => !line.marker);
    return { status: res.status, hits, text };
  }
  let parsed: unknown = [];
  try { parsed = JSON.parse(text); } catch { /* 不是 JSON 就只看 text */ }
  return { status: res.status, hits: Array.isArray(parsed) ? parsed as Record<string, unknown>[] : [], text };
};

/** 两条路由问同一个问题:它们必须给同一个答案。 */
const bothRoutes = async (query: string, headers: Record<string, string>): Promise<Reply[]> => [
  await search(`/api/search?q=${encodeURIComponent(query)}`, headers),
  await search(`/api/search/stream?q=${encodeURIComponent(query)}`, headers),
];

const ids = (reply: Reply) => reply.hits.map((hit) => String(hit.id)).sort();

try {
  // ── ⓪ 自用模式:这一层必须完全透明 ────────────────────────────────────
  // 归属列全是 null(隐式本地用户),搜索得跟本功能上线前一样什么都找得到,
  // 否则「多人模式的隔离」就变成了「自用模式下随手记搜不到了」。
  for (const reply of await bothRoutes(BOB_NEEDLE, {})) {
    assert.equal(reply.status, 200, `自用模式不该要登录:${reply.text}`);
    assert.deepEqual(ids(reply), ["note-bob-private"], `自用模式该照常搜到随手记:${reply.text}`);
  }
  // 计数同理:自用模式下所有任务都看得见,这条跨项目回链该照数不误。
  for (const reply of await bothRoutes(ALICE_NEEDLE, {})) {
    assert.equal(reply.hits[0]?.taskCount, 1, `自用模式的转任务计数该照常:${reply.text}`);
  }

  // ── 转多人 ───────────────────────────────────────────────────────────
  const root = join(stage, "root");
  for (const dir of ["alice", "bob", "boss"]) mkdirSync(join(root, dir), { recursive: true });
  await mode.setInstanceMode("multi", root);

  const alice = await store.createUser({ name: "alice", role: "member", dirName: "alice", gitName: "Alice", gitEmail: "a@x", createdBy: null });
  const bob = await store.createUser({ name: "bob", role: "member", dirName: "bob", gitName: "Bob", gitEmail: "b@x", createdBy: null });
  const boss = await store.createUser({ name: "boss", role: "admin", dirName: "boss", gitName: "Boss", gitEmail: "s@x", createdBy: null });
  const AS_ALICE = { authorization: `Bearer ${await store.resetUserKey(alice.id)}` };
  const AS_BOB = { authorization: `Bearer ${await store.resetUserKey(bob.id)}` };
  const AS_BOSS = { authorization: `Bearer ${await store.resetUserKey(boss.id)}` };

  // Alice 与 Bob 是**同一个**共享项目的成员 —— 项目轴放行,能不能看见随手记就全看个人面。
  await visibility.addProjectMember({ projectId: "p-shared", userId: alice.id, role: "member", addedBy: boss.id });
  await visibility.addProjectMember({ projectId: "p-shared", userId: bob.id, role: "member", addedBy: boss.id });
  await visibility.addProjectMember({ projectId: "p-bob", userId: bob.id, role: "admin", addedBy: boss.id });

  const { eq } = await import("drizzle-orm");
  await db.update(notes).set({ ownerUserId: bob.id }).where(eq(notes.id, "note-bob-private"));
  await db.update(notes).set({ ownerUserId: bob.id }).where(eq(notes.id, "note-bob-linked"));
  await db.update(notes).set({ ownerUserId: alice.id }).where(eq(notes.id, "note-alice"));

  // ── ① 个人面:共享项目里也看不见别人的随手记 ────────────────────────────
  for (const reply of await bothRoutes(BOB_NEEDLE, AS_ALICE)) {
    assert.equal(reply.status, 200, `Alice 的搜索该正常返回:${reply.text}`);
    assert.deepEqual(reply.hits, [], `Bob 的私有随手记不该出现在 Alice 的搜索结果里:${reply.text}`);
    // 命中列表空了还不够 —— 泄露的是正文片段,整份应答里一个字都不许有。
    assert.equal(reply.text.includes(BOB_NEEDLE), false, `应答里不许出现钉子词:${reply.text}`);
    assert.equal(reply.text.includes("should not be searchable"), false, `更不许出现正文:${reply.text}`);
  }

  // ── ② 别收过头:本人搜自己的照常搜得到 ─────────────────────────────────
  for (const reply of await bothRoutes(BOB_NEEDLE, AS_BOB)) {
    assert.deepEqual(ids(reply), ["note-bob-private"], `Bob 得搜得到自己的随手记:${reply.text}`);
  }
  for (const reply of await bothRoutes(ALICE_NEEDLE, AS_ALICE)) {
    assert.deepEqual(ids(reply), ["note-alice"], `Alice 得搜得到自己的随手记:${reply.text}`);
  }

  // ── ③ 实例管理员在个人面上没有特权 ────────────────────────────────────
  // 他管的是用户和实例设置,不是别人的随手记(owned.ts 顶部)。但归属为 null 的存量行
  // 只有他看得见 —— 藏起来只会让人以为数据丢了。
  for (const reply of await bothRoutes(BOB_NEEDLE, AS_BOSS)) {
    assert.deepEqual(reply.hits, [], `管理员也不该搜到别人的随手记:${reply.text}`);
  }
  for (const reply of await bothRoutes(ORPHAN_NEEDLE, AS_BOSS)) {
    assert.deepEqual(ids(reply), ["note-orphan"], `无主随手记该对管理员可见:${reply.text}`);
  }
  for (const reply of await bothRoutes(ORPHAN_NEEDLE, AS_ALICE)) {
    assert.deepEqual(reply.hits, [], `无主随手记不该对普通成员可见:${reply.text}`);
  }

  // ── ④ 项目轴照旧:不是成员就搜不到那个项目的任务 ────────────────────────
  for (const reply of await bothRoutes(BOB_TASK_NEEDLE, AS_ALICE)) {
    assert.deepEqual(reply.hits, [], `Alice 不是 p-bob 的成员,不该搜到它的任务:${reply.text}`);
    assert.equal(reply.text.includes(BOB_TASK_NEEDLE), false, `拒了就一个字都不许漏:${reply.text}`);
  }
  for (const reply of await bothRoutes(BOB_TASK_NEEDLE, AS_BOB)) {
    assert.deepEqual(ids(reply), ["t-bob"], `Bob 是成员,该搜得到:${reply.text}`);
  }
  for (const reply of await bothRoutes(BOB_TASK_NEEDLE, AS_BOSS)) {
    assert.deepEqual(ids(reply), ["t-bob"], `实例管理员在项目轴上看得见一切:${reply.text}`);
  }

  // ── ⑤ 「已转 N 个任务」只数看得见的任务 ────────────────────────────────
  // 泄露的不是任务标题而是**存在与数量**,而且它让两个面对同一条随手记说法不一致:
  // 详情页说「没有关联任务」,⌘K 却写着「已转 1 个任务」。
  const notesReply = await search("/api/notes?projectId=p-shared", AS_ALICE);
  const aliceNote = notesReply.hits.find((row) => row.id === "note-alice");
  assert.ok(aliceNote, `Alice 该看得见自己的随手记:${notesReply.text}`);
  assert.deepEqual(aliceNote?.taskLinks, [], `/notes 早就藏掉了不可见的回链:${notesReply.text}`);
  for (const reply of await bothRoutes(ALICE_NEEDLE, AS_ALICE)) {
    assert.equal(reply.hits.length, 1, `Alice 该搜到自己那条:${reply.text}`);
    assert.equal(reply.hits[0]?.taskCount, 0, `搜索的计数得跟 /notes 说同一件事:${reply.text}`);
  }
  // 别收过头:Bob 是 p-bob 的成员,同一条回链对他就是真的。
  for (const reply of await bothRoutes(BOB_LINK_NEEDLE, AS_BOB)) {
    assert.equal(reply.hits[0]?.taskCount, 1, `看得见那个任务的人,计数该照数:${reply.text}`);
  }

  console.log("search visibility ok(个人面 + 项目轴 + 转任务计数,/search 与 /search/stream 同判据)");
} finally {
  await releaseTmpDb();
  rmSync(stage, { recursive: true, force: true });
}
