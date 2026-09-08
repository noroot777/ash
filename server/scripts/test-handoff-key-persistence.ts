import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { HandoffTarget } from "@ash/shared";
import type { Actor } from "../src/auth/context.js";
import { requireTmpDb, releaseTmpDb } from "./tmp-db.js";

const stage = mkdtempSync(join(tmpdir(), "ash-handoff-key-persistence-"));
process.env.ASH_DB = join(stage, "local.db");
process.env.ASH_RUNS_DIR = join(stage, "runs");
process.env.ASH_UPLOADS_DIR = join(stage, "uploads");
requireTmpDb("handoff-key-persistence");
const { startSignedHandoffPeer } = await import("./handoff-signed-peer-fixture.js");
const peer = await startSignedHandoffPeer();
try {
  const { db, dbClient, ensureSchema } = await import("../src/db/index.js");
  const { appSettings, handoffLocalPeerKeys, userHandoffTargets, users } = await import("../src/db/schema.js");
  const { getAppSettings, patchAppSettings, writeSystemSetting } = await import("../src/app-settings.js");
  const { patchSettingsFor } = await import("../src/auth/personal-settings.js");
  const { SINGLE_ACTOR, setActor } = await import("../src/auth/context.js");
  const { mountHandoffRoutes } = await import("../src/handoff-routes.js");
  const { withHandoffActor } = await import("../src/auth/handoff-outbound.js");
  const { requestHandoffApproval } = await import("../src/handoff-peer-client.js");
  const scope = await import("../src/auth/handoff-scope.js");
  await ensureSchema();
  await db.insert(users).values({ id: "alice", name: "Alice", dirName: "alice", createdAt: new Date().toISOString() });
  let actor: Actor = SINGLE_ACTOR;
  const api = new Hono();
  api.use("*", async (c, next) => { setActor(c, actor); await next(); });
  mountHandoffRoutes(api);
  const request = (method: string, path: string, body: object) => api.request(`/handoff/targets${path}`, {
    method, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const snapshot = () => Promise.all([
    db.select().from(appSettings), db.select().from(handoffLocalPeerKeys), db.select().from(userHandoffTargets),
  ]);
  const rejectsUnverified = async (method: string, path: string, body: object) => {
    const before = await snapshot();
    const response = await request(method, path, body);
    assert.equal(response.status, 502, "无法验签的新 key 不能返回保存成功");
    assert.match(await response.text(), /无法核对机器身份.*未保存/);
    assert.deepEqual(await snapshot(), before, "失败不新增目标、不覆盖已有 key 和身份绑定");
  };

  for (const multi of [false, true]) {
    await writeSystemSetting("instanceMode", multi ? "multi" : "single");
    await patchAppSettings({ handoffTargets: [] });
    await db.delete(handoffLocalPeerKeys);
    await db.delete(userHandoffTargets);
    actor = multi ? { kind: "user", userId: "alice", role: "member", name: "Alice" } : SINGLE_ACTOR;
    const owner = multi ? "alice" : null;
    await rejectsUnverified("POST", "", { name: "离线目标", url: "http://127.0.0.1:9", peerKey: "fresh-key" });
    for (const mode of ["missing", "invalid"] as const) {
      peer.setMode(mode);
      await rejectsUnverified("POST", "", { name: "首次添加", url: peer.url, peerKey: "fresh-key" });
    }
    peer.setMode("valid");
    const created = await request("POST", "", { name: "可核对的目标", url: peer.url, peerKey: "original-key" });
    assert.equal(created.status, 200);
    const { targets } = await created.json() as { targets: HandoffTarget[] };
    assert.equal(targets[0].hasKey, true);
    assert.equal(targets[0].peerFp, null, "首次保存 key 不依赖已配对目标的指纹");
    assert.ok(!JSON.stringify(targets).includes("original-key"));
    const saved = (await scope.resolveTargetsFor(owner))[0];
    assert.equal(saved.peerKeyFp, peer.fingerprint);
    for (const mode of ["missing", "invalid"] as const) {
      peer.setMode(mode);
      await rejectsUnverified("PUT", "/key", { url: peer.url, peerKey: "replacement-key" });
      if (multi) await rejectsUnverified("PATCH", `/${targets[0].id}`, { name: "未保存的名称", peerKey: "replacement-key" });
    }
    const probesBeforeClear = peer.credentials.length;
    assert.equal((await request("PUT", "/key", { url: peer.url, peerKey: "" })).status, 200);
    assert.equal(peer.credentials.length, probesBeforeClear, "清空 key 不依赖对端在线或支持签名");
    assert.equal((await scope.listTargets(actor))[0].hasKey, false);
    assert.equal((await scope.resolveTargetsFor(owner))[0].peerKeyFp, null);
    await rejectsUnverified("PUT", "/key", { url: peer.url, peerKey: "fresh-key" });
    assert.ok(peer.credentials.every((key) => key === undefined), "保存探测始终不传账号 key");
    peer.setMode("valid");
    assert.equal((await request("PUT", "/key", { url: peer.url, peerKey: "retry-key" })).status, 200);
    peer.credentials.length = 0;
    await withHandoffActor(owner, () => requestHandoffApproval(peer.url));
    assert.deepEqual(peer.credentials, [undefined, "retry-key"], "重试保存成功的 key 可以立即用于真实请求");
    peer.credentials.length = 0;
  }

  await writeSystemSetting("instanceMode", "single");
  await patchAppSettings({ handoffTargets: [] });
  await db.delete(handoffLocalPeerKeys);
  await scope.addTarget(SINGLE_ACTOR, { name: "来源机", url: peer.url, peerKey: "visible-key" });
  await scope.setPeerKey(SINGLE_ACTOR, `${peer.url}/pending`, "pending-key");
  const beforeDelete = await snapshot();
  const settingsBeforeDelete = await getAppSettings();
  await dbClient.executeMultiple("CREATE TRIGGER fail_key_delete BEFORE DELETE ON handoff_local_peer_keys BEGIN SELECT RAISE(ABORT, 'simulated key delete failure'); END;");
  const deletion = { handoffTargets: [], worktreeDefault: !settingsBeforeDelete.worktreeDefault };
  await assert.rejects(patchSettingsFor(SINGLE_ACTOR, deletion), /simulated key delete failure/);
  assert.deepEqual(await snapshot(), beforeDelete, "删除 key 失败时目标机和同批设置一起回滚，凭证仍可见");
  assert.deepEqual(await getAppSettings(), settingsBeforeDelete);
  await dbClient.executeMultiple("DROP TRIGGER fail_key_delete;");
  await patchSettingsFor(SINGLE_ACTOR, deletion);
  assert.deepEqual((await getAppSettings()).handoffTargets, []);
  assert.equal(await scope.peerKeyForRequest(null, `${peer.url}/api/handoff/import`), "", "重试删除成功后旧地址取不到 key");
  assert.equal(await scope.peerKeyForRequest(null, `${peer.url}/pending/api/handoff/import`), "pending-key", "单独为 pending 任务保存的 key 不受误删");
  await patchSettingsFor(SINGLE_ACTOR, deletion);
  await scope.addTarget(SINGLE_ACTOR, { name: "重新添加", url: peer.url });
  assert.equal((await scope.listTargets(SINGLE_ACTOR))[0].hasKey, false, "删除重试和重新添加不会复活旧 key");
  const beforeAddFailure = await snapshot();
  await dbClient.executeMultiple("CREATE TRIGGER fail_key_insert BEFORE INSERT ON handoff_local_peer_keys BEGIN SELECT RAISE(ABORT, 'simulated key insert failure'); END;");
  await assert.rejects(scope.addTarget(SINGLE_ACTOR, {
    name: "添加失败", url: `${peer.url}/new`, peerKey: "new-key",
  }), /simulated key insert failure/);
  assert.deepEqual(await snapshot(), beforeAddFailure, "验签通过后写 key 失败也不会留下半个目标机条目");
  await dbClient.executeMultiple("DROP TRIGGER fail_key_insert;");
  console.log("handoff key persistence: atomic deletion rollback/retry, verified saves, unchanged failures and usable retries passed");
} finally {
  await peer.close();
  await releaseTmpDb();
  rmSync(stage, { recursive: true, force: true });
}
