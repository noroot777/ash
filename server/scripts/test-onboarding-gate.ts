// 首启向导后半段(供应商 / 执行器 / 项目)的放行判据回归,对着 `src/onboarding.ts`
// 与 `src/db/migrate-onboarding.ts`。
//
// 这块的坑全在「什么时候**不该**弹向导」上,而那恰恰是看不见的那一半:
//   ① 空库 = 真·首次安装,弹。
//   ② **走到一半建出来的资源不算走完**。判据曾经是「有执行器或项目就算配过」,本意
//      是给升级上来的老实例兜底,实测却反过来咬住了首装:在向导第二站注册完执行器、
//      一刷新向导就自己消失了。老实例的豁免因此改在**版本边界**上一次性盖章,库里
//      之后长出什么都不再改变结论。
//   ③ 用户表过态(onboardedAt)就一律放行,哪怕他三步全跳过、库还是空的。否则「以后
//      再说」点完刷新一下又回来,等于那颗按钮是假的。
//   ④ 多人模式按人算:新来的人有他自己那一套要配,别人的执行器、别人拉他进的项目都
//      不替他算过 —— 那两样正是他**还没配**的证据,不是配过的证据。
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

const { db, dbClient, ensureSchema } = await import("../src/db/index.js");
const { agents, appSettings, projects, projectMembers, userSettings } = await import("../src/db/schema.js");
const { ONBOARDING_BASELINE_KEY, stampOnboardingBaseline } = await import("../src/db/migrate-onboarding.js");
const { needsOnboarding } = await import("../src/onboarding.js");
const personal = await import("../src/auth/personal-settings.js");
const mode = await import("../src/auth/mode.js");
const store = await import("../src/auth/store.js");
const { SINGLE_ACTOR } = await import("../src/auth/context.js");
const { eq } = await import("drizzle-orm");

await ensureSchema();

const nowIso = () => new Date().toISOString();
const baselineRow = async () =>
  (await db.select().from(appSettings).where(eq(appSettings.key, ONBOARDING_BASELINE_KEY))).at(0);

// ── 版本边界 ──────────────────────────────────────────────────────────────
// `ensureSchema` 里的那一遍已经跑过了:空库 → 只落标记,一个章都不盖。
assert.ok(await baselineRow(), "起库时就该把版本边界标下来");
assert.equal(
  (await db.select().from(appSettings).where(eq(appSettings.key, "onboardedAt"))).length,
  0,
  "空库首装不该被盖「走过向导」的章",
);

// ── 自用模式 ──────────────────────────────────────────────────────────────
// ① 空库:向导必须出来。这是整个功能存在的理由,先把它钉死。
assert.equal(await needsOnboarding(SINGLE_ACTOR), true, "空库 = 首次安装,向导必须出来");

// ② 向导走到一半建出来的东西**不算走完**。这两条是那次误判的回归锁:当时刷新一下
// 向导就没了,人被丢在「还没有可用项目」那一屏上。
await db.insert(agents).values({ id: "a1", name: "claude@local", type: "claude", isDefault: true });
assert.equal(await needsOnboarding(SINGLE_ACTOR), true, "刚注册出执行器 ≠ 走完向导");
await db.insert(projects).values({ id: "p1", name: "demo", repoPath: join(stage, "demo"), createdAt: nowIso() });
assert.equal(await needsOnboarding(SINGLE_ACTOR), true, "刚建出项目 ≠ 走完向导");

// 边界已经标过了,此刻库里长出什么都不该再触发补盖章(否则等于把 ② 放回去)。
await stampOnboardingBaseline(dbClient);
assert.equal(await needsOnboarding(SINGLE_ACTOR), true, "边界只认一次,之后的资源不补盖章");

// ③ 三步全跳过也要放行:用户表过态就是表过态。
await personal.patchSettingsFor(SINGLE_ACTOR, { onboardedAt: nowIso() });
assert.equal(await needsOnboarding(SINGLE_ACTOR), false, "点过「进入 ash」就不该再弹");

// ── 老实例升上来:边界那一刻库里已经有东西 ────────────────────────────────
// 模拟升级:把标记和表态都清掉(= 这个库是上一版建的),库里留着执行器和项目,再跑
// 一次迁移。老实例一个字的 onboardedAt 都没有,全靠这一遍盖章才不会被糊一屏欢迎页。
await db.delete(appSettings).where(eq(appSettings.key, ONBOARDING_BASELINE_KEY));
await db.delete(appSettings).where(eq(appSettings.key, "onboardedAt"));
assert.equal(await needsOnboarding(SINGLE_ACTOR), true, "清掉表态后回到首装态（前置条件）");
await stampOnboardingBaseline(dbClient);
assert.equal(await needsOnboarding(SINGLE_ACTOR), false, "边界上已经有执行器/项目 = 老实例,不弹");

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

// 自用模式那段写下的 onboardedAt 还躺在全局那张表上。**它不许替多人模式下的任何人
// 表态** —— 那行的意思只是「转多人之前独自用这台机器的人走完过」。
assert.equal(await needsOnboarding(actorOf(alice)), true, "全局那行不替新成员表态");
assert.equal(await needsOnboarding(actorOf(admin)), true, "管理员也一样:没过户就得自己走一遍");

// ④ 别人的执行器不替我算过 —— 它是个人面资源,alice 要配她自己那一套。
await db.insert(agents).values({
  id: "a-bob", name: "claude@bob", type: "claude", isDefault: true, ownerUserId: bob.id,
});
assert.equal(await needsOnboarding(actorOf(alice)), true, "别人的执行器不算我的");
assert.equal(await needsOnboarding(actorOf(bob)), true, "自己的执行器也只证明有执行器,不证明走过向导");

// 被加进别人的项目同样不算:新同事入职当天就被拉进共享项目是常态,而他自己连一个
// 执行器都还没有 —— 正该被领一遍(这一条当初被判成「有落脚处,跳过」)。
await db.insert(projects).values({
  id: "p-bob", name: "bob-app", repoPath: join(root, "bob", "app"), createdAt: nowIso(),
});
await db.insert(projectMembers).values({
  projectId: "p-bob", userId: alice.id, role: "member", addedAt: nowIso(),
});
assert.equal(await needsOnboarding(actorOf(alice)), true, "被提前加进共享项目不等于配过");

await personal.patchSettingsFor(actorOf(alice), { onboardedAt: nowIso() });
assert.equal(await needsOnboarding(actorOf(alice)), false, "alice 表过态");
assert.equal(await needsOnboarding(actorOf(bob)), true, "一个人表态不替另一个人表态");

// ── 自用转多人:初始管理员的表态要跟着存量数据一起过户 ────────────────────
// 转换前他已经走完过向导(全局那行),不带过去的话他下次登录会被从头领一遍。
const { claimExistingDataFor } = await import("../src/auth/conversion.js");
await claimExistingDataFor(admin.id);
assert.equal(await needsOnboarding(actorOf(admin)), false, "转多人时初始管理员继承那条表态");
assert.equal(
  (await db.select().from(userSettings).where(eq(userSettings.userId, bob.id))).length,
  0,
  "过户只给初始管理员,不给别人",
);

console.log("test-onboarding-gate ok");
await releaseTmpDb();
rmSync(stage, { recursive: true, force: true });
