import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { Actor } from "../src/auth/context.js";
import type { HandoffSourceAddress } from "@ash/shared/handoff";
import type { HandoffTarget, TaskHandoff } from "@ash/shared";
import { requireTmpDb, releaseTmpDb } from "./tmp-db.js";

const stage = mkdtempSync(join(tmpdir(), "ash-handoff-source-address-"));
process.env.ASH_DB = join(stage, "local.db");
process.env.ASH_RUNS_DIR = join(stage, "runs");
process.env.ASH_UPLOADS_DIR = join(stage, "uploads");
requireTmpDb("ash-handoff-source-address");
const servers: Server[] = [];

try {
  const { db, dbClient, ensureSchema } = await import("../src/db/index.js");
  const { projects, tasks, users, projectMembers, appSettings, handoffLocalPeerKeys, userHandoffTargets } = await import("../src/db/schema.js");
  const { eq } = await import("drizzle-orm");
  const { canonicalPingChallenge, fingerprintOf } = await import("../src/handoff-identity.js");
  const { mountHandoffRoutes } = await import("../src/handoff-routes.js");
  const { SINGLE_ACTOR, setActor, ownerIdOf } = await import("../src/auth/context.js");
  const { withHandoffActor } = await import("../src/auth/handoff-outbound.js");
  const { personalWriteGate } = await import("../src/auth/personal-gate.js");
  const scope = await import("../src/auth/handoff-scope.js");
  const { patchAppSettings, writeSystemSetting } = await import("../src/app-settings.js");
  const { invalidateInstanceConfig } = await import("../src/auth/mode.js");
  await ensureSchema();

  const keys = generateKeyPairSync("ed25519");
  const publicKey = keys.publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const fingerprint = fingerprintOf(publicKey);
  let badSignature = false;
  const seenCredentials: unknown[] = [];
  const peer = createServer((req, res) => {
    const url = new URL(req.url!, "http://localhost");
    seenCredentials.push(req.headers["x-ash-peer-user-key"], req.headers["x-ash-peer-key"]);
    if (url.pathname === "/api/handoff/import") {
      const authorized = req.headers["x-ash-peer-user-key"] === "saved-inline-key";
      res.writeHead(authorized ? 200 : 401, { "content-type": "application/json" });
      res.end(JSON.stringify(authorized ? { ok: true } : { error: "missing peer user key", ash: true }));
      return;
    }
    const sig = sign(null, Buffer.from(canonicalPingChallenge(
      badSignature ? "wrong-nonce" : url.searchParams.get("nonce")!,
    )), keys.privateKey).toString("base64");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, service: "ash", identity: { publicKey, sig } }));
  });
  servers.push(peer);
  await new Promise<void>((resolve) => peer.listen(0, "127.0.0.1", resolve));
  const newUrl = `http://127.0.0.1:${(peer.address() as { port: number }).port}`;
  const oldUrl = "http://127.0.0.1:1";
  const at = new Date().toISOString();
  await db.insert(projects).values({ id: "p", name: "Project", repoPath: stage, createdAt: at });
  const marker: TaskHandoff = {
    direction: "in", peerName: "LAPTOP", peerFp: fingerprint, peerUrl: oldUrl,
    peerTaskId: "original", transferId: "transfer", at, sessions: 0, git: "none",
  };
  await db.insert(tasks).values({ id: "t", projectId: "p", title: "Received", handoff: JSON.stringify(marker), createdAt: at, updatedAt: at });
  let actor: Actor = SINGLE_ACTOR;
  const app = new Hono();
  app.use("*", async (c, next) => {
    setActor(c, actor);
    await withHandoffActor(ownerIdOf(actor), next);
  });
  app.use("*", personalWriteGate());
  const api = new Hono();
  mountHandoffRoutes(api);
  app.route("/api", api);
  const get = async <T>(path: string): Promise<T> => {
    const response = await app.request(`/api${path}`);
    assert.equal(response.status, 200, await response.clone().text());
    return response.json() as Promise<T>;
  };
  const sources = async () => (await get<{ sources: HandoffSourceAddress[] }>("/handoff/targets/sources")).sources;
  const save = (url: unknown, fp: unknown = fingerprint) => app.request("/api/handoff/targets/source-address", {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ fingerprint: fp, url }),
  });

  assert.deepEqual(await sources(), [{ fingerprint, name: "LAPTOP", url: oldUrl }], "接收过的来源机不必先手工登记为目标机");
  assert.equal((await save(null)).status, 400);
  assert.equal((await save(newUrl, "f".repeat(64))).status, 404);
  assert.equal((await save(oldUrl)).status, 502);
  badSignature = true;
  assert.equal((await save(newUrl)).status, 502, "只复读公钥、不能签挑战的地址无法保存");
  badSignature = false;
  assert.deepEqual(await scope.listTargets(actor), [], "失败时不写目标机配置");

  const otherFingerprint = "a".repeat(64);
  await db.insert(tasks).values({
    id: "other", projectId: "p", title: "Other source", createdAt: at, updatedAt: at,
    handoff: JSON.stringify({ ...marker, peerFp: otherFingerprint, peerName: "OTHER" }),
  });
  assert.equal((await save(newUrl, otherFingerprint)).status, 409, "真实签名属于别的来源机也不能换过去");
  assert.equal((await save(`${newUrl}/`)).status, 200);
  assert.equal((await sources()).find((source) => source.fingerprint === fingerprint)?.url, newUrl, "保存后重新读取仍是新地址");
  const target = (await get<{ target: HandoffTarget }>("/tasks/t/handoff/return-target")).target;
  assert.equal(target.url, newUrl, "旧 marker 地址已失联，重新检查采用已核对的新地址");
  assert.equal(target.peerFp, fingerprint);
  assert.equal((await db.select().from(tasks).where(eq(tasks.id, "t")))[0].handoff, JSON.stringify(marker), "地址设置不篡改历史任务身份");

  await patchAppSettings({ handoffTargets: [{ name: "LAPTOP", url: oldUrl, peerFp: fingerprint }] });
  await scope.setPeerKey(actor, oldUrl, "test-only-peer-key");
  assert.equal((await save(newUrl)).status, 200);
  assert.equal(await scope.peerKeyForRequest(null, newUrl), "test-only-peer-key", "已核对为同一机器后保留账号 key");
  assert.equal(await scope.peerKeyForRequest(null, oldUrl), "", "旧 IP 不再携带账号 key");
  assert.equal(seenCredentials.filter(Boolean).length, 0, "保存前的地址核对不发送身份或账号凭据");
  assert.ok(!JSON.stringify(await get("/handoff/targets")).includes("test-only-peer-key"));

  const unrelatedUrl = "http://127.0.0.1:3";
  const historicalUrl = "http://127.0.0.1:2";
  await db.insert(tasks).values([
    {
      id: "same-source-history", projectId: "p", title: "Earlier source address", createdAt: at, updatedAt: at,
      handoff: JSON.stringify({ ...marker, peerUrl: `${historicalUrl}/` }),
    },
    {
      id: "other-source-history", projectId: "p", title: "Other source address", createdAt: at, updatedAt: at,
      handoff: JSON.stringify({ ...marker, peerFp: otherFingerprint, peerUrl: unrelatedUrl }),
    },
  ]);
  const seedInlineKeys = async (newKey = "", historyKey = "saved-inline-key") => {
    await patchAppSettings({ handoffTargets: [] });
    await scope.setPeerKey(actor, oldUrl, "saved-inline-key");
    await scope.setPeerKey(actor, historicalUrl, historyKey);
    await scope.setPeerKey(actor, newUrl, newKey);
    await scope.setPeerKey(actor, unrelatedUrl, "unrelated-inline-key");
  };
  await seedInlineKeys();
  assert.deepEqual(await scope.listTargets(actor), [], "弹窗单独保存 key 的来源机没有目标行");
  assert.equal((await save(newUrl)).status, 200);
  assert.deepEqual(await scope.listTargets(actor), [{ name: "LAPTOP", url: newUrl, peerFp: fingerprint, hasKey: true }]);
  assert.equal(await scope.peerKeyForRequest(null, `${newUrl}/api/handoff/import`), "saved-inline-key", "marker-only 来源的 inline key 迁移到新 URL");
  assert.equal(await scope.peerKeyForRequest(null, oldUrl), "");
  assert.equal(await scope.peerKeyForRequest(null, historicalUrl), "", "同指纹历史 URL 上的旧 key 一并清理");
  assert.equal(await scope.peerKeyForRequest(null, unrelatedUrl), "unrelated-inline-key", "其他来源指纹的 key 不参与迁移");
  assert.equal((await sources()).find((row) => row.fingerprint === fingerprint)?.url, newUrl);
  assert.equal((await get<{ target: HandoffTarget }>("/tasks/t/handoff/return-target")).target.url, newUrl);
  const { fetchPeer } = await import("../src/handoff-peer-client.js");
  assert.deepEqual(await fetchPeer(`${newUrl}/api/handoff/import`, { method: "POST", body: "{}" }), { ok: true }, "迁移后的出站请求实际携带账号 key，通过对端账号检查");
  assert.equal(seenCredentials.at(-2), "saved-inline-key");

  for (const [newKey, historyKey] of [["conflicting-key", "saved-inline-key"], ["", "conflicting-history-key"]]) {
    await seedInlineKeys(newKey, historyKey);
    const before = await db.select().from(handoffLocalPeerKeys);
    assert.equal((await save(newUrl)).status, 409, "历史或新 URL 上的 inline key 冲突时拒绝迁移");
    assert.deepEqual(await scope.listTargets(actor), []);
    assert.deepEqual(await db.select().from(handoffLocalPeerKeys), before, "冲突时包括无目标行的凭据也原样保留");
  }
  await seedInlineKeys();
  const inlineBeforeFailure = await db.select().from(handoffLocalPeerKeys);
  await dbClient.executeMultiple("CREATE TRIGGER fail_inline_key_delete BEFORE DELETE ON handoff_local_peer_keys BEGIN SELECT RAISE(ABORT, 'test inline key rollback'); END;");
  await assert.rejects(scope.saveVerifiedTargetAddress(actor, { name: "LAPTOP", url: newUrl, peerFp: fingerprint }, [oldUrl, historicalUrl]));
  assert.deepEqual(await scope.listTargets(actor), [], "清理 inline key 失败时，新目标行一起回滚");
  assert.deepEqual(await db.select().from(handoffLocalPeerKeys), inlineBeforeFailure);
  await dbClient.executeMultiple("DROP TRIGGER fail_inline_key_delete;");
  await scope.setPeerKey(actor, historicalUrl, "");

  const storedTargetsAndKeys = () => Promise.all([
    db.select().from(appSettings).where(eq(appSettings.key, "handoffTargets")),
    db.select().from(handoffLocalPeerKeys),
    db.select().from(userHandoffTargets),
  ]);
  const assertOwnershipConflict = async () => {
    const before = await storedTargetsAndKeys();
    const seenBefore = seenCredentials.length;
    const response = await save(newUrl);
    assert.equal(response.status, 409, "旧地址目标未确认属于来源机时拒绝迁移");
    assert.match(await response.text(), /归属冲突/);
    assert.deepEqual(await storedTargetsAndKeys(), before, "归属冲突时所有目标和凭据原样保留");
    assert.deepEqual(seenCredentials.slice(seenBefore), [undefined, undefined], "签名核对不发送凭据");
    assert.equal(await scope.peerKeyForRequest(ownerIdOf(actor), newUrl), "", "其他机器的 key 不复制到新地址");
    await withHandoffActor(ownerIdOf(actor), () => assert.rejects(
      fetchPeer(`${newUrl}/api/handoff/import`, { method: "POST", body: "{}" }), /对端返回 401/,
    ));
    assert.equal(seenCredentials.length, seenBefore + 4, "实际出站请求已到达来源机");
    assert.equal(seenCredentials.at(-2), undefined, "来源机实际收到的请求不带旧地址上其他机器的 key");
  };
  const otherTargets = Array.from({ length: 19 }, (_, i) => ({
    name: `其他目标 ${i}`, url: `http://192.0.2.${i + 20}:4317`, peerFp: otherFingerprint,
  }));
  for (const occupiedUrl of [oldUrl, historicalUrl]) {
    for (const peerFp of [null, otherFingerprint]) {
      for (const count of [1, 20]) {
        await patchAppSettings({ handoffTargets: [
          { name: "现在占用旧 IP 的机器 B", url: `${occupiedUrl}/`, peerFp },
          ...otherTargets.slice(0, count - 1),
        ] });
        await db.delete(handoffLocalPeerKeys);
        await scope.setPeerKey(actor, occupiedUrl, "machine-b-account-key");
        await assertOwnershipConflict();
      }
    }
  }
  await patchAppSettings({ handoffTargets: [
    { name: "同指纹记录", url: oldUrl, peerFp: fingerprint },
    { name: "未确认的重复记录", url: `${oldUrl}/`, peerFp: null },
  ] });
  await db.delete(handoffLocalPeerKeys);
  await scope.setPeerKey(actor, oldUrl, "machine-b-account-key");
  await assertOwnershipConflict();

  await patchAppSettings({ handoffTargets: [
    { name: "已确认的来源机", url: oldUrl, peerFp: fingerprint }, ...otherTargets,
  ] });
  await scope.setPeerKey(actor, oldUrl, "saved-inline-key");
  assert.equal((await save(newUrl)).status, 200, "目标已满 20 条时，同指纹来源机仍可原地换址");
  const fullTargets = await scope.listTargets(actor);
  assert.equal(fullTargets.length, 20);
  assert.deepEqual(fullTargets.filter((row) => row.peerFp !== fingerprint), otherTargets.map((row) => ({ ...row, hasKey: false })));
  assert.deepEqual(fullTargets.find((row) => row.peerFp === fingerprint), {
    name: "已确认的来源机", url: newUrl, peerFp: fingerprint, hasKey: true,
  });
  assert.equal(await scope.peerKeyForRequest(null, oldUrl), "");
  assert.deepEqual(await fetchPeer(`${newUrl}/api/handoff/import`, { method: "POST", body: "{}" }), { ok: true });
  assert.equal(seenCredentials.at(-2), "saved-inline-key", "确认同源后迁移的 key 仍可用于真实出站请求");

  await db.insert(tasks).values({
    id: "verified-address-history", projectId: "p", title: "Current address history", createdAt: at, updatedAt: at,
    handoff: JSON.stringify({ ...marker, peerUrl: `${newUrl}/` }),
  });
  await patchAppSettings({ handoffTargets: [{ name: "待核对的新地址", url: newUrl, peerFp: null }] });
  assert.equal((await save(newUrl)).status, 200, "新地址即使也在历史记录中，签名确认后仍可绑定其未配对目标行");

  const seedSingleDuplicates = async (newKey = "") => {
    await patchAppSettings({ handoffTargets: [
      { name: "旧来源地址", url: oldUrl, peerFp: fingerprint },
      { name: "预先添加的新地址", url: newUrl, peerFp: null },
      { name: "不相关目标", url: unrelatedUrl, peerFp: otherFingerprint },
    ] });
    await scope.setPeerKey(actor, oldUrl, "source-key");
    await scope.setPeerKey(actor, newUrl, newKey);
    await scope.setPeerKey(actor, unrelatedUrl, "unrelated-key");
  };
  for (const newKey of ["", "source-key", "conflicting-key"]) {
    await seedSingleDuplicates(newKey);
    const before = await scope.resolveTargetsFor(null);
    const response = await save(newUrl);
    if (newKey === "conflicting-key") {
      assert.equal(response.status, 409);
      assert.match(await response.text(), /不同的账号 key/);
      assert.deepEqual(await scope.resolveTargetsFor(null), before, "单人模式 key 冲突不改任何记录或凭据");
      continue;
    }
    assert.equal(response.status, 200);
    const merged = await scope.listTargets(actor);
    assert.equal(merged.filter((row) => row.peerFp === fingerprint).length, 1, "预加新 URL 与旧指纹行合并为一条");
    assert.equal(merged.filter((row) => row.url === newUrl).length, 1);
    assert.equal((await sources()).find((row) => row.fingerprint === fingerprint)?.url, newUrl);
    assert.equal((await get<{ target: HandoffTarget }>("/tasks/t/handoff/return-target")).target.url, newUrl);
    assert.equal(await scope.peerKeyForRequest(null, newUrl), "source-key");
    assert.equal(await scope.peerKeyForRequest(null, oldUrl), "");
    assert.equal(await scope.peerKeyForRequest(null, unrelatedUrl), "unrelated-key");
  }
  await seedSingleDuplicates();
  const beforeSingleFailure = await scope.resolveTargetsFor(null);
  await dbClient.executeMultiple("CREATE TRIGGER fail_source_key_delete BEFORE DELETE ON handoff_local_peer_keys BEGIN SELECT RAISE(ABORT, 'test merge rollback'); END;");
  await assert.rejects(scope.saveVerifiedTargetAddress(actor, { name: "LAPTOP", url: newUrl, peerFp: fingerprint }));
  assert.deepEqual(await scope.resolveTargetsFor(null), beforeSingleFailure, "清理旧 key 失败时，地址合并和 key 迁移一起回滚");
  await dbClient.executeMultiple("DROP TRIGGER fail_source_key_delete;");

  await writeSystemSetting("instanceMode", "multi");
  invalidateInstanceConfig();
  for (const id of ["alice", "bob"]) await db.insert(users).values({ id, name: id, dirName: id, createdAt: at });
  await db.insert(projectMembers).values({ projectId: "p", userId: "alice", role: "member", addedAt: at });
  actor = { kind: "user", userId: "alice", role: "member", name: "Alice" };
  assert.equal((await save(newUrl)).status, 200, "普通用户可修改自己的来源机地址");
  assert.equal((await get<{ target: HandoffTarget }>("/tasks/t/handoff/return-target")).target.url, newUrl, "回程发现读取当前用户的目标机清单");
  assert.equal((await scope.listTargets(actor)).length, 1);
  const aliceTarget = (await scope.listTargets(actor))[0];
  await scope.patchTarget(actor, aliceTarget.id!, { url: oldUrl, peerFp: fingerprint, peerKey: "alice-test-key" });
  assert.equal((await save(newUrl)).status, 200);
  assert.equal((await scope.listTargets(actor))[0].id, aliceTarget.id, "多人模式编辑原目标行，不另建重复条目");
  assert.equal(await scope.peerKeyForRequest("alice", newUrl), "alice-test-key");
  assert.equal(await scope.peerKeyForRequest("alice", oldUrl), "");
  for (const peerFp of [null, otherFingerprint]) {
    await scope.patchTarget(actor, aliceTarget.id!, { url: oldUrl, peerFp, peerKey: "machine-b-account-key" });
    await assertOwnershipConflict();
  }
  const seedMultiDuplicates = async (newKey = "") => {
    for (const target of await scope.listTargets(actor)) if (target.id !== aliceTarget.id) await scope.deleteTarget(actor, target.id!);
    await scope.patchTarget(actor, aliceTarget.id!, { url: oldUrl, peerFp: fingerprint, peerKey: "source-key" });
    await scope.addTarget(actor, { name: "预先添加的新地址", url: newUrl, peerKey: newKey });
  };
  for (const newKey of ["", "source-key", "conflicting-key"]) {
    await seedMultiDuplicates(newKey);
    const before = await scope.resolveTargetsFor("alice");
    const response = await save(newUrl);
    if (newKey === "conflicting-key") {
      assert.equal(response.status, 409);
      assert.deepEqual(await scope.resolveTargetsFor("alice"), before, "多人模式 key 冲突保留两行和原凭据");
      continue;
    }
    assert.equal(response.status, 200);
    const merged = await scope.listTargets(actor);
    assert.equal(merged.length, 1, "多人模式合并旧指纹行与预加的新 URL 行");
    assert.equal(merged[0].id, aliceTarget.id, "保留原来源机目标行的 id");
    assert.equal(merged[0].url, newUrl);
    assert.equal((await sources()).find((row) => row.fingerprint === fingerprint)?.url, newUrl);
    assert.equal((await get<{ target: HandoffTarget }>("/tasks/t/handoff/return-target")).target.url, newUrl);
    assert.equal(await scope.peerKeyForRequest("alice", newUrl), "source-key");
    assert.equal(await scope.peerKeyForRequest("alice", oldUrl), "");
  }
  await seedMultiDuplicates();
  const beforeMultiFailure = await scope.resolveTargetsFor("alice");
  await dbClient.executeMultiple("CREATE TRIGGER fail_source_target_delete BEFORE DELETE ON user_handoff_targets BEGIN SELECT RAISE(ABORT, 'test merge rollback'); END;");
  await assert.rejects(scope.saveVerifiedTargetAddress(actor, { name: "LAPTOP", url: newUrl, peerFp: fingerprint }));
  assert.deepEqual(await scope.resolveTargetsFor("alice"), beforeMultiFailure, "删除重复目标行失败时，原地址和 key 更新一起回滚");
  await dbClient.executeMultiple("DROP TRIGGER fail_source_target_delete;");
  actor = { kind: "user", userId: "bob", role: "member", name: "Bob" };
  assert.deepEqual(await sources(), [], "不可见项目的来源机不泄露给其他用户");
  assert.equal((await save(newUrl)).status, 404);
  assert.deepEqual(await scope.listTargets(actor), []);
  actor = { kind: "agent", userId: "alice", role: "member", name: "Agent", taskId: "t" };
  assert.equal((await save(newUrl)).status, 403, "任务回合凭证不能更改个人来源机地址");
  console.log("handoff source address: persistence, signed identity, return discovery, credentials and user scope passed");
} finally {
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await releaseTmpDb();
  rmSync(stage, { recursive: true, force: true });
}
