// 飞书通道的身份边界：经飞书发起的请求是「绑定的那个人」，而且只是他能做的事里的一小部分。
//
// 钉住的几件事（理由见 server/src/auth/im-actor.ts 与 server/src/im/routes.ts 的文件头）：
// ① 身份绑在 Request 对象上：只有 dispatchAsIm 造的请求是 im 身份；没绑定 / 绑定失效一律 403；
// ② 白名单：设置、飞书设置自己、终端这类不在名单里的路由一律 403；验收带 gate/confirmUnverified 403；
// ③ 自用模式下 im 身份不是机主：不是账号本人、不是管理员、没有宿主机权限，归属列写 null；
// ④ 多人模式：按绑定的那个账号算可见性；账号停用就失效；管理员的飞书也只拿到成员权限；
// ⑤ 飞书设置接口：换凭证 / 绑定码 / 确认是真人专属；agent 回合凭证改不了任何东西；非管理员
//    看不到额度、改不了实例选项；群列表按项目可见性裁、别人绑的群改不动；
// ⑥ 绑定码：认领只认对的地方（个人码在单聊、群码在群里且必须是码主本人发）、过期与重复认领；
//    确认群绑定按确认那一刻重核：看不到项目了、本人飞书绑定换了人都不生效，别人绑的群只有管理员能覆盖；
// ⑦ 源码扫描：im/ 下面一行都不许碰真人凭据（通道替人点按钮不等于真人在页面上点）。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireTmpDb, releaseTmpDb } from "./tmp-db.js";

const stage = mkdtempSync(join(tmpdir(), "ash-im-actor-"));
process.env.ASH_DB = join(stage, "ash.db");
process.env.ASH_RUNS_DIR = join(stage, "runs");
requireTmpDb("test-im-actor");

let failure: unknown = null;
try {
  const { db, ensureSchema } = await import("../src/db/index.js");
  const { projects, tasks } = await import("../src/db/schema.js");
  const { imBindings, imGroupRooms, imGroups } = await import("../src/db/schema-im.js");
  const { and, eq, isNull } = await import("drizzle-orm");
  const { Hono } = await import("hono");
  const { authGate } = await import("../src/auth/middleware.js");
  const { resourceGate } = await import("../src/auth/resource-gate.js");
  const { personalWriteGate, isHumanOnlyPath } = await import("../src/auth/personal-gate.js");
  const { issueHumanActionToken, HUMAN_ACTION_TOKEN_HEADER } = await import("../src/auth/human-action-token.js");
  const { dispatchAsIm, imActorFor } = await import("../src/auth/im-actor.js");
  const { isAccountHolder, isAdminActor, isHumanPrincipal, ownerIdOf } = await import("../src/auth/context.js");
  const mode = await import("../src/auth/mode.js");
  const store = await import("../src/auth/store.js");
  const visibility = await import("../src/auth/visibility.js");
  const { claimCode, confirmUserCode, createBindCode, bindingView } = await import("../src/im/binding.js");
  const { confirmGroupCode } = await import("../src/im/groups.js");
  const { writeCredentials } = await import("../src/im/config.js");
  const { api } = await import("../src/routes.js");

  await ensureSchema();
  const app = new Hono();
  app.use("*", authGate());
  app.use("/api/*", resourceGate());
  app.use("/api/*", personalWriteGate());
  app.route("/api", api);

  const call = async (path: string, method = "GET", headers: Record<string, string> = {}, body?: unknown) => {
    const res = await app.fetch(new Request(`http://127.0.0.1:4317${path}`, {
      method, headers: { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }));
    const text = await res.text();
    let json: any = {};
    try { json = JSON.parse(text); } catch { /* 看 text */ }
    return { status: res.status, json, text };
  };
  const asIm = async (openId: string, method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", path: `/api/${string}`, body?: unknown) => {
    const res = await dispatchAsIm(app.fetch, { channel: "feishu", appId: APP, openId }, { method, path, body });
    const text = await res.text();
    let json: any = {};
    try { json = JSON.parse(text); } catch { /* 看 text */ }
    return { status: res.status, json, text };
  };

  const APP = "cli_app0000000";
  const at = new Date().toISOString();
  writeCredentials({ appId: APP, appSecret: "secret-not-used", domain: "feishu" });
  mkdirSync(join(stage, "repo"), { recursive: true });
  await db.insert(projects).values({ id: "p1", name: "p1", repoPath: join(stage, "repo"), apiKeys: null, createdAt: at } as never);
  await db.insert(tasks).values({
    id: "t1", projectId: "p1", title: "t1", body: "", status: "paused", createdAt: at, updatedAt: at,
    activeTurnToken: "turn-1", question: "选哪个？", questionOptions: JSON.stringify(["A", "B"]),
  } as never);
  await db.insert(imBindings).values({ channel: "feishu", appId: APP, openId: "ou_owner", userId: null, boundAt: at });

  // ── ① ② ③ 自用模式 ───────────────────────────────────────────────────────
  {
    const read = await asIm("ou_owner", "GET", "/api/tasks/t1");
    assert.equal(read.status, 200, `绑定的人读得到任务：${read.text}`);
    assert.equal(read.json.title, "t1");
    const stranger = await asIm("ou_stranger", "GET", "/api/tasks/t1");
    assert.equal(stranger.status, 403, "没绑定的 open_id 一律 403（自用模式也不落成机主）");
    for (const [method, path] of [
      ["GET", "/api/settings"], ["PATCH", "/api/settings"], ["GET", "/api/im/feishu/status"],
      ["PUT", "/api/im/feishu/credentials"], ["POST", "/api/tasks/t1/reclaim-turn"], ["GET", "/api/host"],
      ["POST", "/api/tasks/t1/verify-override"], ["DELETE", "/api/tasks/t1"],
    ] as const) {
      const res = await asIm("ou_owner", method, path, method === "GET" ? undefined : {});
      assert.equal(res.status, 403, `${method} ${path} 不该经飞书放行：${res.status} ${res.text}`);
    }
    for (const body of [{ gate: "skip" }, { confirmUnverified: true }]) {
      const res = await asIm("ou_owner", "POST", "/api/tasks/t1/accept", body);
      assert.equal(res.status, 403, `验收带 ${Object.keys(body)[0]} 只能在页面上点：${res.text}`);
    }

    const actor = (await imActorFor({ channel: "feishu", appId: APP, openId: "ou_owner" }))!;
    assert.equal(actor.kind, "im");
    assert.equal(isAccountHolder(actor), false, "im 身份不是账号本人");
    assert.equal(isAdminActor(actor), false, "自用模式下 im 身份也不是管理员");
    assert.equal(isHumanPrincipal(actor), true, "但它是人在说话（聊天收它的话）");
    assert.equal(ownerIdOf(actor), null, "自用模式归属列写 null，不写 __local__");

    // 外部请求带什么头都造不出 im 身份：自用模式下照常是机主，与 im 无关。
    const outside = await call("/api/tasks/t1", "GET", { "x-ash-im-open-id": "ou_owner" });
    assert.equal(outside.status, 200);
  }

  // ── ⑤ 飞书设置接口（自用模式）─────────────────────────────────────────────
  {
    const status = await call("/api/im/feishu/status");
    assert.equal(status.status, 200, status.text);
    assert.equal(status.json.canManage, true, "机主本人能管");
    assert.equal(status.json.config.appId, APP);
    assert.equal(JSON.stringify(status.json).includes("secret-not-used"), false, "App Secret 永远不出 server");
    assert.equal(status.json.usage.quota, 10000);

    for (const path of ["/api/im/feishu/credentials", "/api/im/feishu/binding/code", "/api/im/feishu/binding/confirm",
      "/api/im/feishu/groups/code", "/api/im/feishu/groups/confirm"]) {
      assert.equal(isHumanOnlyPath(path), true, `${path} 是真人专属`);
    }
    const noToken = await call("/api/im/feishu/credentials", "PUT", {}, { appId: APP, domain: "feishu" });
    assert.equal(noToken.status, 403, "换凭证没有页面凭据就拒");
    const code = await call("/api/im/feishu/binding/code", "POST", { [HUMAN_ACTION_TOKEN_HEADER]: issueHumanActionToken() });
    assert.equal(code.status, 409, `凭据对了也得先连上飞书：${code.text}`);

    const agent = { "x-ash-source-task-id": "t1", "x-ash-turn-token": "turn-1" };
    const agentPatch = await call("/api/im/feishu/options", "PATCH", agent, { publicBaseUrl: "https://evil.example" });
    assert.equal(agentPatch.status, 403, `agent 回合凭证改不了深链：${agentPatch.text}`);
    const agentUnbind = await call("/api/im/feishu/binding", "DELETE", agent);
    assert.equal(agentUnbind.status, 403, "agent 回合凭证也解不了绑");
    const agentStatus = await call("/api/im/feishu/status", "GET", agent);
    assert.equal(agentStatus.json.canManage, false);
    assert.equal(agentStatus.json.usage, null, "agent 看不到额度");

    const patched = await call("/api/im/feishu/options", "PATCH", {}, { monthlyQuota: 5000, publicBaseUrl: "http://mac.tailnet:4317/" });
    assert.equal(patched.status, 200, patched.text);
    assert.equal(patched.json.options.monthlyQuota, 5000);
    assert.equal(patched.json.options.publicBaseUrl, "http://mac.tailnet:4317");
    assert.equal(patched.json.usage.quota, 5000, "额度改了计数器跟着改");
    const bad = await call("/api/im/feishu/options", "PATCH", {}, { publicBaseUrl: "javascript:alert(1)" });
    assert.equal(bad.status, 400);
  }

  // ── ⑥ 绑定码 ─────────────────────────────────────────────────────────────
  {
    const fresh = await createBindCode("", "user", null);
    const core = fresh.code.replace(/^ASH-|-/g, "");
    const p2p = { appId: APP, openId: "ou_new", chatId: "oc_p2p", chatType: "p2p" as const };
    assert.deepEqual(await claimCode(core, { ...p2p, chatType: "group" }), { kind: "wrong_place", purpose: "user" }, "个人码发到群里不认");
    assert.equal((await claimCode(core, p2p)).kind, "claimed");
    assert.equal((await claimCode(core, p2p)).kind, "claimed", "同一个人再发一次幂等");
    assert.equal((await claimCode(core, { ...p2p, openId: "ou_other" })).kind, "taken", "别人再发就是被抢了");
    assert.equal((await claimCode("ZZZZZZZZ", p2p)).kind, "unknown");
    const view = await bindingView("", APP);
    assert.equal(view.state, "pending");
    const confirmed = await confirmUserCode("", fresh.codeId, APP);
    assert.equal(confirmed.ok, true);
    const bound = await bindingView("", APP);
    assert.equal(bound.state === "bound" && bound.openIdTail, "ou_new".slice(-6));
    assert.equal(bound.state === "bound" && bound.stale, false);
    assert.equal((await confirmUserCode("", fresh.codeId, APP)).ok, false, "一张码只能确认一次");
    assert.equal((await claimCode(core, p2p)).kind, "unknown", "确认过的码不再认");

    const group = await createBindCode("", "group", "p1");
    const groupCore = group.code.replace(/^ASH-|-/g, "");
    const inGroup = { appId: APP, openId: "ou_somebody", chatId: "oc_group", chatType: "group" as const, name: "研发群" };
    assert.equal((await claimCode(groupCore, inGroup)).kind, "not_owner", "群码必须是码主本人发");
    assert.equal((await claimCode(groupCore, { ...inGroup, openId: "ou_new" })).kind, "claimed");
    const allowed = { canSeeProject: async () => true, admin: false };
    const groupDone = await confirmGroupCode("", group.codeId, APP, allowed);
    assert.equal(groupDone.ok && groupDone.group.name, "研发群");

    // 确认那一刻重核：每一种不该生效的都不许动群绑定、不许清群聊房间。
    const claimFor = async (chatId: string) => {
      const code = await createBindCode("", "group", "p1");
      assert.equal((await claimCode(code.code.replace(/^ASH-|-/g, ""), { ...inGroup, chatId, openId: "ou_new" })).kind, "claimed");
      return code.codeId;
    };
    const groupRow = async (chatId: string) => (await db.select().from(imGroups).where(and(eq(imGroups.appId, APP), eq(imGroups.chatId, chatId)))).at(0);
    await db.insert(imGroups).values({ channel: "feishu", appId: APP, chatId: "oc_theirs", projectId: "p1", name: "别人的群", boundBy: "u_someone", pushCards: 1, boundAt: new Date().toISOString() });
    await db.insert(imGroupRooms).values({ channel: "feishu", appId: APP, chatId: "oc_theirs", userKey: "u_someone", roomId: "room-theirs" });

    const lostProject = await confirmGroupCode("", await claimFor("oc_theirs"), APP, { canSeeProject: async () => false, admin: true });
    assert.equal(!lostProject.ok && lostProject.status, 403, "看不到项目了就不能确认");
    const notAdmin = await confirmGroupCode("", await claimFor("oc_theirs"), APP, allowed);
    assert.equal(!notAdmin.ok && notAdmin.status, 403, "别人绑的群，非管理员覆盖不了");
    assert.equal((await groupRow("oc_theirs"))?.boundBy, "u_someone", "拒绝时原绑定原样留着");
    assert.equal((await db.select().from(imGroupRooms).where(eq(imGroupRooms.chatId, "oc_theirs"))).length, 1, "群聊房间映射也没被清");

    const swapped = await claimFor("oc_mine");
    await db.update(imBindings).set({ openId: "ou_swapped" }).where(and(eq(imBindings.appId, APP), isNull(imBindings.userId)));
    const afterSwap = await confirmGroupCode("", swapped, APP, allowed);
    assert.equal(afterSwap.ok, false, "认领之后本人的飞书绑定换了人，这张码不再生效");
    assert.equal(await groupRow("oc_mine"), undefined);
    await db.update(imBindings).set({ openId: "ou_new" }).where(and(eq(imBindings.appId, APP), isNull(imBindings.userId)));

    const byAdmin = await confirmGroupCode("", await claimFor("oc_theirs"), APP, { canSeeProject: async () => true, admin: true });
    assert.equal(byAdmin.ok, true, "管理员可以覆盖");
    assert.equal((await groupRow("oc_theirs"))?.boundBy, null);
  }

  // ── ⑦ 源码扫描 ───────────────────────────────────────────────────────────
  {
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? walk(path) : [path];
    });
    const imDir = join(import.meta.dirname, "../src/im");
    for (const file of walk(imDir)) {
      const text = readFileSync(file, "utf8");
      assert.equal(/HumanActionToken|human-action-token|HUMAN_ACTION/.test(text), false, `${file} 不该碰真人凭据`);
    }
  }

  // ── ④ 多人模式 ───────────────────────────────────────────────────────────
  {
    const root = join(stage, "root");
    for (const dir of ["alice", "bob", "boss"]) mkdirSync(join(root, dir), { recursive: true });
    await mode.setInstanceMode("multi", root);
    const alice = await store.createUser({ name: "alice", role: "member", dirName: "alice", gitName: "A", gitEmail: "a@x", createdBy: null });
    const bob = await store.createUser({ name: "bob", role: "member", dirName: "bob", gitName: "B", gitEmail: "b@x", createdBy: alice.id });
    const boss = await store.createUser({ name: "boss", role: "admin", dirName: "boss", gitName: "C", gitEmail: "c@x", createdBy: alice.id });
    for (const user of [alice, bob, boss]) await store.updateUser(user.id, { status: "active" });
    const aliceKey = await store.resetUserKey(alice.id);
    const bossKey = await store.resetUserKey(boss.id);
    mkdirSync(join(root, "alice", "pa"), { recursive: true });
    mkdirSync(join(root, "boss", "pb"), { recursive: true });
    await db.insert(projects).values([
      { id: "pa", name: "pa", repoPath: join(root, "alice", "pa"), apiKeys: null, createdAt: at, ownerUserId: alice.id },
      { id: "pb", name: "pb", repoPath: join(root, "boss", "pb"), apiKeys: null, createdAt: at, ownerUserId: boss.id },
    ] as never);
    await visibility.addProjectMember({ projectId: "pa", userId: alice.id, role: "member", addedBy: alice.id });
    await visibility.addProjectMember({ projectId: "pb", userId: boss.id, role: "admin", addedBy: boss.id });
    await db.insert(tasks).values({ id: "ta", projectId: "pa", title: "ta", body: "", status: "done", createdAt: at, updatedAt: at, ownerUserId: alice.id } as never);
    await db.insert(imBindings).values([
      { channel: "feishu", appId: APP, openId: "ou_alice", userId: alice.id, boundAt: at },
      { channel: "feishu", appId: APP, openId: "ou_bob", userId: bob.id, boundAt: at },
      { channel: "feishu", appId: APP, openId: "ou_boss", userId: boss.id, boundAt: at },
    ]);

    assert.equal((await asIm("ou_alice", "GET", "/api/tasks/ta")).status, 200, "alice 读得到自己项目的任务");
    assert.equal((await asIm("ou_bob", "GET", "/api/tasks/ta")).status, 404, "bob 不是成员就看不见");
    assert.equal((await asIm("ou_boss", "GET", "/api/tasks/ta")).status, 404, "管理员的飞书只有成员权限，不是万能钥匙");
    assert.equal((await asIm("ou_owner", "GET", "/api/tasks/ta")).status, 403, "自用模式时期的绑定（无账号）在多人模式下失效");
    const aliceActor = (await imActorFor({ channel: "feishu", appId: APP, openId: "ou_alice" }))!;
    assert.equal(ownerIdOf(aliceActor), alice.id);
    assert.equal(aliceActor.role, "member");
    await store.updateUser(alice.id, { status: "suspended" });
    assert.equal((await asIm("ou_alice", "GET", "/api/tasks/ta")).status, 403, "账号停用，飞书绑定随之失效");
    await store.updateUser(alice.id, { status: "active" });

    const asAlice = { authorization: `Bearer ${aliceKey}` };
    const asBoss = { authorization: `Bearer ${bossKey}` };
    const aliceStatus = await call("/api/im/feishu/status", "GET", asAlice);
    assert.equal(aliceStatus.status, 200, aliceStatus.text);
    assert.equal(aliceStatus.json.canManage, false, "非管理员管不了实例级设置");
    assert.equal(aliceStatus.json.usage, null);
    assert.equal(aliceStatus.json.outbox, null);
    assert.equal((await call("/api/im/feishu/options", "PATCH", asAlice, { enabled: false })).status, 403);
    assert.equal((await call("/api/im/feishu/status", "GET", asBoss)).json.canManage, true);

    await db.insert(imGroups).values({ channel: "feishu", appId: APP, chatId: "oc_pb", projectId: "pb", name: "老板群", boundBy: boss.id, pushCards: 0, boundAt: at });
    const aliceGroups = await call("/api/im/feishu/groups", "GET", asAlice);
    assert.equal(aliceGroups.json.groups.some((g: { chatId: string }) => g.chatId === "oc_pb"), false, "看不见的项目的群不列");
    assert.equal((await call("/api/im/feishu/groups/oc_pb", "DELETE", asAlice)).status, 404);
    await db.insert(imGroups).values({ channel: "feishu", appId: APP, chatId: "oc_pa", projectId: "pa", name: "a 群", boundBy: boss.id, pushCards: 0, boundAt: at });
    const notMine = await call("/api/im/feishu/groups/oc_pa", "PATCH", asAlice, { pushCards: true });
    assert.equal(notMine.status, 403, `别人绑的群改不动：${notMine.text}`);
    const bossGroups = await call("/api/im/feishu/groups", "GET", asBoss);
    assert.equal(bossGroups.json.groups.length >= 2, true, "管理员看得到全部");
    const bossPatch = await call("/api/im/feishu/groups/oc_pa", "PATCH", asBoss, { pushCards: true });
    assert.equal(bossPatch.status, 200, bossPatch.text);
    assert.equal(bossPatch.json.groups.find((g: { chatId: string }) => g.chatId === "oc_pa").pushCards, true);

    // 本人绑定按账号隔开：alice 看到的是 alice 那份。
    const aliceBinding = await call("/api/im/feishu/binding", "GET", asAlice);
    assert.equal(aliceBinding.json.state, "bound");
    assert.equal(aliceBinding.json.openIdTail, "ou_alice".slice(-6));
  }
  console.log("test-im-actor: ok");
} catch (error) {
  failure = error;
} finally {
  await releaseTmpDb();
  rmSync(stage, { recursive: true, force: true });
}
if (failure) {
  console.error(failure);
  process.exit(1);
}
