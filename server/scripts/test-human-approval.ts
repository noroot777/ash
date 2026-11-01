import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { Hono } from "hono";

const root = mkdtempSync(join(tmpdir(), "ash-human-approval-"));
const keys = generateKeyPairSync("ed25519");
const publicKey = keys.publicKey.export({ type: "spki", format: "der" }).toString("base64");
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
process.env.ASH_SUSPECT_TURN_MS = "1";
process.env.ASH_HUMAN_APPROVAL_PUBLIC_KEY = publicKey;

const { HumanApprovalAuthority, humanApproval } = await import("../src/auth/human-approval.js");
const { ensureSchema, db, dbClient } = await import("../src/db/index.js");
const { projects } = await import("../src/db/schema.js");
const { createTasks } = await import("../src/task-store.js");
const { claimTurn, releaseTurn, isTurnClaimed } = await import("../src/runs.js");
const { heldTurns } = await import("../src/turn-lock.js");
const { releaseSuspectTurn } = await import("../src/turn-lock-reclaim.js");
const { mountTurnReclaimRoutes } = await import("../src/turn-reclaim-routes.js");
const { authGate } = await import("../src/auth/middleware.js");
const { resourceGate } = await import("../src/auth/resource-gate.js");
const { personalWriteGate } = await import("../src/auth/personal-gate.js");
const { recentRejectionNotices } = await import("../src/user-action-rejection.js");

let clock = Date.now();
const scope = { action: "reclaim-turn" as const, taskId: "target", turnSeq: 7, claimedAt: clock, userId: "__local__" };
const authority = new HumanApprovalAuthority(publicKey, () => clock);
const makeProof = (challenge: { challengeId: string; payload: string }, privateKey = keys.privateKey) => ({
  challengeId: challenge.challengeId,
  signature: sign(null, Buffer.from(challenge.payload), privateKey).toString("base64url"),
});
for (const configured of [undefined, "bad-key", generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "der" }).toString("base64")]) {
  const unavailable = new HumanApprovalAuthority(configured);
  assert.equal(unavailable.fingerprint, null);
  assert.equal(unavailable.issue(scope, "target"), null);
  assert.equal(unavailable.consume({}, scope), null);
}
const challenge = authority.issue(scope, "target")!;
const proof = makeProof(challenge);
for (const invalid of [null, {}, { challengeId: challenge.challengeId, signature: "bad" }, makeProof(challenge, generateKeyPairSync("ed25519").privateKey)]) {
  assert.equal(authority.consume(invalid, scope), null);
}
for (const changed of [
  { ...scope, action: "kill-cua" }, { ...scope, taskId: "other" }, { ...scope, turnSeq: 8 },
  { ...scope, claimedAt: clock - 1 }, { ...scope, userId: "other" },
]) assert.equal(authority.consume(proof, changed as typeof scope), null);
assert.equal(new HumanApprovalAuthority(publicKey).consume(proof, scope), null, "重启后的实例不接受旧申请");
const tampered = { ...challenge, payload: challenge.payload.replace('"target"', '"other"') };
assert.equal(authority.consume(makeProof(tampered), scope), null, "修改公开申请字段不能改变实际授权");
assert.ok(authority.consume(proof, scope));
assert.equal(authority.consume(proof, scope), null, "授权只消费一次");
const expiring = makeProof(authority.issue(scope, "target")!);
clock += 5 * 60_000;
assert.equal(authority.consume(expiring, scope), null, "到期边界拒绝");
const bounded = new HumanApprovalAuthority(publicKey, () => clock);
for (let count = 0; count < 1024; count++) assert.ok(bounded.issue(scope, "target"));
assert.equal(bounded.issue(scope, "target"), null);
clock += 5 * 60_000;
assert.ok(bounded.issue(scope, "target"), "过期申请释放容量");

await ensureSchema();
const stamp = new Date().toISOString();
await db.insert(projects).values({ id: "p1", name: "approval", repoPath: root, createdAt: stamp });
await createTasks(["target", "other"].map((taskId) => ({
  id: taskId, projectId: "p1", title: taskId, body: "test", mode: "single", status: "failed",
  createdAt: stamp, updatedAt: stamp, agentType: "codex", useWorktree: false,
})) as Parameters<typeof createTasks>[0]);
const app = new Hono();
app.use("*", authGate());
app.use("*", resourceGate());
app.use("*", personalWriteGate());
const api = new Hono();
mountTurnReclaimRoutes(api);
app.route("/api", api);
const post = (taskId: string, approval?: unknown, headers: Record<string, string> = {}) => app.request(`/api/tasks/${taskId}/reclaim-turn`, {
  method: "POST", headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify({ acknowledgeDuplicateRisk: true, approval }),
});
const nextChallenge = async (taskId = "target") => {
  const response = await app.request(`/api/tasks/${taskId}/reclaim-turn/approval`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  return response.json() as Promise<{ challengeId: string; payload: string }>;
};
const wait = () => new Promise((resolveWait) => setTimeout(resolveWait, 8));
assert.ok(claimTurn("target"));
assert.ok(claimTurn("other"));
await wait();
assert.equal((await post("target")).status, 403, "裸请求和自称确认风险不能放开");
assert.equal((await post("target", undefined, { "sec-fetch-site": "same-origin", origin: "http://localhost" })).status, 403);
const publicChallenge = await nextChallenge();
assert.equal((await post("target", makeProof(publicChallenge, generateKeyPairSync("ed25519").privateKey))).status, 403, "能读页面和申请也不能伪造");
const validProof = makeProof(publicChallenge);
assert.equal((await post("target", validProof, { "x-ash-source-task-id": "agent" })).status, 403);
assert.equal((await post("target", validProof, { origin: "https://other.example" })).status, 403);
assert.equal((await post("other", validProof)).status, 403, "不能换任务复用");
assert.equal(isTurnClaimed("target"), true);
const result = await post("target", validProof);
assert.equal(result.status, 200);
assert.equal((await result.json() as { reclaimed: boolean }).reclaimed, true);
assert.equal(isTurnClaimed("target"), false);
assert.ok((await recentRejectionNotices("target")).some((notice) => notice.reason.includes(humanApproval.fingerprint!)), "历史记录验签公钥指纹");
assert.ok(claimTurn("target"));
await wait();
assert.equal((await post("target", validProof)).status, 403, "换锁之后旧签名不能重放");
const stale = makeProof(await nextChallenge());
const previous = heldTurns().find((turn) => turn.taskId === "target")!;
releaseTurn("target");
assert.ok(claimTurn("target"));
await wait();
assert.equal((await post("target", stale)).status, 403, "签名尚未消费时换主也拒绝");
assert.equal((await releaseSuspectTurn("target", undefined, { seq: previous.seq, keyFingerprint: humanApproval.fingerprint! })).ok, false, "释放函数复核签名占位身份");
assert.equal(isTurnClaimed("target"), true);
const parallel = makeProof(await nextChallenge());
const results = await Promise.all([post("target", parallel), post("target", parallel)]);
assert.equal(results.filter((response) => response.status === 200).length, 1, "并发授权只释放一次");
assert.ok(results.some((response) => response.status === 403 || response.status === 409));

const script = resolve("../scripts/human-approval.mjs");
const privatePath = join(root, "offline-fixture.pem");
const generated = spawnSync(process.execPath, [script, "generate", privatePath], { encoding: "utf8" });
assert.equal(generated.status, 0, generated.stderr);
assert.match(generated.stdout, /^ASH_HUMAN_APPROVAL_PUBLIC_KEY=/);
assert.equal(spawnSync(process.execPath, [script, "generate", privatePath]).status, 1, "不覆盖私钥");
const fixtureAuthority = new HumanApprovalAuthority(generated.stdout.trim().split("=").slice(1).join("="));
const fixtureChallenge = fixtureAuthority.issue(scope, "offline fixture")!;
const requestPath = join(root, "request.json");
writeFileSync(requestPath, JSON.stringify(fixtureChallenge));
const signed = spawnSync(process.execPath, [script, "sign", privatePath, requestPath], { encoding: "utf8", input: "target\n" });
assert.equal(signed.status, 0, signed.stderr);
assert.ok(fixtureAuthority.consume(JSON.parse(signed.stdout), scope));
const denied = spawnSync(process.execPath, [script, "sign", privatePath, requestPath], { encoding: "utf8", input: "wrong\n" });
assert.equal(denied.status, 1);
assert.equal(denied.stdout, "");
assert.equal(spawnSync(process.execPath, [script, "sign", privatePath, requestPath], { encoding: "utf8", input: "" }).status, 1);
assert.match(readFileSync(privatePath, "utf8"), /PRIVATE KEY/);

releaseTurn("other");
dbClient.close();
const unavailableProbe = `
  const { Hono } = await import("hono");
  const { mountTurnReclaimRoutes } = await import("./src/turn-reclaim-routes.ts");
  const app = new Hono();
  mountTurnReclaimRoutes(app);
  for (const [path, init] of [
    ["/tasks/target/reclaim-turn/approval", {}],
    ["/tasks/target/reclaim-turn", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ acknowledgeDuplicateRisk: true }) }],
  ]) {
    const response = await app.request(path, init);
    if (response.status !== 503) throw new Error(await response.text());
  }
  process.exit(0);
`;
for (const configured of ["", "invalid-public-key"]) {
  const unavailable = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", unavailableProbe], {
    encoding: "utf8", env: { ...process.env, ASH_HUMAN_APPROVAL_PUBLIC_KEY: configured },
  });
  assert.equal(unavailable.status, 0, unavailable.stderr);
}
rmSync(root, { recursive: true, force: true });
console.log("human-approval regressions ok");
