// 首启转换与建用户的**失败半途**回归。判据只有一条,但它两处都栽了同一跤:
//
//   落库和建目录这两步之间一旦失败,不能留下一个「库里有、磁盘没有、谁也修不了」的状态。
//
//   ① `POST /auth/setup`:目录建不出来时,实例已经翻成 multi、管理员行已落库却没有
//      key —— 而 `needsSetup:false` 把向导藏了起来,谁也进不去,只能手改库(第 1 轮
//      审查 P0)。两层都要挡:**目录先建**(失败时库里一个字没动),外加 needsSetup 把
//      「multi 却没人能登录」也算进首启,让向导能把管理员补出来。
//   ② `POST /users`:同样的顺序问题。原来的写法留下一个没有邀请链接、也没有 key 的
//      用户,而它把姓名和目录名双双占死,管理员照原样重试直接 409(第 1 轮审查 P1)。
//   ③ 自带起手式的每人覆写:`(builtin_key, owner_user_id)` 是**每人一行**,按 key 查完
//      取第一行再判归属,会在别人的行排前面时把我自己的覆写当成不存在(第 1 轮审查 P2)。
//
// 跑法(不设 ASH_DB 时自己开一个临时库):
//   npm -w server run test:multi-user-setup
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireTmpDb, releaseTmpDb } from "./tmp-db.js";

const stage = mkdtempSync(join(tmpdir(), "ash-mu-setup-"));
process.env.ASH_DB ||= join(stage, "mu-setup.db");
requireTmpDb("test-multi-user-setup");

const { db, ensureSchema } = await import("../src/db/index.js");
const { users, workflows } = await import("../src/db/schema.js");
const { eq } = await import("drizzle-orm");
const { Hono } = await import("hono");
const mode = await import("../src/auth/mode.js");
const store = await import("../src/auth/store.js");
const { authGate } = await import("../src/auth/middleware.js");
const { mountAuthRoutes } = await import("../src/auth/routes.js");
const { mountUserRoutes } = await import("../src/auth/user-routes.js");
const { findWorkflow, listWorkflows } = await import("../src/workflows.js");
const { now, id } = await import("../src/util.js");

await ensureSchema();

const api = new Hono();
mountAuthRoutes(api);
mountUserRoutes(api);
const app = new Hono();
app.use("*", authGate());
app.route("/api", api);

type Res = { status: number; body: Record<string, unknown> };
const call = async (path: string, method: string, key: string | null, body?: unknown): Promise<Res> => {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (key) headers.authorization = `Bearer ${key}`;
  const res = await app.fetch(new Request(`http://127.0.0.1:4317${path}`, {
    method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
};

const root = join(stage, "root");
mkdirSync(root, { recursive: true });

// ── ① 首启转换:目录建不出来 → 库里一个字都不许动,而且要能重来 ────────────
{
  // 「admin」这个路径被一个**文件**占着 —— 报告里用的就是这一手。
  writeFileSync(join(root, "admin"), "占位");

  const blocked = await call("/api/auth/setup", "POST", null, {
    mode: "multi", adminName: "Admin", rootDir: root, dirName: "admin",
  });
  assert.equal(blocked.status, 409, `路径被占该当场拒绝:${JSON.stringify(blocked.body)}`);
  assert.match(String(blocked.body.error), /被一个文件占着/);

  // 关键的一条:**失败没有留下任何半成品**。
  mode.invalidateInstanceConfig();
  assert.equal((await mode.instanceConfig()).mode, "", "失败的转换不该把实例翻成 multi");
  assert.equal(await store.countUsers(), 0, "失败的转换不该留下用户行");
  assert.equal(await mode.needsSetup(), true, "向导必须还在");

  // 腾开路径,原样重试 —— 不需要任何手工修补。
  const { rmSync } = await import("node:fs");
  rmSync(join(root, "admin"));
  const ok = await call("/api/auth/setup", "POST", null, {
    mode: "multi", adminName: "Admin", rootDir: root, dirName: "admin",
  });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.ok(String(ok.body.key ?? "").length > 0, "该发一把能登录的 key");
  mode.invalidateInstanceConfig();
  assert.equal(await mode.needsSetup(), false, "建完了,向导该收起来");
}

// ── ② 「multi 却没人能登录」= 首启没走完,向导要能把管理员补出来 ────────────
{
  // 手工造出崩在半路的样子:模式已落、把唯一的管理员的 key 抹掉(等价于崩在
  // createUser 与 resetUserKey 之间)。这是 needsSetup 的第二种情形。
  const admin = (await db.select().from(users)).at(0)!;
  await db.update(users).set({ keyHash: null, status: "invited" }).where(eq(users.id, admin.id));
  mode.invalidateInstanceConfig();
  assert.equal(await mode.needsSetup(), true, "一个能登录的人都没有 = 实例锁死,向导必须回来");

  // 匿名(没有 key,本来也拿不到)重走一遍向导 —— 这正是被锁死时唯一的出路。
  const state = await call("/api/auth/state", "GET", null);
  assert.equal(state.body.needsSetup, true);
  assert.equal(state.body.rootDir, root, "根目录锁死了,得交给表单预填,否则只能靠用户记");

  // 补做中也不能倒回自用(§二),而且要说人话,不能抛个 500。
  const backWhileBroken = await call("/api/auth/setup", "POST", null, { mode: "single" });
  assert.equal(backWhileBroken.status, 409, JSON.stringify(backWhileBroken.body));
  assert.match(String(backWhileBroken.body.error), /只能把管理员补建出来/);

  const resumed = await call("/api/auth/setup", "POST", null, {
    mode: "multi", adminName: "Admin", rootDir: root, dirName: "admin",
  });
  assert.equal(resumed.status, 200, `补做必须放行,不能回「已经是多人模式了」:${JSON.stringify(resumed.body)}`);
  assert.ok(String(resumed.body.key ?? "").length > 0);
  assert.equal(await store.countUsers(), 1, "补做要认领那半个管理员,不是再插一行");
  assert.equal((await db.select().from(users)).at(0)!.id, admin.id, "认领的必须是原来那一行(存量数据都记在它名下)");

  mode.invalidateInstanceConfig();
  assert.equal(await mode.needsSetup(), false);
  // 补完之后这条门重新关上:再来一次就是普通的「已经是多人模式了」。
  const again = await call("/api/auth/setup", "POST", String(resumed.body.key), { mode: "multi", adminName: "X", rootDir: root, dirName: "x" });
  assert.equal(again.status, 409, JSON.stringify(again.body));
  assert.match(String(again.body.error), /已经是多人模式了/);
}

const adminRow = (await db.select().from(users)).at(0)!;
const adminKey = await store.resetUserKey(adminRow.id);

// ── ③ 建用户:目录建不出来 → 姓名和目录名都不许被占死 ──────────────────────
{
  writeFileSync(join(root, "bob"), "占位");
  const failed = await call("/api/users", "POST", adminKey, { name: "Bob", dirName: "bob" });
  assert.equal(failed.status, 409, `路径被占该当场拒绝:${JSON.stringify(failed.body)}`);
  assert.equal(await store.nameTaken("Bob"), false, "建失败不该把姓名占死");
  assert.equal(await store.dirNameTaken("bob"), false, "也不该把目录名占死");

  const { rmSync } = await import("node:fs");
  rmSync(join(root, "bob"));
  // 原样重试:管理员不必先去删一个看不见的残行。
  const ok = await call("/api/users", "POST", adminKey, { name: "Bob", dirName: "bob" });
  assert.equal(ok.status, 201, `腾开路径后原样重试就该成:${JSON.stringify(ok.body)}`);
  assert.ok(String(ok.body.inviteUrl ?? "").startsWith("/claim/"), "建成了就该有邀请链接");
}

// ── ④ 自带起手式的覆写按人取,不是按第一行取 ────────────────────────────────
{
  const ts = now();
  const bob = (await db.select().from(users)).find((u) => u.name === "Bob")!;
  // 两个人各改了同一条自带起手式。故意让**别人**那行排在前面(按 id 升序插入)。
  await db.insert(workflows).values([
    { id: "aaa-row", builtinKey: "standard", ownerUserId: adminRow.id, name: "A 标准", description: "", def: "{}", disabled: false, createdAt: ts, updatedAt: ts },
    { id: "zzz-row", builtinKey: "standard", ownerUserId: bob.id, name: "Z 标准", description: "", def: "{}", disabled: true, createdAt: ts, updatedAt: ts },
  ] as never);

  const detail = await findWorkflow("standard", bob.id);
  assert.equal(detail!.name, "Z 标准", "详情要给我自己的那份覆写,不是排在前面的别人那份");
  assert.equal(detail!.modified, true);
  assert.equal(detail!.disabled, true, "停用状态也得是我的");

  // 列表与详情对同一个人必须口径一致 —— 报告里它们是矛盾的。
  const fromList = (await listWorkflows(bob.id)).find((w) => w.id === "standard")!;
  assert.equal(fromList.name, detail!.name, "列表和详情不能对同一个人给出两种答案");
  assert.equal(fromList.disabled, detail!.disabled);

  // 另一个人看到的仍是他自己那份。
  assert.equal((await findWorkflow("standard", adminRow.id))!.name, "A 标准");
  // 谁的行都不是 → 出厂那份(自带条目永远在)。
  assert.equal((await findWorkflow("standard", id()))!.modified, false);
}

await releaseTmpDb();
console.log("test-multi-user-setup ok");
