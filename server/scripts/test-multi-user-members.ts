// 项目成员表的写侧(§六)。判据只有一条,但它有**两个入口**:
//
//   直加(`POST /projects/:id/members`)与改角色(`PATCH …/:userId`)必须过同一份检查。
//
// 第 2 轮审查 P2:PATCH 只查了调用者是不是项目管理员,而它底下的 `addProjectMember`
// 是 **upsert** —— 于是「改角色」实际上是第二个加人入口,还是一个**没有任何检查**的:
//   · 对一个根本不存在的 userId 发 PATCH → 200,成员表里落一行项目管理员,名单上
//     显示「(已删除)」,并且占着 `explicitProjectAdminCount` 的名额(最后一个真管理员
//     因此可以被降级/移除,项目从此只剩一个不存在的账号当管理员);
//   · 对一个**停用**账号发 PATCH → 200,而 POST 对同一个人明确回 409。
//
// 这正是本仓库吃过的那一跤(`docs/incidents.md`「对称端点只改了一个」),所以这条测试
// 逐条对着两个入口打同一批目标,两边的答案必须一致。
//
// 跑法(自带临时库):
//   npm -w server run test:multi-user-members
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireTmpDb, releaseTmpDb } from "./tmp-db.js";

const stage = mkdtempSync(join(tmpdir(), "ash-mu-members-"));
process.env.ASH_DB ||= join(stage, "mu-members.db");
requireTmpDb("test-multi-user-members");

const { db, ensureSchema } = await import("../src/db/index.js");
const { projectMembers, projects } = await import("../src/db/schema.js");
const { eq } = await import("drizzle-orm");
const mode = await import("../src/auth/mode.js");
const store = await import("../src/auth/store.js");
const visibility = await import("../src/auth/visibility.js");
const { Hono } = await import("hono");
const { authGate } = await import("../src/auth/middleware.js");
const { resourceGate } = await import("../src/auth/resource-gate.js");
const { personalWriteGate } = await import("../src/auth/personal-gate.js");
const { api } = await import("../src/routes.js");

await ensureSchema();

const root = join(stage, "root");
for (const dir of ["owner", "pal", "sleepy", "boss"]) mkdirSync(join(root, dir), { recursive: true });
await mode.setInstanceMode("multi", root);

const owner = await store.createUser({
  name: "owner", role: "member", dirName: "owner", gitName: "O", gitEmail: "o@x", createdBy: null,
});
const pal = await store.createUser({
  name: "pal", role: "member", dirName: "pal", gitName: "P", gitEmail: "p@x", createdBy: owner.id,
});
const sleepy = await store.createUser({
  name: "sleepy", role: "member", dirName: "sleepy", gitName: "S", gitEmail: "s@x", createdBy: owner.id,
});
const boss = await store.createUser({
  name: "boss", role: "admin", dirName: "boss", gitName: "B", gitEmail: "b@x", createdBy: owner.id,
});
await store.suspendUser(sleepy.id);
const ownerKey = await store.resetUserKey(owner.id);

const at = new Date().toISOString();
await db.insert(projects).values([
  { id: "p1", name: "shared", repoPath: join(root, "owner", "repo"), apiKeys: null, workflowId: null, createdAt: at, ownerUserId: owner.id },
] as never);
await visibility.addProjectMember({ projectId: "p1", userId: owner.id, role: "admin", addedBy: owner.id });

const app = new Hono();
app.use("*", authGate());
app.use("/api/*", resourceGate());
app.use("/api/*", personalWriteGate());
app.route("/api", api);

type Reply = { status: number; body: Record<string, unknown>; text: string };
const call = async (path: string, method: string, key: string | null, body?: unknown): Promise<Reply> => {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (key) headers.authorization = `Bearer ${key}`;
  const res = await app.fetch(new Request(`http://127.0.0.1:4317${path}`, {
    method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  const text = await res.text();
  let parsed: unknown = {};
  try { parsed = JSON.parse(text); } catch { /* 不是 JSON 就看 text */ }
  return { status: res.status, body: Array.isArray(parsed) ? {} : (parsed as Record<string, unknown>), text };
};

const rowsOf = async (projectId: string) =>
  (await db.select().from(projectMembers).where(eq(projectMembers.projectId, projectId)))
    .map((r) => `${r.userId}:${r.role}`).sort();

const GHOST = "ghost-user-id";

// ── ① 两个入口,同一批目标,答案必须一致 ──────────────────────────────────
{
  const cases: { userId: string; status: number; match: RegExp; what: string }[] = [
    { userId: GHOST, status: 404, match: /不在实例里/, what: "不存在的账号" },
    { userId: sleepy.id, status: 409, match: /已被停用/, what: "停用的账号" },
  ];
  for (const item of cases) {
    const added = await call("/api/projects/p1/members", "POST", ownerKey, { userId: item.userId, role: "admin" });
    assert.equal(added.status, item.status, `直加${item.what}要拒:${added.text}`);
    assert.match(String(added.body.error ?? ""), item.match, added.text);

    const patched = await call(`/api/projects/p1/members/${item.userId}`, "PATCH", ownerKey, { role: "admin" });
    assert.equal(
      patched.status, item.status,
      `改角色对${item.what}必须给出与直加同一个答案(回了 ${patched.status}:${patched.text})`,
    );
    assert.match(String(patched.body.error ?? ""), item.match, patched.text);
  }
  // 状态码之外还得看库:「拒了但已经 upsert 进去了」照样是那个洞。
  assert.deepEqual(await rowsOf("p1"), [`${owner.id}:admin`], "被拒的写入一行都不许落库");
  assert.equal(
    (await visibility.listProjectMembers("p1")).some((m) => m.name === "(已删除)"), false,
    "名单里不该冒出「(已删除)」——那正是 ghost 行的样子",
  );
}

// ── ② 改角色只改**已有成员**,不兼职加人入口 ─────────────────────────────
{
  const notYet = await call(`/api/projects/p1/members/${pal.id}`, "PATCH", ownerKey, { role: "admin" });
  assert.equal(notYet.status, 404, `对还不是成员的人改角色要拒:${notYet.text}`);
  assert.match(String(notYet.body.error ?? ""), /还不是这个项目的成员/, notYet.text);
  assert.deepEqual(await rowsOf("p1"), [`${owner.id}:admin`], "被拒的改角色不许把人加进来");

  // 实例管理员在名单里是**隐式**行(listProjectMembers 现补的,标着 implicit),
  // 约定是「不能移除、不能改角色」—— 给它发 PATCH 同样不该凭空写出一行显式成员。
  const implicit = await call(`/api/projects/p1/members/${boss.id}`, "PATCH", ownerKey, { role: "member" });
  assert.equal(implicit.status, 404, `隐式管理员不该被改角色:${implicit.text}`);
  assert.match(String(implicit.body.error ?? ""), /隐式管理员/, implicit.text);
  assert.deepEqual(await rowsOf("p1"), [`${owner.id}:admin`], "隐式行不许被 PATCH 变成显式行");
}

// ── ③ 正常那条路照旧:先直加,再改角色 ──────────────────────────────────
{
  const added = await call("/api/projects/p1/members", "POST", ownerKey, { userId: pal.id, role: "member" });
  assert.equal(added.status, 201, `直加一个正常账号要成:${added.text}`);
  assert.deepEqual(await rowsOf("p1"), [`${owner.id}:admin`, `${pal.id}:member`].sort());

  const promoted = await call(`/api/projects/p1/members/${pal.id}`, "PATCH", ownerKey, { role: "admin" });
  assert.equal(promoted.status, 200, `改已有成员的角色要成:${promoted.text}`);
  assert.deepEqual(await rowsOf("p1"), [`${owner.id}:admin`, `${pal.id}:admin`].sort());

  // 最后一个显式管理员的保护仍按**真实**成员数算(ghost 行曾经也能顶这个名额)。
  const demote = await call(`/api/projects/p1/members/${pal.id}`, "PATCH", ownerKey, { role: "member" });
  assert.equal(demote.status, 200, `还有另一个管理员时降级要成:${demote.text}`);
}

// ── ④ 清理那条路不许被一起收紧 ──────────────────────────────────────────
// 停用之后仍然要能把人移出项目 —— 否则「先停用再清理」这条常规操作会卡死。
{
  await store.suspendUser(pal.id);
  const removed = await call(`/api/projects/p1/members/${pal.id}`, "DELETE", ownerKey);
  assert.equal(removed.status, 200, `移出一个停用成员必须还能做:${removed.text}`);
  assert.deepEqual(await rowsOf("p1"), [`${owner.id}:admin`]);
}

console.log("multi-user project members ok");
await releaseTmpDb();
rmSync(stage, { recursive: true, force: true });
