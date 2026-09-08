import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireTmpDb, releaseTmpDb } from "./tmp-db.js";

const stage = mkdtempSync(join(tmpdir(), "ash-handoff-key-concurrency-"));
process.env.ASH_DB = join(stage, "local.db");
process.env.ASH_RUNS_DIR = join(stage, "runs");
process.env.ASH_UPLOADS_DIR = join(stage, "uploads");
requireTmpDb("handoff-key-concurrency");
const { startSignedHandoffPeer } = await import("./handoff-signed-peer-fixture.js");
const peer = await startSignedHandoffPeer();
try {
  const { db, dbClient, ensureSchema } = await import("../src/db/index.js");
  const { handoffLocalPeerKeys } = await import("../src/db/schema.js");
  const { SINGLE_ACTOR } = await import("../src/auth/context.js");
  const { patchSettingsFor } = await import("../src/auth/personal-settings.js");
  const { HandoffError } = await import("../src/handoff-types.js");
  const scope = await import("../src/auth/handoff-scope.js");
  await ensureSchema();
  const add = () => scope.addTarget(SINGLE_ACTOR, { name: "来源机", url: peer.url });
  const remove = () => patchSettingsFor(SINGLE_ACTOR, { handoffTargets: [] });
  const key = () => scope.peerKeyForRequest(null, `${peer.url}/api/handoff/import`);
  const save = (value: string) => scope.setPeerKey(SINGLE_ACTOR, peer.url, value);
  const race = async (mutation: () => Promise<unknown>, expectedKey = "") => {
    const gate = peer.holdNextProbe();
    const saving = save("stale-key").then(() => null, (error: unknown) => error);
    try {
      await gate.received;
      await mutation();
    } finally { gate.release(); }
    const error = await saving;
    assert.ok(error instanceof HandoffError && error.status === 409, "验签期间目标或 key 变化后，旧保存请求应明确冲突");
    assert.equal(await key(), expectedKey, "迟到的保存不能恢复或覆盖凭证");
  };
  await add();
  await save("original-key");
  await race(async () => {
    await remove();
    assert.deepEqual(await scope.listTargets(SINGLE_ACTOR), []);
    assert.deepEqual(await db.select().from(handoffLocalPeerKeys), []);
  });
  await add();
  assert.equal((await scope.listTargets(SINGLE_ACTOR))[0].hasKey, false);
  await race(async () => { await remove(); await add(); });
  await race(() => save("newer-key"), "newer-key");
  await race(() => save(""));
  await race(async () => {
    await patchSettingsFor(SINGLE_ACTOR, { handoffTargets: [{ name: "来源机", url: `${peer.url}/moved` }] });
  });
  await remove();
  await add();
  await save("migration-key");
  await scope.rememberPeerFingerprint(null, peer.url, peer.fingerprint);
  await race(() => scope.saveVerifiedTargetAddress(SINGLE_ACTOR, {
    name: "来源机", url: `${peer.url}/moved`, peerFp: peer.fingerprint,
  }, [peer.url]));
  assert.equal(await scope.peerKeyForRequest(null, `${peer.url}/moved`), "migration-key", "换址保留已保存的凭证，不接收旧地址的迟到保存");

  await remove();
  await assert.rejects(save("settings-orphan-key"), (error: unknown) => error instanceof HandoffError && error.status === 404);
  await scope.setPeerKey(SINGLE_ACTOR, peer.url, "pending-key", peer.fingerprint, { allowUnlisted: true });
  assert.deepEqual(await scope.listTargets(SINGLE_ACTOR), [], "任务补填不强制新增设置条目");
  assert.equal(await key(), "pending-key", "删除之后新发起的任务补填仍然可用");
  await patchSettingsFor(SINGLE_ACTOR, { handoffTargets: [{ name: "其他目标", url: `${peer.url}/other` }] });
  assert.equal(await key(), "pending-key", "无关目标的编辑不会误清任务补填");

  await remove();
  await add();
  const rollbackGate = peer.holdNextProbe();
  const saving = save("after-rollback-key");
  try {
    await rollbackGate.received;
    await dbClient.executeMultiple("CREATE TRIGGER fail_key_delete BEFORE DELETE ON handoff_local_peer_keys BEGIN SELECT RAISE(ABORT, 'simulated key delete failure'); END;");
    await assert.rejects(remove(), /simulated key delete failure/);
    await dbClient.executeMultiple("DROP TRIGGER fail_key_delete;");
  } finally { rollbackGate.release(); }
  await saving;
  assert.equal(await key(), "after-rollback-key", "删除回滚也回滚版本变化，不误拒仍有效的保存");
  console.log("handoff key concurrency: delete, re-add, address change, clear, competing save, pending scope and rollback passed");
} finally {
  await peer.close();
  await releaseTmpDb();
  rmSync(stage, { recursive: true, force: true });
}
