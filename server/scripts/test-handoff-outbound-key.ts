import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireTmpDb, releaseTmpDb } from "./tmp-db.js";

const stage = mkdtempSync(join(tmpdir(), "ash-outbound-key-"));
process.env.ASH_DB = join(stage, "local.db");
process.env.ASH_RUNS_DIR = join(stage, "runs");
process.env.ASH_UPLOADS_DIR = join(stage, "uploads");
requireTmpDb("ash-outbound-key");
let peer: Server | undefined;
try {
  const { db, dbClient, ensureSchema } = await import("../src/db/index.js");
  const { handoffLocalPeerKeys, userHandoffTargets, users } = await import("../src/db/schema.js");
  const { eq } = await import("drizzle-orm");
  const { canonicalPingChallenge, fingerprintOf } = await import("../src/handoff-identity.js");
  const { fetchPeer, pingPeer, requestHandoffApproval } = await import("../src/handoff-peer-client.js");
  const { HandoffError } = await import("../src/handoff-types.js");
  const { withHandoffActor } = await import("../src/auth/handoff-outbound.js");
  const { SINGLE_ACTOR } = await import("../src/auth/context.js");
  const { patchAppSettings, writeSystemSetting } = await import("../src/app-settings.js");
  const { invalidateInstanceConfig } = await import("../src/auth/mode.js");
  const scope = await import("../src/auth/handoff-scope.js");
  await dbClient.executeMultiple("CREATE TABLE user_handoff_targets (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, url TEXT NOT NULL, peer_fp TEXT, peer_key TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL); INSERT INTO user_handoff_targets VALUES ('legacy', 'alice', 'legacy', 'http://legacy', 'legacy-target-fingerprint', 'legacy-key', 'legacy-time');");
  await ensureSchema();
  assert.equal((await db.select().from(userHandoffTargets))[0].peerKeyFp, null, "旧多人数据不会用目标行指纹自动给 key 补归属");
  await db.insert(users).values({ id: "alice", name: "Alice", dirName: "alice", createdAt: new Date().toISOString() });
  const machines = [generateKeyPairSync("ed25519"), generateKeyPairSync("ed25519")];
  const fingerprints = machines.map((keys) => fingerprintOf(keys.publicKey.export({ type: "spki", format: "der" }).toString("base64")));
  const seen: { path: string; key: string | undefined; signature: string | undefined }[] = [];
  let invalidSignature = false;
  let redirect = false;
  let redirectRequest = false;
  const start = async (machine: number, port = 0) => {
    peer = createServer(async (req, res) => {
      const url = new URL(req.url!, "http://localhost");
      seen.push({ path: url.pathname, key: req.headers["x-ash-peer-user-key"] as string | undefined, signature: req.headers["x-ash-peer-key"] as string | undefined });
      if (redirect || (redirectRequest && !url.pathname.endsWith("/ping"))) {
        res.writeHead(307, { location: "/redirected" }); res.end(); return;
      }
      let body = "";
      for await (const chunk of req) body += chunk;
      const nonce = url.searchParams.get("nonce") ?? (body ? JSON.parse(body).nonce : "");
      const publicKey = machines[machine].publicKey.export({ type: "spki", format: "der" }).toString("base64");
      const sig = sign(null, Buffer.from(canonicalPingChallenge(invalidSignature ? "wrong-nonce" : nonce)), machines[machine].privateKey).toString("base64");
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, service: "ash", host: "fixture", projects: [], peerStatus: "approved", identity: { publicKey, sig } }));
    });
    await new Promise<void>((resolve) => peer!.listen(port, "127.0.0.1", resolve));
    return (peer.address() as { port: number }).port;
  };
  const stop = async () => {
    peer!.closeAllConnections();
    await new Promise<void>((resolve) => peer!.close(() => resolve()));
    peer = undefined;
  };
  for (const multi of [false, true]) {
    await writeSystemSetting("instanceMode", multi ? "multi" : "single");
    invalidateInstanceConfig();
    await patchAppSettings({ handoffTargets: [] });
    await db.delete(handoffLocalPeerKeys);
    await db.delete(userHandoffTargets);
    const actor = multi ? { kind: "user" as const, userId: "alice", role: "member" as const, name: "Alice" } : SINGLE_ACTOR;
    const owner = multi ? "alice" : null;
    const port = await start(1);
    const url = `http://127.0.0.1:${port}/ash`;
    await scope.addTarget(actor, { name: "机器 B", url });
    await scope.setPeerKey(actor, url, "machine-b-account-key", fingerprints[1]);
    await scope.rememberPeerFingerprint(owner, url, fingerprints[1]);
    const perform = <T>(action: () => Promise<T>) => withHandoffActor(owner, action);
    seen.length = 0;
    await perform(() => requestHandoffApproval(url));
    assert.deepEqual(seen.map((row) => row.key), [undefined, "machine-b-account-key"], "同源机器先无凭据验签，再发送账号 key");
    assert.equal(seen[0].signature, undefined, "身份探测不发送本机签名");
    seen.length = 0;
    await assert.rejects(perform(() => pingPeer(url, fingerprints[0])), (error: unknown) => error instanceof HandoffError && error.status === 409);
    assert.ok(seen.every((row) => row.key === undefined), "任务指纹与 key 归属不一致时，当前机器也不能收到 key");
    await scope.rememberPeerFingerprint(owner, url, fingerprints[0]);
    seen.length = 0;
    await assert.rejects(perform(() => fetchPeer(`${url}/api/handoff/import`, { method: "POST", body: "{}" })), HandoffError);
    assert.ok(seen.every((row) => row.key === undefined), "目标机设置与 key 归属不一致时，直接请求也被拒绝");
    await scope.rememberPeerFingerprint(owner, url, fingerprints[1]);

    await stop();
    await start(0, port);
    for (const action of [
      () => requestHandoffApproval(url),
      () => pingPeer(url, fingerprints[1]),
      () => pingPeer(url, fingerprints[1], { taskId: "source-task", returnTransferId: "pending-return" }),
      () => fetchPeer(`${url}/api/handoff/import`, { method: "POST", body: "{}" }),
    ]) {
      seen.length = 0;
      await assert.rejects(perform(action), (error: unknown) => error instanceof HandoffError && error.status === 409 && /身份/.test(error.message));
      assert.ok(seen.every((row) => row.key === undefined && row.signature === undefined), "同 IP/端口换成 A 后，每条请求都在泄露 B key 之前被拒绝");
      assert.ok(seen.every((row) => row.path === "/ash/api/handoff/ping"), "正文和任务标识在核对失败时也不发送");
    }
    await stop();
    await start(1, port);
    invalidSignature = true;
    seen.length = 0;
    await assert.rejects(perform(() => requestHandoffApproval(url)), HandoffError);
    assert.ok(seen.every((row) => row.key === undefined));
    invalidSignature = false;

    if (multi) await db.update(userHandoffTargets).set({ peerKeyFp: null }).where(eq(userHandoffTargets.userId, "alice"));
    else await db.update(handoffLocalPeerKeys).set({ peerFp: null });
    const before = multi ? await db.select().from(userHandoffTargets) : await db.select().from(handoffLocalPeerKeys);
    seen.length = 0;
    await assert.rejects(perform(() => requestHandoffApproval(url)), (error: unknown) => error instanceof HandoffError && error.code === "peer-key-required");
    assert.ok(seen.every((row) => row.key === undefined), "旧 key 缺少归属时不直接发送");
    assert.deepEqual(multi ? await db.select().from(userHandoffTargets) : await db.select().from(handoffLocalPeerKeys), before, "发送动作不自动给旧 key 补归属");
    await scope.setPeerKey(actor, url, "machine-b-account-key", fingerprints[1]);
    seen.length = 0;
    await perform(() => fetchPeer(`${url}/api/handoff/import`, { method: "POST", body: "{}" }));
    assert.deepEqual(seen.map((row) => row.key), [undefined, "machine-b-account-key"], "显式重新绑定后可以继续接力");
    redirectRequest = true;
    seen.length = 0;
    await assert.rejects(perform(() => fetchPeer(`${url}/api/handoff/import`, { method: "POST", body: "{}" })), HandoffError);
    assert.deepEqual(seen.map((row) => row.path), ["/ash/api/handoff/ping", "/ash/api/handoff/import"], "带 key 的请求不跟随重定向");
    redirectRequest = false;
    seen.length = 0;
    await perform(() => fetchPeer(`${url}-other/api/handoff/import`, { method: "POST", body: "{}", headers: { "X-Ash-Peer-User-Key": "unverified-header-key" } }));
    assert.deepEqual(seen.map((row) => row.key), [undefined], "相似路径不匹配 key，也不能用自定义请求头绕过核对");
    redirect = true;
    seen.length = 0;
    await assert.rejects(perform(() => requestHandoffApproval(url)), HandoffError);
    assert.deepEqual(seen.map((row) => row.key), [undefined], "无凭据探测不经重定向替原地址确认身份");
    redirect = false;
    await stop();
  }
  console.log("handoff outbound keys: signed verification before credentials, task identity, replacement host, legacy binding and user scope passed");
} finally {
  if (peer) {
    peer.closeAllConnections();
    await new Promise<void>((resolve) => peer!.close(() => resolve()));
  }
  await releaseTmpDb();
  rmSync(stage, { recursive: true, force: true });
}
