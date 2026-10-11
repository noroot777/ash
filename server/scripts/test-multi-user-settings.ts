// 「默认规则」的**个人面 / 实例面之分**(§八)回归。从 test-multi-user.ts 的 ⑥ 组搬出来
// 单开一份:那个文件是十几组横切判据的合集,已经顶到单文件 700 行的上限,而这一块本身
// 还在长 —— 每加一个设置项都要在这里回答同一串问题(它该一人一份还是整台机器一份、
// 写侧拦不拦得住坏值、读侧认不认手改过的库)。
//
// 钉的是四件事:
//   ① 个人面一人一份:A 改了 B 不受影响,也不许漏进全局那份。
//   ② 实例面要实例管理员;接力目标机按人存,不许走 PATCH /settings。
//   ③ 写侧边界(parseAppSettingsPatch)认得出非法取值 —— 它才是 HTTP 那条路的闸。
//   ④ 读侧认不出的值(手改过的库 / 上一版留下的旧值)等同没写过,落回出厂默认,
//      而不是把一个界面上根本没有的档位端给设置页。
//
// 跑法(不设 ASH_DB 时自己开一个临时库):
//   npm -w server run test:multi-user-settings
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireTmpDb, releaseTmpDb } from "./tmp-db.js";

const stage = mkdtempSync(join(tmpdir(), "ash-multi-user-settings-"));
process.env.ASH_DB ||= join(stage, "multi-user-settings.db");
requireTmpDb("test-multi-user-settings");

const { db, ensureSchema } = await import("../src/db/index.js");
const { userSettings } = await import("../src/db/schema.js");
const mode = await import("../src/auth/mode.js");
const store = await import("../src/auth/store.js");
const personal = await import("../src/auth/personal-settings.js");
const appSettings = await import("../src/app-settings.js");
const { SINGLE_ACTOR } = await import("../src/auth/context.js");

await ensureSchema();

// ── 自用模式:这一层整个透明,读写都直落 app_settings ───────────────────────
{
  await personal.patchSettingsFor(SINGLE_ACTOR, { composerSendKey: "mod-enter" });
  assert.equal((await appSettings.getAppSettings()).composerSendKey, "mod-enter");
  await personal.patchSettingsFor(SINGLE_ACTOR, { composerSendKey: "enter" });
  assert.equal((await appSettings.getAppSettings()).composerSendKey, "enter");
}

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
const adminActor = actorOf(admin);
const aliceActor = actorOf(alice);
const bobActor = actorOf(bob);

// ── ① 个人面一人一份 ──────────────────────────────────────────────────────
{
  await personal.patchSettingsFor(aliceActor, { defaultWorkflowId: "alice-flow" });
  assert.equal((await personal.settingsFor(alice.id)).defaultWorkflowId, "alice-flow");
  assert.equal((await personal.settingsFor(bob.id)).defaultWorkflowId, "", "个人面互不影响");
  assert.equal((await appSettings.getAppSettings()).defaultWorkflowId, "", "个人面不该写进全局那份");

  // 「输入框按哪一下算发送」同样是个人面的一项:同一台机器上两个人各按各的习惯。
  await personal.patchSettingsFor(bobActor, { composerSendKey: "mod-enter" });
  assert.equal((await personal.settingsFor(bob.id)).composerSendKey, "mod-enter");
  assert.equal((await personal.settingsFor(alice.id)).composerSendKey, "enter", "没写过的人落回出厂默认");
  assert.equal((await appSettings.getAppSettings()).composerSendKey, "enter", "个人面不该写进全局那份");
}

// ── ② 实例面要管理员;接力目标机另走一条路 ────────────────────────────────
{
  await assert.rejects(
    () => personal.patchSettingsFor(aliceActor, { skillRefreshSeconds: 7200 }),
    /实例管理员/,
  );
  await personal.patchSettingsFor(adminActor, { skillRefreshSeconds: 7200 });
  assert.equal((await appSettings.getAppSettings()).skillRefreshSeconds, 7200);

  await assert.rejects(
    () => personal.patchSettingsFor(aliceActor, { handoffTargets: [] }),
    /接力目标机/,
  );
}

// ── ③ 写侧边界:HTTP 那条路在进 patchSettingsFor 之前就过这一道 ────────────
{
  assert.throws(
    () => appSettings.parseAppSettingsPatch({ composerSendKey: "ctrl-enter" }),
    /composerSendKey/,
  );
  assert.deepEqual(
    appSettings.parseAppSettingsPatch({ composerSendKey: "mod-enter" }),
    { composerSendKey: "mod-enter" },
  );
}

// ── ④ 读侧:认不出的值等同没写过 ──────────────────────────────────────────
{
  const encoded = JSON.stringify("cmd-enter");
  await db
    .insert(userSettings)
    .values({ userId: bob.id, key: "composerSendKey", value: encoded })
    .onConflictDoUpdate({ target: [userSettings.userId, userSettings.key], set: { value: encoded } });
  assert.equal((await personal.settingsFor(bob.id)).composerSendKey, "enter", "坏值等同没写过");
}

console.log("test-multi-user-settings ok");
await releaseTmpDb();
rmSync(stage, { recursive: true, force: true });
