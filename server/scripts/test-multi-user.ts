// 多人模式的横切回归。挑的都是「改一处就会静默塌掉别处」的判据:
//
//   ① 自用模式必须逐字节照旧 —— 所有闸在 single 下全是穿透。
//   ② 可见性:项目/任务/分组三条轴用**同一份**判据(auth/visibility.ts)。
//   ③ 路径钳制 —— 已搬到 test-multi-user-paths.ts(判据本身长成一整块了)。
//   ④ 派发闸:CLI 没接 relay、或执行器没挂供应商 → 拒绝派发(判据取自 catalog)。
//   ⑤ 跨人回合:任务归属人不是操作人时,执行器降级要**先能被探测出来**(弹窗的料)。
//   ⑥ 设置分面:worktree 默认/默认起手式一人一份;实例面要管理员。
//   ⑦ 个人面资源(执行器/供应商/起手式…)互不可见。
//   ⑧ 接力目标机按人存,key 永不回显。
//   ⑨ 请求体里带 id 的端点(建任务/建队列/随手记/挂供应商):横切闸拦不到,各自补。
//   ⑩ 全局 id 路由(queues / sessions)必须进横切闸。
//   ⑪ 免登录名单只放机器对机器那几条,本机设置面不在其中。
//   ⑫ 宿主机逃生门脚本(scripts/ash-admin.mjs)真能发出一条可领取的邀请。
//   ⑬ 执行器归属:写侧存不进别人的 id,读侧回退不出别人的名字。
//   ⑭ 穿过完整 authGate 的 HTTP 回归:供应商 relay 打得通、供应商 CRUD 仍要登录、
//      `/llm-providers/test` 用不了别人的 key。
//   ⑮ 「选谁干活」的另外两个表面 —— duet 两位讨论者、团队派活 —— 同样按人收窄。
//   ⑯ 收窄按谁:锚在**任务归属人**,不是这次点它的人(共享项目 / 继承父任务)。
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

// ── ③ 路径钳制 → 已搬到 test-multi-user-paths.ts ──────────────────────────
// 三态判据 + 六个入口自己长成一整块了,留在这份合集里只会把它压成一行断言。

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

  // 本人跑自己的任务:没有降级,不该弹窗。空列表 = 不弹。
  assert.deepEqual(await gate.executorDowngradePreflight("t-alice", alice.id), []);
  // 别人来跑:原执行器是 alice 的私有资源,应降级到操作人自己的默认执行器。
  const downgrades = await gate.executorDowngradePreflight("t-alice", bob.id);
  assert.equal(downgrades.length, 1, "跨人回合应探测到降级");
  assert.equal(downgrades[0].slot, "task", "普通任务只有顶层这一格");
  assert.equal(downgrades[0].fromName, "claude@alice");
  assert.equal(downgrades[0].fromOwner, alice.name);
  assert.equal(downgrades[0].toName, "claude@bob");
  // 探不到本人默认执行器时也要给出结论,不能静默放行(toName 为 null,前端照样弹)。
  const noDefault = await gate.executorDowngradePreflight("t-alice", admin.id);
  assert.equal(noDefault.length, 1);
  assert.equal(noDefault[0].toName, null);
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
  assert.equal(await scope.peerKeyForRequest(alice.id, "http://10.0.0.2:4317/"), "ash_secret", "尾斜杠不该影响匹配");
  assert.equal(await scope.peerKeyForRequest(bob.id, "http://10.0.0.2:4317"), "");

  // 换地址要把记住的指纹一起清掉。
  await scope.rememberPeerFingerprint(alice.id, "http://10.0.0.2:4317", "f".repeat(64));
  assert.equal((await scope.listTargets(aliceActor))[0].peerFp, "f".repeat(64));
  const id0 = (await scope.listTargets(aliceActor))[0].id!;
  await scope.patchTarget(aliceActor, id0, { url: "http://10.0.0.3:4317" });
  assert.equal((await scope.listTargets(aliceActor))[0].peerFp, null, "换地址应清掉旧指纹");

  // 按**地址**配 key(接力对话框里就地补 key 走的是这条路:那里只有地址,没有行 id)。
  // 它必须仍然钉在「这个人自己的清单」上 —— 否则拿一个地址就能改别人的对端凭证。
  await scope.setPeerKey(aliceActor, "http://10.0.0.3:4317/", "ash_by_url");
  assert.equal(await scope.peerKeyForRequest(alice.id, "http://10.0.0.3:4317"), "ash_by_url");
  await assert.rejects(
    () => scope.setPeerKey(bobActor, "http://10.0.0.3:4317", "bob_tries"),
    /先把这台目标机加进/,
    "地址不在自己的清单里就该被拒,不能落到别人那一行上",
  );
  assert.equal(await scope.peerKeyForRequest(alice.id, "http://10.0.0.3:4317"), "ash_by_url", "别人的写入没有污染");
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
//
// 反过来漏一条同样致命:refs 和 identity 曾经**不在**名单里,多人目标机于是在通用闸上
// 先回 401,路由自己那三道更严的闸(来源机已批准 → 验签 → 那个账号看不看得见这个项目)
// 一条都到不了,多人↔多人的 Git 接力整个走不通(第 1 轮审查 P1)。所以两个方向都钉。
{
  const mw = await import("../src/auth/middleware.js");
  const open = (path: string) => mw.isPublicApiPath(path);
  for (const path of [
    "/api/handoff/ping", "/api/handoff/import",
    "/api/handoff/return/ping", "/api/handoff/return/import",
    "/api/handoff/proxy/task/snapshot", "/api/handoff/proxy/tasks/state",
    // 对端服务端来调:refs 只带机器签名 + peer user key,identity 连签名都没有。
    "/api/handoff/projects/p-alice/refs",
    "/api/handoff/identity",
    // 宿主机运维脚本(scripts/restart.mjs)来调:它手上没有任何网页登录态,凭证是锁
    // 文件里那串 token,在路由内校验。
    "/api/restart-impact",
  ]) {
    assert.equal(open(path), true, `${path} 到不了登录态,必须在名单里`);
  }
  // 供应商 relay:CLI 只带得出供应商 API key,带不出 ash 身份 —— 豁口钉死到 /v1 那一段。
  for (const path of [
    "/api/llm-providers/prov-1/convert/v1",
    "/api/llm-providers/prov-1/convert/v1/chat/completions",
    "/api/llm-providers/prov-1/context-1m/v1",
    "/api/llm-providers/prov-1/context-1m/v1/messages",
  ]) {
    assert.equal(open(path), true, `${path} 是 CLI 回连本机的 relay,带不上 ash 身份`);
  }
  for (const path of [
    "/api/llm-providers",
    "/api/llm-providers/prov-1",
    "/api/llm-providers/test",
    "/api/llm-providers/prov-1/convert",
    "/api/llm-providers/prov-1/convert/v2/chat",
    "/api/handoff/peers",
    "/api/handoff/peers/aaaa/approve",
    "/api/handoff/targets",
    "/api/handoff/request",
    "/api/handoff/return-grants",
    // 形状必须钉死:放宽成前缀,底下将来长出来的任何东西都会跟着免登录。
    "/api/handoff/projects",
    "/api/handoff/projects/p-alice",
    "/api/handoff/projects/p-alice/refs/extra",
    "/api/restart-impact/detail",
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

// ── ⑬ 执行器归属:写侧存不进别人的 id,读侧回退不出别人的名字 ──────────────
// 第 2 轮审查 P1:alice 的 `GET /agents` 是空的,却能拿 bob 的 executor id 建任务/预设/
// 审查者,响应里连名字一起回显;连 `executorId:null` 的默认回退都会落到 bob 的默认执行器。
{
  const ownedExecutors = await import("../src/auth/owned-executors.js");
  const aliceScope = await ownedExecutors.executorScope(aliceActor);
  assert.equal(aliceScope.keep("ex-alice"), "ex-alice");
  assert.equal(aliceScope.keep("ex-bob"), null, "别人的执行器 id 不许落进我的行");
  assert.equal(aliceScope.keep("ex-does-not-exist"), null, "悬空 id 与别人的 id 必须不可区分");
  assert.equal(aliceScope.typeOf("ex-bob"), undefined, "看不见 = 不存在,连类型都问不出来");
  assert.equal(aliceScope.typeOf("ex-alice"), "claude");
  assert.deepEqual(aliceScope.rows.map((r) => r.id), ["ex-alice"]);

  // 结算内部重放预约槽时没有 HTTP 身份,显式 null = 不设限(那份配置早已认过归属)。
  assert.equal((await ownedExecutors.executorScope(null)).keep("ex-bob"), "ex-bob");

  // 读侧:label 锚在**资源归属人**,不是看客 —— 看客口径会把「bob 的任务跑在 alice 的
  // 执行器上」写进界面,那不是隐藏是编造。
  const both = aliceScope.rows.concat((await ownedExecutors.executorScope(bobActor)).rows);
  assert.deepEqual(ownedExecutors.profilesOwnedBy(both, alice.id).map((r) => r.name), ["claude@alice"]);
  assert.deepEqual(ownedExecutors.profilesOwnedBy(both, bob.id).map((r) => r.name), ["claude@bob"]);

  // 真走一遍读路径:executorId 为空的 alice 任务,默认回退只能落到 alice 自己的默认。
  const taskStore = await import("../src/task-store.js");
  await db.update(tasks).set({ executorId: null, agentType: "claude" }).where(eq(tasks.id, "t-alice"));
  const [aliceTask] = await taskStore.enrichTasks(
    (await db.select().from(tasks).where(eq(tasks.id, "t-alice"))) as never,
  );
  assert.equal(aliceTask.executorLabel, "claude@alice", "默认回退不能回退到别人的默认执行器");
  const [bobTask] = await taskStore.enrichTasks(
    (await db.select().from(tasks).where(eq(tasks.id, "t-bob"))) as never,
  );
  assert.equal(bobTask.executorLabel, "claude@bob", "bob 自己的任务照实显示,别一起藏掉");
  await db.update(tasks).set({ executorId: "ex-alice" }).where(eq(tasks.id, "t-alice"));
}

// ── ⑭ 穿过完整 authGate 的 HTTP 回归 ──────────────────────────────────────
// 前面几组验的是判据函数;这一组验**装配**:同 index.ts 的挂法(authGate → resourceGate
// → 路由),用真 Request 打进去。第 2 轮审查两条都出在装配上,判据函数本身没问题:
//  · relay 路由被 authGate 拦成「请先登录」,CLI 根本到不了它自己的供应商 key 校验;
//  · `/llm-providers/test` 到得了路由,却没认存量行的归属。
{
  const { Hono } = await import("hono");
  const { authGate } = await import("../src/auth/middleware.js");
  const { resourceGate } = await import("../src/auth/resource-gate.js");
const { personalWriteGate } = await import("../src/auth/personal-gate.js");
  const { mountOpenAiConverterRoutes } = await import("../src/openai-converter/routes.js");
  const { mountAnthropicContext1mRoutes } = await import("../src/anthropic-context-1m.js");
  const { mountProviderTestRoutes } = await import("../src/provider-test.js");
  const { llmProviders } = schema;

  await db.update(llmProviders)
    .set({ protocol: "openai", protocolConversionEnabled: true })
    .where(eq(llmProviders.id, "prov-bob"));

  const api = new Hono();
  mountOpenAiConverterRoutes(api);
  mountAnthropicContext1mRoutes(api);
  mountProviderTestRoutes(api);
  const app = new Hono();
  app.use("*", authGate());
  app.use("/api/*", resourceGate());
app.use("/api/*", personalWriteGate());
  app.route("/api", api);
  // relay 路由回的是 OpenAI 风格的 `{message,type}`,ash 自己的路由回 `{error}` ——
  // 这条测试恰好要跨过这条边界,所以两种都读。
  const call = async (path: string, init?: RequestInit) => {
    const res = await app.fetch(new Request(`http://127.0.0.1:4317${path}`, init));
    const body = await res.json().catch(() => ({})) as { error?: unknown; message?: string };
    const error = typeof body.error === "object" && body.error
      ? String((body.error as { message?: string }).message ?? "")
      : String(body.error ?? body.message ?? "");
    return { status: res.status, error };
  };
  const bearer = (key: string) => ({ authorization: `Bearer ${key}` });
  const aliceKey = await store.resetUserKey(alice.id);
  const bobKey = await store.resetUserKey(bob.id);

  // relay:未登录也要过得去,凭证换成供应商自己的 key(路由内 secretsEqual 校验)。
  const wrongKey = await call("/api/llm-providers/prov-bob/convert/v1/chat/completions", {
    method: "POST", headers: bearer("not-the-provider-key"), body: "{}",
  });
  assert.equal(wrongKey.status, 401);
  assert.match(
    wrongKey.error,
    /供应商 API Key 无效/,
    "relay 该被路由自己的供应商 key 闸拒,而不是被 authGate 拦成「请先登录」",
  );
  const noKey = await call("/api/llm-providers/prov-bob/context-1m/v1/messages", { method: "POST", body: "{}" });
  assert.equal(noKey.status, 404, "1M 映射没配模型 → 路由自己的 404,同样说明它到得了路由");
  assert.ok(!/请先登录/.test(noKey.error), noKey.error);

  // 豁口必须窄:同一族路径下的供应商 CRUD(里面装着 key)仍要登录。
  const crud = await call("/api/llm-providers/prov-bob");
  assert.equal(crud.status, 401);
  assert.match(crud.error, /请先登录/, "供应商 CRUD 不在豁口里");

  // `/llm-providers/test`:alice 拿 bob 的 provider id 去测,必须查无此供应商 ——
  // 否则请求体给 baseUrl、apiKey 回落存量行,服务端就把 bob 的 key 发到 alice 指定的地址。
  const stolen = await call("/api/llm-providers/test", {
    method: "POST",
    headers: { ...bearer(aliceKey), "content-type": "application/json" },
    body: JSON.stringify({ id: "prov-bob", baseUrl: "http://127.0.0.1:1", model: "m", protocol: "openai" }),
  });
  assert.equal(stolen.status, 404, "别人的 provider 必须查无此行");
  assert.match(stolen.error, /不存在/);
  // 本人照走:「表单改了 baseUrl、key 沿用存量」是编辑页的常规用法,不能连坐。
  const own = await call("/api/llm-providers/test", {
    method: "POST",
    headers: { ...bearer(bobKey), "content-type": "application/json" },
    body: JSON.stringify({ id: "prov-bob", baseUrl: "http://127.0.0.1:1", model: "m", protocol: "openai" }),
  });
  assert.notEqual(own.status, 404, `本人测自己的供应商不该被拦:${own.error}`);
}

// ── ⑮ duet 讨论者与团队派活:同样按人收窄 ──────────────────────────────────
// 第 3 轮审查:顶层 executorId 和 team 三角色都过了 scope,但 duet 配置是整块
// JSON.stringify 落库的,团队派活又是 agent 路径(没有 HTTP actor),两处都从缝里漏了。
// server/CLAUDE.md 那条「新增任何『选谁干活』的表面,三件套一起上」说的正是这件事。
{
  const { Hono } = await import("hono");
  const { authGate } = await import("../src/auth/middleware.js");
  const { resourceGate } = await import("../src/auth/resource-gate.js");
const { personalWriteGate } = await import("../src/auth/personal-gate.js");
  const { mountTaskRoutes } = await import("../src/task-routes.js");
  const { executorScopeForOwner } = await import("../src/auth/owned-executors.js");
  const { resolveExecutorWithProfile } = await import("../src/executors/index.js");
  const { dispatchWorkers } = await import("../src/team/dispatch.js");

  const api = new Hono();
  mountTaskRoutes(api);
  const app = new Hono();
  app.use("*", authGate());
  app.use("/api/*", resourceGate());
app.use("/api/*", personalWriteGate());
  app.route("/api", api);
  const aliceKey = await store.resetUserKey(alice.id);
  const post = async (path: string, body: unknown) => {
    const res = await app.fetch(new Request(`http://127.0.0.1:4317${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${aliceKey}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }));
    return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, unknown> };
  };

  // 写侧:alice 建 duet,voiceA 填 bob 的执行器 —— 存进去的必须是 null。
  const created = await post("/api/tasks", {
    projectId: "p-alice", title: "duet", body: "topic", mode: "duet", useWorktree: false,
    duet: { voiceA: "claude", voiceB: "claude", topic: "topic",
            voiceAExecutorId: "ex-bob", voiceBExecutorId: "ex-alice" },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const duetId = String(created.body.id);
  const storedDuet = JSON.parse(
    (await db.select({ duet: tasks.duet }).from(tasks).where(eq(tasks.id, duetId))).at(0)!.duet!,
  ) as { voiceAExecutorId: string | null; voiceBExecutorId: string | null };
  assert.equal(storedDuet.voiceAExecutorId, null, "别人的讨论者执行器不许落库");
  assert.equal(storedDuet.voiceBExecutorId, "ex-alice", "自己的照常存");

  // PATCH 是对称的另一半:同一个字段两条写入口,只改一条等于没改。
  const patched = await app.fetch(new Request(`http://127.0.0.1:4317/api/tasks/${duetId}`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${aliceKey}`, "content-type": "application/json" },
    body: JSON.stringify({ duet: { voiceA: "claude", voiceB: "claude", topic: "t", voiceAExecutorId: "ex-bob" } }),
  }));
  assert.equal(patched.status, 200);
  const afterPatch = JSON.parse(
    (await db.select({ duet: tasks.duet }).from(tasks).where(eq(tasks.id, duetId))).at(0)!.duet!,
  ) as { voiceAExecutorId: string | null };
  assert.equal(afterPatch.voiceAExecutorId, null, "PATCH 这条入口也要收窄");

  // 运行侧:存量行(转多人之前、或本轮修复之前)里仍可能躺着外人的 id,所以解析器
  // 也要按任务归属人收窄 —— 否则讨论回合真的跑在别人的 profile 上。
  const loose = await resolveExecutorWithProfile({ executorId: "ex-bob", type: "claude" });
  assert.equal(loose.profileId, "ex-bob", "不传 owner = 不收窄(自用模式那条路)");
  const scoped = await resolveExecutorWithProfile({ executorId: "ex-bob", type: "claude", owner: alice.id });
  assert.equal(scoped.profileId, "ex-alice", "按归属人收窄后应降级到本人默认执行器");
  assert.equal(scoped.downgradedFrom?.id, "ex-bob", "降级要把原来那条带回去,好让前端说清楚");

  // 团队派活:agent 路径没有 HTTP actor,scope 按调度者任务的归属人建。
  assert.equal((await executorScopeForOwner(alice.id)).keep("ex-bob"), null);
  assert.equal((await executorScopeForOwner(alice.id)).keep("ex-alice"), "ex-alice");
  assert.equal((await executorScopeForOwner(bob.id)).keep("ex-bob"), "ex-bob");

  const leadAt = new Date().toISOString();
  await db.insert(tasks).values([{
    id: "lead-alice", projectId: "p-alice", title: "lead", body: "", mode: "team",
    status: "idle", createdAt: leadAt, updatedAt: leadAt, ownerUserId: alice.id,
    team: JSON.stringify({ lead: "claude", worker: "claude" }),
  }] as never);
  const dispatched = await dispatchWorkers("lead-alice", [{ body: "干活", executorId: "ex-bob" }], { run: false });
  const worker = (await db.select().from(tasks).where(eq(tasks.id, dispatched.tasks[0]!.id))).at(0)!;
  assert.equal(worker.executorId, null, "派活不许把别人的 executorId 写进子任务");
  assert.equal(worker.ownerUserId, alice.id, "子任务照旧继承调度者的归属");
  assert.ok(
    !(worker.executorSnapshot ?? "").includes("claude@bob"),
    `执行器快照会原样回显,不许带上别人的 profile 名:${worker.executorSnapshot}`,
  );

  // 快照那道兜底单独钉一次:上面那条走的是「dispatch 已经把 id 归一成 null」,
  // 试不出兜底在不在。这里直接绕过所有入口喂一条外人的 id —— 模拟「又长出一条新的
  // 建任务路径、而它忘了过 scope」,建任务只此一条汇流处,所以判据钉在这儿。
  const taskStore2 = await import("../src/task-store.js");
  const [leaky] = await taskStore2.createTasks([{
    id: "leaky-task", projectId: "p-alice", title: "leaky", body: "",
    mode: "single", status: "backlog", agentType: "claude", executorId: "ex-bob",
    ownerUserId: alice.id, useWorktree: false,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  } as never]);
  const leakyRow = (await db.select().from(tasks).where(eq(tasks.id, leaky!.id))).at(0)!;
  assert.ok(
    !(leakyRow.executorSnapshot ?? "").includes("claude@bob"),
    `快照兜底没生效:${leakyRow.executorSnapshot}`,
  );
}

// ── ⑯ 收窄按谁:锚在任务归属人,不是操作人 ──────────────────────────────────
// 第 4 轮审查:写侧按操作人过滤、运行侧按归属人解析 —— 共享项目里这两个人可以不是
// 同一个,于是存进去一个运行时永远解析不到的 id,库里写的和真跑的分家。两条缝:
// ① 共享项目里 bob 改 alice 的任务;② 带 parentId 建子任务时归属继承父任务。
{
  const { Hono } = await import("hono");
  const { authGate } = await import("../src/auth/middleware.js");
  const { resourceGate } = await import("../src/auth/resource-gate.js");
const { personalWriteGate } = await import("../src/auth/personal-gate.js");
  const { mountTaskRoutes } = await import("../src/task-routes.js");

  // p-alice 变成共享项目:bob 看得见、改得动,但它仍然是 alice 的活。
  await visibility.addProjectMember({ projectId: "p-alice", userId: bob.id, role: "member", addedBy: alice.id });

  const api = new Hono();
  mountTaskRoutes(api);
  const app = new Hono();
  app.use("*", authGate());
  app.use("/api/*", resourceGate());
app.use("/api/*", personalWriteGate());
  app.route("/api", api);
  const aliceKey2 = await store.resetUserKey(alice.id);
  const bobKey2 = await store.resetUserKey(bob.id);
  const send = async (path: string, method: string, key: string, body: unknown) => {
    const res = await app.fetch(new Request(`http://127.0.0.1:4317${path}`, {
      method,
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }));
    return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, unknown> };
  };
  const stored = async (taskId: string) =>
    (await db.select({ executorId: tasks.executorId, ownerUserId: tasks.ownerUserId, duet: tasks.duet })
      .from(tasks).where(eq(tasks.id, taskId))).at(0)!;

  // ① alice 的任务,bob 来改:他自己的执行器在这条任务上等同于不存在。
  const aliceTask = await send("/api/tasks", "POST", aliceKey2,
    { projectId: "p-alice", title: "shared", body: "x", useWorktree: false });
  assert.equal(aliceTask.status, 201, JSON.stringify(aliceTask.body));
  const sharedId = String(aliceTask.body.id);
  const patched = await send(`/api/tasks/${sharedId}`, "PATCH", bobKey2, { executorId: "ex-bob" });
  assert.equal(patched.status, 200, JSON.stringify(patched.body));
  const afterPatch = await stored(sharedId);
  assert.equal(afterPatch.ownerUserId, alice.id, "改一改不该顺手换掉归属");
  assert.equal(afterPatch.executorId, null, "别人的任务上,操作人自己的执行器也存不进去");

  // duet 那份配置同理(它整块 JSON 落库,漏过一次了)。
  const aliceDuet = await send("/api/tasks", "POST", aliceKey2, {
    projectId: "p-alice", title: "shared duet", body: "t", mode: "duet", useWorktree: false,
    duet: { voiceA: "claude", voiceB: "claude", topic: "t", voiceAExecutorId: "ex-alice" },
  });
  assert.equal(aliceDuet.status, 201, JSON.stringify(aliceDuet.body));
  const duetId2 = String(aliceDuet.body.id);
  const duetPatched = await send(`/api/tasks/${duetId2}`, "PATCH", bobKey2,
    { duet: { voiceA: "claude", voiceB: "claude", topic: "t", voiceAExecutorId: "ex-bob" } });
  assert.equal(duetPatched.status, 200, JSON.stringify(duetPatched.body));
  const duetCfg = JSON.parse((await stored(duetId2)).duet!) as { voiceAExecutorId: string | null };
  assert.equal(duetCfg.voiceAExecutorId, null, "duet 两位讨论者也锚在归属人");

  // ② parentId:归属继承父任务,所以 scope 也必须跟着父任务的归属人走。
  const child = await send("/api/tasks", "POST", bobKey2,
    { projectId: "p-alice", title: "child", body: "x", parentId: sharedId, executorId: "ex-bob", useWorktree: false });
  assert.equal(child.status, 201, JSON.stringify(child.body));
  const childRow = await stored(String(child.body.id));
  assert.equal(childRow.ownerUserId, alice.id, "子任务归属继承父任务(§八)");
  assert.equal(childRow.executorId, null, "归属继承过去了,执行器 scope 就得跟着走");

  // 负对照:bob 在同一个共享项目里建**自己的**任务,他的执行器照常存得进去。
  const bobOwn = await send("/api/tasks", "POST", bobKey2,
    { projectId: "p-alice", title: "bob own", body: "x", executorId: "ex-bob", useWorktree: false });
  assert.equal(bobOwn.status, 201, JSON.stringify(bobOwn.body));
  const bobRow = await stored(String(bobOwn.body.id));
  assert.equal(bobRow.ownerUserId, bob.id);
  assert.equal(bobRow.executorId, "ex-bob", "自己的活当然用自己的执行器 —— 别把收窄做成一刀切");
}

await releaseTmpDb();
rmSync(stage, { recursive: true, force: true });
console.log("test-multi-user ok");
