// 首启向导后半段(供应商 / 执行器 / 项目)的放行判据回归,对着 `src/onboarding.ts`。
//
// 这块的坑全在「什么时候**不该**弹向导」上,而那恰恰是看不见的那一半:
//   ① 空库 = 真·首次安装,弹。
//   ② 已经有执行器或项目 = 这台 ash 早就在用了。这一条是给**升级上来的老实例**兜底的
//      ——`onboardedAt` 这个键是本版才有的,老库里一个字都没有,只认标志位的话每台老
//      实例升完都会被糊一屏欢迎页。
//   ③ 用户表过态(onboardedAt)就一律放行,哪怕他三步全跳过、库还是空的。否则「以后
//      再说」点完刷新一下又回来,等于那颗按钮是假的。
//   ④ 多人模式按人算:执行器是个人面资源,新来的人有他自己那一套要配 —— 别人有执行器
//      不能替他算过。项目则按可见性算(被加进别人的项目就算有落脚处)。
//
// 跑法(不设 ASH_DB 时自己开一个临时库):
//   npm -w server run test:onboarding-gate
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireTmpDb, releaseTmpDb } from "./tmp-db.js";

const stage = mkdtempSync(join(tmpdir(), "ash-onboarding-gate-"));
process.env.ASH_DB ||= join(stage, "onboarding-gate.db");
requireTmpDb("test-onboarding-gate");

const { db, ensureSchema } = await import("../src/db/index.js");
const { agents, projects, projectMembers } = await import("../src/db/schema.js");
const { needsOnboarding } = await import("../src/onboarding.js");
const personal = await import("../src/auth/personal-settings.js");
const mode = await import("../src/auth/mode.js");
const store = await import("../src/auth/store.js");
const { SINGLE_ACTOR } = await import("../src/auth/context.js");

await ensureSchema();

const nowIso = () => new Date().toISOString();

// ── 自用模式 ──────────────────────────────────────────────────────────────
// ① 空库:向导必须出来。这是整个功能存在的理由,先把它钉死。
assert.equal(await needsOnboarding(SINGLE_ACTOR), true, "空库 = 首次安装,向导必须出来");

// ② 有执行器就算配过 —— 老实例升级上来走的正是这一条(库里没有 onboardedAt)。
await db.insert(agents).values({ id: "a1", name: "claude@local", type: "claude", isDefault: true });
assert.equal(await needsOnboarding(SINGLE_ACTOR), false, "已有执行器 = 这台 ash 早就在用了");
await db.delete(agents);
assert.equal(await needsOnboarding(SINGLE_ACTOR), true, "执行器删光后回到首装态");

// 只有项目、没有执行器,同样算配过(另一半老实例)。
await db.insert(projects).values({ id: "p1", name: "demo", repoPath: join(stage, "demo"), createdAt: nowIso() });
assert.equal(await needsOnboarding(SINGLE_ACTOR), false, "已有项目也算配过");
await db.delete(projects);

// ③ 三步全跳过也要放行:用户表过态就是表过态。
assert.equal(await needsOnboarding(SINGLE_ACTOR), true, "删干净之后先回到首装态");
await personal.patchSettingsFor(SINGLE_ACTOR, { onboardedAt: nowIso() });
assert.equal(await needsOnboarding(SINGLE_ACTOR), false, "点过「进入 ash」就不该再弹");

// ── 多人模式:按人算 ──────────────────────────────────────────────────────
const root = join(stage, "root");
mkdirSync(root, { recursive: true });
await mode.setInstanceMode("multi", root);

const admin = await store.createUser({
  name: "admin", role: "admin", dirName: "admin", gitName: "A", gitEmail: "a@x", createdBy: null,
});
const alice = await store.createUser({
  name: "alice", role: "member", dirName: "alice", gitName: "Al", gitEmail: "al@x", createdBy: admin.id,
});
const bob = await store.createUser({
  name: "bob", role: "member", dirName: "bob", gitName: "Bo", gitEmail: "bo@x", createdBy: admin.id,
});
const actorOf = (user: store.UserRow) => ({
  kind: "user" as const, userId: user.id, role: user.role, name: user.name,
});

// ④ 别人的执行器不替我算过:它是个人面资源,alice 要配她自己那一套。
await db.insert(agents).values({
  id: "a-bob", name: "claude@bob", type: "claude", isDefault: true, ownerUserId: bob.id,
});
assert.equal(await needsOnboarding(actorOf(bob)), false, "自己有执行器 = 配过了");
assert.equal(await needsOnboarding(actorOf(alice)), true, "别人的执行器不算我的");

// 项目按可见性算:被加进别人的项目就有落脚处了。
await db.insert(projects).values({
  id: "p-bob", name: "bob-app", repoPath: join(root, "bob", "app"), createdAt: nowIso(),
});
assert.equal(await needsOnboarding(actorOf(alice)), true, "看不见的项目不算我的落脚处");
await db.insert(projectMembers).values({
  projectId: "p-bob", userId: alice.id, role: "member", addedAt: nowIso(),
});
assert.equal(await needsOnboarding(actorOf(alice)), false, "被加进项目就有落脚处了");

// 自用模式那一段写下的 onboardedAt 还躺在全局那张表上。**它不许替多人模式下的任何人
// 表态** —— 那行的意思只是「转多人之前独自用这台机器的人走完过」,而上面 alice 的两条
// 断言恰恰证明它没被继承(她没有自己的执行器时照样判要走向导)。
await db.delete(projectMembers);
assert.equal(await needsOnboarding(actorOf(alice)), true, "清掉成员关系后 alice 回到首装态");
await personal.patchSettingsFor(actorOf(alice), { onboardedAt: nowIso() });
assert.equal(await needsOnboarding(actorOf(alice)), false, "alice 表过态");

const carol = await store.createUser({
  name: "carol", role: "member", dirName: "carol", gitName: "Ca", gitEmail: "ca@x", createdBy: admin.id,
});
assert.equal(await needsOnboarding(actorOf(carol)), true, "一个人表态不替另一个人表态");

// 实例管理员天然看得见所有项目(visibleProjectIds 对他不设限),所以只要这台机器上有
// 项目,他就有落脚处 —— 这一条写出来是因为它读起来像个漏洞,其实是可见性口径的直接推论。
assert.equal(await needsOnboarding(actorOf(admin)), false, "实例管理员看得见全部项目");

console.log("test-onboarding-gate ok");
await releaseTmpDb();
rmSync(stage, { recursive: true, force: true });
