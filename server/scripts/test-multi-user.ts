// 多人模式的横切回归。挑的都是「改一处就会静默塌掉别处」的判据:
//
//   ① 自用模式必须逐字节照旧 —— 所有闸在 single 下全是穿透。
//   ② 可见性:项目/任务/分组三条轴用**同一份**判据(auth/visibility.ts)。
//   ③ 路径钳制:普通用户只能用自己目录**之内、且不是目录根**的路径;管理员豁免。
//   ④ 派发闸:CLI 没接 relay、或执行器没挂供应商 → 拒绝派发(判据取自 catalog)。
//   ⑤ 跨人回合:任务归属人不是操作人时,执行器降级要**先能被探测出来**(弹窗的料)。
//   ⑥ 设置分面:worktree 默认/默认起手式一人一份;实例面要管理员。
//   ⑦ 个人面资源(执行器/供应商/起手式…)互不可见。
//   ⑧ 接力目标机按人存,key 永不回显。
//   ⑨ 请求体里带 id 的端点(建任务/建队列/随手记/挂供应商):横切闸拦不到,各自补。
//   ⑩ 全局 id 路由(queues / sessions)必须进横切闸。
//   ⑪ 免登录名单只放机器对机器那几条,本机设置面不在其中。
//   ⑫ 宿主机逃生门脚本(scripts/ash-admin.mjs)真能发出一条可领取的邀请。
//
// 跑法(不设 ASH_DB 时自己开一个临时库):
//   npm -w server run test:multi-user
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { requireTmpDb, releaseTmpDb } from "./tmp-db.js";

// 自带临时舞台:这条测试不碰真库,没有任何理由要求调用者先想好一个路径
// (test-handoff-auth.ts 同样的做法)。显式给了 ASH_DB 就用给的那个。
const stage = mkdtempSync(join(tmpdir(), "ash-multi-user-"));
process.env.ASH_DB ||= join(stage, "multi-user.db");
requireTmpDb("test-multi-user");

const { db, ensureSchema } = await import("../src/db/index.js");
const schema = await import("../src/db/schema.js");
const { agents, groups, projects, tasks } = schema;
const mode = await import("../src/auth/mode.js");
const store = await import("../src/auth/store.js");
const visibility = await import("../src/auth/visibility.js");
const pathScope = await import("../src/auth/path-scope.js");
const gate = await import("../src/auth/dispatch-gate.js");
const personal = await import("../src/auth/personal-settings.js");
const owned = await import("../src/auth/owned.js");
const { SINGLE_ACTOR } = await import("../src/auth/context.js");
const appSettings = await import("../src/app-settings.js");

await ensureSchema();

const root = join(stage, "root");
mkdirSync(root, { recursive: true });

const actorOf = (user: store.UserRow) => ({
  kind: "user" as const,
  userId: user.id,
  role: user.role,
  name: user.name,
});

// ── ① 自用模式:所有闸穿透 ──────────────────────────────────────────────────
{
  assert.equal(await mode.isMultiUser(), false, "还没设过模式时不该是多人");
  assert.equal(await visibility.visibleProjectIds(SINGLE_ACTOR), null, "自用模式不该有可见集限制");
  assert.equal(await visibility.projectRoleOf(SINGLE_ACTOR, "whatever"), "admin");
  assert.equal(await pathScope.homeDirOf(SINGLE_ACTOR), null, "自用模式不钳路径");
  assert.equal(await pathScope.projectPathRejection(SINGLE_ACTOR, "/anywhere/at/all"), null);
  assert.equal(await owned.ownedScope(SINGLE_ACTOR), null, "自用模式的资源不分归属");
  // 设置写入仍旧直落 app_settings。
  await personal.patchSettingsFor(SINGLE_ACTOR, { worktreeDefault: false });
  assert.equal((await appSettings.getAppSettings()).worktreeDefault, false);
  await personal.patchSettingsFor(SINGLE_ACTOR, { worktreeDefault: true });
}

// ── 转多人 ────────────────────────────────────────────────────────────────
await mode.setInstanceMode("multi", root);
assert.equal(await mode.isMultiUser(), true);

const admin = await store.createUser({
  name: "admin", role: "admin", dirName: "admin", gitName: "A", gitEmail: "a@x", createdBy: null,
});
const alice = await store.createUser({
  name: "alice", role: "member", dirName: "alice", gitName: "Al", gitEmail: "al@x", createdBy: admin.id,
});
const bob = await store.createUser({
  name: "bob", role: "member", dirName: "bob", gitName: "Bo", gitEmail: "bo@x", createdBy: admin.id,
});
await mode.ensureUserHomeDir("alice");
await mode.ensureUserHomeDir("bob");

const adminActor = actorOf(admin);
const aliceActor = actorOf(alice);
const bobActor = actorOf(bob);

// ── ② 可见性:项目 / 任务 / 分组同一份判据 ─────────────────────────────────
{
  const at = new Date().toISOString();
  await db.insert(projects).values([
    { id: "p-alice", name: "alice-proj", repoPath: join(root, "alice", "proj"), apiKeys: null, workflowId: null, createdAt: at, ownerUserId: alice.id },
    { id: "p-bob", name: "bob-proj", repoPath: join(root, "bob", "proj"), apiKeys: null, workflowId: null, createdAt: at, ownerUserId: bob.id },
  ]);
  await visibility.addProjectMember({ projectId: "p-alice", userId: alice.id, role: "admin", addedBy: alice.id });
  await visibility.addProjectMember({ projectId: "p-bob", userId: bob.id, role: "admin", addedBy: bob.id });

  const aliceVisible = await visibility.visibleProjectIds(aliceActor);
  assert.deepEqual([...aliceVisible!], ["p-alice"], "alice 只该看见自己的项目");
  assert.equal(await visibility.visibleProjectIds(adminActor), null, "实例管理员看得见一切");
  assert.equal(await visibility.canSeeProject(aliceActor, "p-bob"), false);
  assert.equal(await visibility.projectRoleOf(aliceActor, "p-bob"), null);
  // 实例管理员进任意项目权限等同项目管理员(§四),但不在成员表里。
  assert.equal(await visibility.projectRoleOf(adminActor, "p-bob"), "admin");
  const bobMembers = await visibility.listProjectMembers("p-bob");
  const implicit = bobMembers.find((m) => m.userId === admin.id);
  assert.ok(implicit?.implicit, "实例管理员应作为隐式成员出现在名单里");

  await db.insert(tasks).values([
    { id: "t-alice", projectId: "p-alice", title: "a", body: "", status: "backlog", createdAt: at, updatedAt: at, ownerUserId: alice.id },
    { id: "t-bob", projectId: "p-bob", title: "b", body: "", status: "backlog", createdAt: at, updatedAt: at, ownerUserId: bob.id },
  ] as never);
  assert.deepEqual(await visibility.visibleTaskIds(aliceActor, ["t-alice", "t-bob"]), ["t-alice"]);
  assert.deepEqual(await visibility.visibleTaskIds(adminActor, ["t-alice", "t-bob"]), ["t-alice", "t-bob"]);

  await db.insert(groups).values([
    { id: "g-bob", projectId: "p-bob", name: "g", mode: "parallel", paused: false, createdAt: at },
  ] as never);
  // 分组跟项目走:同一份 visibleProjectIds,不是另抄一份 SQL。
  const visibleForAlice = await visibility.visibleProjectIds(aliceActor);
  assert.equal(visibleForAlice!.has("p-bob"), false);

  // 「摘掉 alice 之后 p-alice 还剩几个显式管理员」= 0 → 前端据此禁掉移除按钮。
  assert.equal(await visibility.explicitProjectAdminCount("p-alice", alice.id), 0);
  await visibility.addProjectMember({ projectId: "p-alice", userId: bob.id, role: "admin", addedBy: alice.id });
  assert.equal(await visibility.explicitProjectAdminCount("p-alice", alice.id), 1, "多一个管理员就该放行");
  await visibility.removeProjectMember("p-alice", bob.id);
}

// ── ③ 路径钳制 ────────────────────────────────────────────────────────────
{
  const aliceHome = join(root, "alice");
  assert.equal(await pathScope.homeDirOf(adminActor), null, "实例管理员不受钳制");
  assert.equal(await pathScope.projectPathRejection(adminActor, join(root, "bob", "x")), null);

  assert.equal(await pathScope.projectPathRejection(aliceActor, join(aliceHome, "proj")), null);
  assert.ok(
    await pathScope.projectPathRejection(aliceActor, aliceHome),
    "用户目录根本身不许注册成项目(§七 D10)",
  );
  assert.ok(
    await pathScope.projectPathRejection(aliceActor, join(root, "bob", "proj")),
    "不许把项目建到别人目录里",
  );
  assert.ok(
    await pathScope.projectPathRejection(aliceActor, join(stage, "outside")),
    "不许跑到根目录外面",
  );
  // 空路径放行:「先建项目、回头补路径」是既有正常用法。
  assert.equal(await pathScope.projectPathRejection(aliceActor, ""), null);
}

// ── ④ 派发闸 ──────────────────────────────────────────────────────────────
{
  assert.equal(gate.cliSupportsRelay("claude"), true);
  assert.equal(gate.cliSupportsRelay("codex"), true);
  assert.equal(gate.cliSupportsRelay("gemini"), false, "gemini 未接 relay,多人模式不可派发");
  // 判据取自 catalog:接了 relay 但没挂供应商同样拒绝。
  assert.equal(gate.dispatchBlockReason("claude", "prov-1"), null);
  assert.ok(gate.dispatchBlockReason("claude", null));
  assert.ok(gate.dispatchBlockReason("gemini", "prov-1"));
}

// ── ⑤ 跨人回合:执行器降级可被探测 ────────────────────────────────────────
{
  await db.insert(agents).values([
    { id: "ex-alice", name: "claude@alice", type: "claude", model: null, extraArgs: "[]", reasoningEffort: null, speed: null, providerId: "prov-1", isDefault: true, ownerUserId: alice.id },
    { id: "ex-bob", name: "claude@bob", type: "claude", model: null, extraArgs: "[]", reasoningEffort: null, speed: null, providerId: "prov-1", isDefault: true, ownerUserId: bob.id },
  ] as never);
  await db.update(tasks).set({ executorId: "ex-alice", agentType: "claude" }).where(eq(tasks.id, "t-alice"));

  // 本人跑自己的任务:没有降级,不该弹窗。
  assert.equal(await gate.executorDowngradePreflight("t-alice", alice.id), null);
  // 别人来跑:原执行器是 alice 的私有资源,应降级到操作人自己的默认执行器。
  const downgrade = await gate.executorDowngradePreflight("t-alice", bob.id);
  assert.ok(downgrade, "跨人回合应探测到降级");
  assert.equal(downgrade!.fromName, "claude@alice");
  assert.equal(downgrade!.toName, "claude@bob");
  // 探不到本人默认执行器时也要给出结论,不能静默放行。
  assert.ok(await gate.executorDowngradePreflight("t-alice", admin.id));
}

// ── ⑥ 设置分面 ────────────────────────────────────────────────────────────
{
  await personal.patchSettingsFor(aliceActor, { worktreeDefault: false });
  assert.equal((await personal.settingsFor(alice.id)).worktreeDefault, false);
  assert.equal((await personal.settingsFor(bob.id)).worktreeDefault, true, "个人面互不影响");
  assert.equal((await appSettings.getAppSettings()).worktreeDefault, true, "个人面不该写进全局那份");

  // 实例面:普通用户改不动,管理员可以。
  await assert.rejects(
    () => personal.patchSettingsFor(aliceActor, { skillRefreshSeconds: 7200 }),
    /实例管理员/,
  );
  await personal.patchSettingsFor(adminActor, { skillRefreshSeconds: 7200 });
  assert.equal((await appSettings.getAppSettings()).skillRefreshSeconds, 7200);

  // 多人模式的接力目标机按人存,不许走 PATCH /settings。
  await assert.rejects(
    () => personal.patchSettingsFor(aliceActor, { handoffTargets: [] }),
    /接力目标机/,
  );
}

// ── ⑦ 个人面资源互不可见 ──────────────────────────────────────────────────
{
  assert.equal(await owned.ownedScope(aliceActor), alice.id);
  assert.equal(await owned.ownedScope(adminActor), admin.id, "管理员的私有资源也只是他自己的");
  const rows = [{ ownerUserId: alice.id }, { ownerUserId: bob.id }, { ownerUserId: null }];
  const forAlice = await owned.filterOwned(rows, aliceActor);
  assert.deepEqual(forAlice.map((r) => r.ownerUserId), [alice.id], "别人的私有资源不该出现");
  assert.equal(await owned.canUseOwned({ ownerUserId: bob.id }, aliceActor), false);
  assert.equal(await owned.canUseOwned({ ownerUserId: alice.id }, aliceActor), true);
}

// ── ⑧ 接力目标机按人 ──────────────────────────────────────────────────────
{
  const scope = await import("../src/auth/handoff-scope.js");
  await scope.addTarget(aliceActor, { name: "家里", url: "http://10.0.0.2:4317", peerKey: "ash_secret" });
  const aliceTargets = await scope.listTargets(aliceActor);
  assert.equal(aliceTargets.length, 1);
  assert.equal(aliceTargets[0].hasKey, true);
  assert.equal((aliceTargets[0] as { peerKey?: string }).peerKey, undefined, "key 绝不回显");
  assert.deepEqual(await scope.listTargets(bobActor), [], "目标机清单按人隔离");
  assert.equal(await scope.peerKeyFor(alice.id, "http://10.0.0.2:4317/"), "ash_secret", "尾斜杠不该影响匹配");
  assert.equal(await scope.peerKeyFor(bob.id, "http://10.0.0.2:4317"), "");

  // 换地址要把记住的指纹一起清掉。
  await scope.rememberPeerFingerprint(alice.id, "http://10.0.0.2:4317", "f".repeat(64));
  assert.equal((await scope.listTargets(aliceActor))[0].peerFp, "f".repeat(64));
  const id0 = (await scope.listTargets(aliceActor))[0].id!;
  await scope.patchTarget(aliceActor, id0, { url: "http://10.0.0.3:4317" });
  assert.equal((await scope.listTargets(aliceActor))[0].peerFp, null, "换地址应清掉旧指纹");
}

// ── ⑨ 全局 id 路由必须进横切闸 ────────────────────────────────────────────
// queues / sessions 的路径里没有 task 或 project 段(`/api/queues/:id`、
// `/api/sessions/:id/output`),第 1 轮审查前它们整个漏在闸外:拿到 queueId 能读别人
// 的任务标题、改别人的队列顺序,拿到 sessionId 能读完整 agent transcript。
{
  const { queueItems, sessions } = schema;
  const at = new Date().toISOString();
  await db.insert(queueItems).values([{ taskId: "t-bob", queueId: "q-bob", position: 0, createdAt: at }] as never);
  await db.insert(sessions).values([
    { id: "s-bob", taskId: "t-bob", role: "main", agentType: "claude", executor: "claude@bob", status: "done", startedAt: at },
  ] as never);

  const gateModule = await import("../src/auth/resource-gate.js");
  const hit = async (actor: unknown, path: string): Promise<number> => {
    let passed = false;
    const c = {
      req: { path, url: `http://x${path}` },
      get: () => actor,
      json: (_body: unknown, status?: number) => ({ status: status ?? 200 }),
    };
    const res = await gateModule.resourceGate()(c as never, async () => { passed = true; });
    return passed ? 200 : (res as { status: number }).status;
  };

  assert.equal(await hit(bobActor, "/api/queues/q-bob"), 200, "自己的队列当然读得到");
  assert.equal(await hit(aliceActor, "/api/queues/q-bob"), 404, "别人的队列必须被闸拦下");
  assert.equal(await hit(aliceActor, "/api/queues/q-bob/reorder"), 404, "写端同样要拦");
  assert.equal(await hit(bobActor, "/api/sessions/s-bob/output"), 200);
  assert.equal(await hit(aliceActor, "/api/sessions/s-bob/output"), 404, "transcript 是整段会话原文");
  assert.equal(await hit(aliceActor, "/api/sessions/s-bob/trace"), 404);
  // 实例管理员看得见一切;不存在的 id 交给业务路由报它自己的 404(闸放行)。
  assert.equal(await hit(adminActor, "/api/queues/q-bob"), 200);
  assert.equal(await hit(aliceActor, "/api/queues/does-not-exist"), 200);
}

// ── ⑩ 请求体里带 id 的端点:横切闸拦不到,各自补 ──────────────────────────
// 闸只解析路径。建任务/建队列/建随手记/挂供应商这几条把 id 放在 body 里,
// 所以每一条都得自己过一次判据 —— 这里验的就是「那句判据还在」。
{
  // 随手记:两条轴叠加(归属 + 项目可见),缺一不可。
  assert.equal(await visibility.canSeeProject(aliceActor, "p-bob"), false);
  assert.equal(await visibility.canSeeProject(bobActor, "p-bob"), true);
  // 任务回链会把标题拼进应答,所以过的是 visibleTaskIds 而不是「note 是我的」。
  assert.deepEqual(await visibility.visibleTaskIds(aliceActor, ["t-bob"]), []);
  assert.deepEqual(await visibility.visibleTaskIds(bobActor, ["t-bob"]), ["t-bob"]);
}

// ── ⑪ 供应商归属:执行器不许挂别人的 key ─────────────────────────────────
{
  const { llmProviders } = schema;
  await db.insert(llmProviders).values([
    { id: "prov-bob", name: "bob 的中转", baseUrl: "http://x", apiKey: "sk-bob", createdAt: new Date().toISOString(), ownerUserId: bob.id },
  ] as never);
  const row = (await db.select().from(llmProviders).where(eq(llmProviders.id, "prov-bob"))).at(0);
  assert.equal(await owned.canUseOwned(row, bobActor), true);
  assert.equal(
    await owned.canUseOwned(row, aliceActor),
    false,
    "alice 建执行器时填 bob 的 providerId 必须被拒 —— 否则派发时烧的是 bob 的 key",
  );
  // 实例管理员也不例外:他管的是用户和实例设置,不是别人的 API key。
  assert.equal(await owned.canUseOwned(row, adminActor), false);
}

// ── ⑫ 免登录名单:只放机器对机器那几条 ──────────────────────────────────
// `/api/handoff/` 整个前缀曾经免登录,于是局域网里任何未登录的人都能批准入站机器
// 信任(第 1 轮审查 P0)。这条判据锁住「豁口逐条列,不放前缀」。
{
  const mw = await import("../src/auth/middleware.js");
  const open = (path: string) => mw.isPublicApiPath(path);
  for (const path of [
    "/api/handoff/ping", "/api/handoff/import",
    "/api/handoff/return/ping", "/api/handoff/return/import",
    "/api/handoff/proxy/task/snapshot", "/api/handoff/proxy/tasks/state",
  ]) {
    assert.equal(open(path), true, `${path} 是对端服务端来调的,到不了登录态`);
  }
  for (const path of [
    "/api/handoff/peers",
    "/api/handoff/peers/aaaa/approve",
    "/api/handoff/targets",
    "/api/handoff/request",
    "/api/handoff/identity",
    "/api/handoff/return-grants",
  ]) {
    assert.equal(open(path), false, `${path} 是本机设置面,多人模式下必须先登录`);
  }
}

// ── ⑬ 宿主机逃生门:真能发出一条可领取的邀请 ────────────────────────────
// 「唯一的管理员丢了 key」时它是唯一的路,所以列名/编码写错了不能等到那一刻才发现。
{
  const { execFileSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const script = fileURLToPath(new URL("../../scripts/ash-admin.mjs", import.meta.url));
  const env = { ...process.env, ASH_DB: process.env.ASH_DB! };

  const status = execFileSync("node", [script, "status"], { env, encoding: "utf8" });
  assert.match(status, /实例模式:multi/, "app_settings 存的是 JSON,裸比字符串会永远判成不是多人");

  const out = execFileSync("node", [script, "invite-admin"], { env, encoding: "utf8" });
  const token = /\/claim\/(\S+)/.exec(out)?.[1];
  assert.ok(token, `invite-admin 没打出领取链接:${out}`);
  // 真拿这个 token 走一遍领取判据 —— 光「命令没报错」证明不了链接能用。
  const invite = await store.loadInvite(token!);
  assert.ok(invite, "逃生门发出的邀请查不到");
  assert.equal(invite!.invalid, null, `邀请不可用:${invite!.invalid}`);
  assert.equal(invite!.row.userId, admin.id, "invite-admin 该发给第一个管理员");
  // 它顺带作废旧 key:「我丢了 key」的正确语义就是旧的从现在起打不开门。
  const refreshed = (await db.select().from(schema.users).where(eq(schema.users.id, admin.id))).at(0);
  assert.equal(refreshed?.keyHash, null, "发新链接必须同时作废旧 key");
}

await releaseTmpDb();
rmSync(stage, { recursive: true, force: true });
console.log("test-multi-user ok");
