import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { Hono } from "hono";
import type { HumanApprovalKeyFiles } from "../src/auth/human-approval-key.js";

const root = mkdtempSync(join(tmpdir(), "ash-human-approval-"));
const keys = generateKeyPairSync("ed25519");
const publicKey = keys.publicKey.export({ type: "spki", format: "der" }).toString("base64");
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
process.env.ASH_SUSPECT_TURN_MS = "1";
process.env.ASH_HUMAN_APPROVAL_PUBLIC_KEY = publicKey;

const { HumanApprovalAuthority, humanApproval, humanApprovalPublicKeyFile } = await import("../src/auth/human-approval.js");
const { readTrustedHumanApprovalKeyFile } = await import("../src/auth/human-approval-key.js");
const { ensureSchema, db, dbClient } = await import("../src/db/index.js");
const { projects } = await import("../src/db/schema.js");
const { createTasks } = await import("../src/task-store.js");
const { claimTurn, releaseTurn, isTurnClaimed, bindTurnToken, trackRun, untrackRun } = await import("../src/runs.js");
const { heldTurns } = await import("../src/turn-lock.js");
const { releaseSuspectTurn } = await import("../src/turn-lock-reclaim.js");
const { mountTurnReclaimRoutes } = await import("../src/turn-reclaim-routes.js");
const { authGate } = await import("../src/auth/middleware.js");
const { resourceGate } = await import("../src/auth/resource-gate.js");
const { personalWriteGate } = await import("../src/auth/personal-gate.js");
const { issueHumanActionToken, HUMAN_ACTION_TOKEN_HEADER, HUMAN_ACTION_TOKEN_NEXT_HEADER } = await import("../src/auth/human-action-token.js");
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
const stable = bounded.issue(scope, "target")!;
for (let count = 0; count < 1050; count++) assert.deepEqual(bounded.issue(scope, "target"), stable);
const anotherActor = { ...scope, userId: "another-actor" };
const anotherTask = { ...scope, taskId: "another-task" };
const actorChallenge = bounded.issue(anotherActor, "target")!;
const taskChallenge = bounded.issue(anotherTask, "another-task")!;
assert.notEqual(actorChallenge.challengeId, stable.challengeId);
assert.notEqual(taskChallenge.challengeId, stable.challengeId);
assert.ok(bounded.consume(makeProof(stable), scope), "刷申请不能挤掉用户手里的有效签名");
assert.ok(bounded.consume(makeProof(actorChallenge), anotherActor));
assert.ok(bounded.consume(makeProof(taskChallenge), anotherTask));
const oldGeneration = bounded.issue(scope, "target")!;
const newScope = { ...scope, turnSeq: scope.turnSeq + 1 };
assert.notEqual(bounded.issue(newScope, "target")!.challengeId, oldGeneration.challengeId);
assert.equal(bounded.consume(makeProof(oldGeneration), scope), null, "新占位替换旧申请");
clock += 5 * 60_000;
assert.notEqual(bounded.issue(scope, "target")!.challengeId, oldGeneration.challengeId);

const virtualPath = join(root, "administrator", "approval.pub");
const entries = new Map<string, ReturnType<HumanApprovalKeyFiles["inspect"]>>();
const writablePaths = new Set<string>();
let serviceOwner: number | undefined = 42;
let storedKey: string | undefined = publicKey;
let keyReads = 0;
const files: HumanApprovalKeyFiles = {
  serviceOwner: () => serviceOwner,
  inspect: (path) => {
    if (storedKey === undefined && path === virtualPath) throw new Error("ENOENT");
    return entries.get(path) ?? { owner: 0, file: path === virtualPath, directory: path !== virtualPath, symlink: false };
  },
  writable: (path) => writablePaths.has(path),
  read: () => { keyReads++; return storedKey!; },
};
assert.equal(readTrustedHumanApprovalKeyFile(virtualPath, files), publicKey);
for (const configure of [
  () => { serviceOwner = undefined; },
  () => { entries.set(virtualPath, { owner: 42, file: true, directory: false, symlink: false }); },
  () => { entries.set(dirname(virtualPath), { owner: 42, file: false, directory: true, symlink: false }); },
  () => { writablePaths.add(virtualPath); },
  () => { writablePaths.add(dirname(virtualPath)); },
  () => { entries.set(virtualPath, { owner: 0, file: true, directory: false, symlink: true }); },
  () => { entries.set(dirname(virtualPath), { owner: 0, file: false, directory: true, symlink: true }); },
  () => { entries.set(virtualPath, { owner: 0, file: false, directory: true, symlink: false }); },
]) {
  configure();
  const before = keyReads;
  assert.throws(() => readTrustedHumanApprovalKeyFile(virtualPath, files));
  assert.equal(keyReads, before, "任何不可信路径在读取密钥之前就拒绝");
  serviceOwner = 42;
  entries.clear();
  writablePaths.clear();
}
assert.throws(() => readTrustedHumanApprovalKeyFile("relative.pub", files));
const warnings: string[] = [];
const warn = console.warn;
console.warn = (message) => { warnings.push(String(message)); };
try {
  const hot = new HumanApprovalAuthority(() => readTrustedHumanApprovalKeyFile(virtualPath, files), () => clock);
  const loaded = hot.issue(scope, "hot config")!;
  assert.ok(loaded);
  storedKey = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" }).toString("base64");
  assert.equal(hot.consume(makeProof(loaded), scope), null);
  storedKey = publicKey;
  assert.equal(hot.consume(makeProof(loaded), scope), null, "恢复旧钥不恢复旧申请");
  const beforeInvalid = hot.issue(scope, "invalid")!;
  storedKey = "invalid-public-key";
  assert.equal(hot.fingerprint, null);
  storedKey = publicKey;
  assert.equal(hot.consume(makeProof(beforeInvalid), scope), null);
  const beforeDeletion = hot.issue(scope, "deleted")!;
  storedKey = undefined;
  assert.equal(hot.fingerprint, null);
  const count = warnings.length;
  assert.equal(hot.fingerprint, null);
  assert.equal(warnings.length, count, "相同拒绝原因不逐请求刷日志");
  storedKey = publicKey;
  assert.equal(hot.consume(makeProof(beforeDeletion), scope), null);
  writablePaths.add(dirname(virtualPath));
  assert.equal(hot.fingerprint, null, "父目录权限变化立即关闭入口");
  assert.ok(warnings.some((message) => message.includes("可被服务运行账号修改")));
  assert.ok(warnings.some((message) => message.includes("ENOENT")));
  assert.ok(warnings.some((message) => message.includes("公钥格式或算法无效")));
  assert.ok(warnings.every((message) => message.includes("信任锚变化") && !message.includes(publicKey)));
} finally {
  console.warn = warn;
}

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
  method: "POST", headers: { "content-type": "application/json", [HUMAN_ACTION_TOKEN_HEADER]: issueHumanActionToken(), ...headers },
  body: JSON.stringify({ acknowledgeDuplicateRisk: true, approval }),
});
const requestApproval = (taskId = "target", headers: Record<string, string> = {}) =>
  app.request(`/api/tasks/${taskId}/reclaim-turn/approval`, { method: "POST", headers: { [HUMAN_ACTION_TOKEN_HEADER]: issueHumanActionToken(), ...headers } });
const nextChallenge = async (taskId = "target") => {
  const response = await requestApproval(taskId);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.ok(response.headers.get(HUMAN_ACTION_TOKEN_NEXT_HEADER), "申请成功也轮换页面凭据");
  return response.json() as Promise<{ challengeId: string; payload: string }>;
};
const wait = () => new Promise((resolveWait) => setTimeout(resolveWait, 8));
assert.ok(claimTurn("target"));
assert.ok(claimTurn("other"));
await wait();
const heldBeforeConfig = heldTurns().find((turn) => turn.taskId === "target")!;
const assertUnavailable = async (expected: string, excluded: string) => {
  for (const response of [await requestApproval(), await post("target")]) {
    assert.equal(response.status, 503);
    const { error } = await response.json() as { error: string };
    assert.ok(error.includes(expected), error);
    assert.ok(!error.includes(excluded), error);
  }
  assert.deepEqual(heldTurns().find((turn) => turn.taskId === "target"), heldBeforeConfig);
};
delete process.env.ASH_HUMAN_APPROVAL_PUBLIC_KEY;
delete process.env.ASH_HUMAN_APPROVAL_PUBLIC_KEY_FILE;
assert.equal(humanApprovalPublicKeyFile(), undefined, "数据目录不再默认充当信任锚");
await assertUnavailable("补配需要重启服务；重启会清除内存中的回合占位", "无需重启");
assert.ok((await recentRejectionNotices("target")).some((notice) => notice.action === "申请人工授权" && notice.reason.includes("有效公钥")));
writeFileSync(`${process.env.ASH_DB}.human-approval.pub`, publicKey);
assert.equal((await requestApproval()).status, 503, "agent 向旧默认位置写自己的公钥不能开启入口");
const keyFile = join(root, "agent-writable-public-key");
process.env.ASH_HUMAN_APPROVAL_PUBLIC_KEY_FILE = keyFile;
await assertUnavailable("已预配 ASH_HUMAN_APPROVAL_PUBLIC_KEY_FILE", "补配需要重启");
writeFileSync(keyFile, publicKey);
await assertUnavailable("符合安全条件的公钥文件可热加载，无需重启", "补配需要重启");
chmodSync(keyFile, 0o444);
assert.equal((await requestApproval()).status, 503, "服务自己拥有的只读文件仍能被自己 chmod，不可信");
chmodSync(keyFile, 0o644);
assert.deepEqual(heldTurns().find((turn) => turn.taskId === "target"), heldBeforeConfig);
process.env.ASH_HUMAN_APPROVAL_PUBLIC_KEY = "invalid-inline-key";
await assertUnavailable("启动公钥 ASH_HUMAN_APPROVAL_PUBLIC_KEY 无效", "无需重启");
process.env.ASH_HUMAN_APPROVAL_PUBLIC_KEY = publicKey;
assert.equal((await app.request("/api/tasks/target/reclaim-turn/approval")).status, 404, "GET 不再创建申请");
assert.equal((await requestApproval("missing")).status, 404);
for (const headers of [
  { "x-ash-source-task-id": "agent" }, { "x-ash-turn-token": "token" },
  { origin: "https://other.example" }, { "sec-fetch-site": "cross-site" },
]) {
  const rejected = await requestApproval("target", headers);
  assert.equal(rejected.status, 403);
  const { error } = await rejected.json() as { error: string };
  assert.ok((await recentRejectionNotices("target")).some((notice) => notice.action === "申请人工授权" && notice.reason === error), "中间件拒绝也持久留痕");
}
assert.equal((await post("target")).status, 403, "裸请求和自称确认风险不能放开");
assert.equal((await post("target", undefined, { "sec-fetch-site": "same-origin", origin: "http://localhost" })).status, 403);
const publicChallenge = await nextChallenge();
for (let count = 0; count < 1050; count++) assert.deepEqual(await nextChallenge(), publicChallenge, "HTTP 连刷申请不能耗尽配额或作废用户申请");
assert.equal((await post("target", makeProof(publicChallenge, generateKeyPairSync("ed25519").privateKey))).status, 403, "能读页面和申请也不能伪造");
const validProof = makeProof(publicChallenge);
for (const path of ["reclaim-turn/approval", "reclaim-turn"]) {
  const withoutPage = await app.request(`/api/tasks/target/${path}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ acknowledgeDuplicateRisk: true, approval: validProof }),
  });
  assert.equal(withoutPage.status, 403, "离机签名不绕过主分支的页面凭据闸");
  assert.match((await withoutPage.json() as { error: string }).error, /页面凭据/);
  assert.ok(isTurnClaimed("target"));
}
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
assert.equal((await releaseSuspectTurn("target", undefined, "unverified", { seq: previous.seq, keyFingerprint: humanApproval.fingerprint! })).ok, false, "释放函数复核签名占位身份");
assert.equal(isTurnClaimed("target"), true);
const parallel = makeProof(await nextChallenge());
const results = await Promise.all([post("target", parallel), post("target", parallel)]);
assert.equal(results.filter((response) => response.status === 200).length, 1, "并发授权只释放一次");
assert.ok(results.some((response) => response.status === 403 || response.status === 409));
const expectReason = async (pattern: RegExp) => {
  for (const response of [await requestApproval(), await post("target")]) {
    assert.equal(response.status, 409);
    const { error } = await response.json() as { error: string };
    assert.match(error, pattern);
    assert.ok((await recentRejectionNotices("target")).some((notice) => notice.reason === error));
  }
};
await expectReason(/没有被占着的回合占位/);
assert.ok(claimTurn("target", "duet"));
await expectReason(/身份是 duet.*不提供手动放开/);
releaseTurn("target");
assert.ok(claimTurn("target"));
bindTurnToken("target", "bound-token");
await expectReason(/已经绑过回合令牌/);
releaseTurn("target");
assert.ok(claimTurn("target"));
const liveHandle = { kill: () => {} };
trackRun("target", liveHandle);
await expectReason(/仍有 CLI 进程在运行.*不能从旁边拔掉/);
untrackRun("target", liveHandle);
releaseTurn("target");
const realNow = Date.now;
const frozenNow = Date.now();
Date.now = () => frozenNow;
try {
  assert.ok(claimTurn("target"));
  await expectReason(/正常起跑的时间范围/);
} finally {
  Date.now = realNow;
  releaseTurn("target");
}

const script = resolve("../scripts/human-approval.mjs");
const privatePath = join(root, "offline-fixture.pem");
const generated = spawnSync(process.execPath, [script, "generate", privatePath], { encoding: "utf8" });
assert.equal(generated.status, 0, generated.stderr);
assert.match(generated.stdout, /^ASH_HUMAN_APPROVAL_PUBLIC_KEY=/);
assert.equal(spawnSync(process.execPath, [script, "generate", privatePath]).status, 1, "不覆盖私钥");
const signingNow = Date.now();
const fixtureAuthority = new HumanApprovalAuthority(generated.stdout.trim().split("=").slice(1).join("="), () => signingNow);
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
const signAt = (offset: number) => spawnSync(process.execPath, [
  "--import", `data:text/javascript,Date.now=()=>${signingNow + offset}`,
  script, "sign", privatePath, requestPath,
], { encoding: "utf8", input: "target\n" });
for (const offset of [-2000, -60_000]) {
  writeFileSync(requestPath, JSON.stringify(fixtureAuthority.issue(scope, "clock skew")!));
  const skewed = signAt(offset);
  assert.equal(skewed.status, 0, skewed.stderr);
  assert.ok(fixtureAuthority.consume(JSON.parse(skewed.stdout), scope), "慢时钟的真实签名仍能由服务验过");
}
const validRequest = fixtureAuthority.issue(scope, "errors")!;
const validPayload = JSON.parse(validRequest.payload);
for (const [fields, pattern] of [
  [{ issuedAt: undefined }, /申请字段不合法/],
  [{ expiresAt: validPayload.issuedAt + 300_001 }, /申请字段不合法/],
  [{ keyFingerprint: "wrong" }, /授权公钥不匹配/],
  [{ issuedAt: signingNow - 600_000, expiresAt: signingNow - 300_000 }, /申请已过期/],
] as const) {
  writeFileSync(requestPath, JSON.stringify({ ...validRequest, payload: JSON.stringify({ ...validPayload, ...fields }) }));
  const failed = signAt(0);
  assert.equal(failed.status, 1);
  assert.equal(failed.stdout, "");
  assert.match(failed.stderr, pattern);
}
writeFileSync(requestPath, JSON.stringify(validRequest));
assert.match(signAt(300_000).stderr, /申请已过期/);

releaseTurn("other");
dbClient.close();
const unavailableProbe = `
  const { Hono } = await import("hono");
  const { mountTurnReclaimRoutes } = await import("./src/turn-reclaim-routes.ts");
  const app = new Hono();
  mountTurnReclaimRoutes(app);
  for (const [path, init] of [
    ["/tasks/target/reclaim-turn/approval", { method: "POST" }],
    ["/tasks/target/reclaim-turn", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ acknowledgeDuplicateRisk: true }) }],
  ]) {
    const response = await app.request(path, init);
    if (response.status !== 503) throw new Error(await response.text());
  }
  process.exit(0);
`;
for (const configured of ["", "invalid-public-key"]) {
  const unavailable = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", unavailableProbe], {
    encoding: "utf8", env: { ...process.env, ASH_HUMAN_APPROVAL_PUBLIC_KEY: configured, ASH_HUMAN_APPROVAL_PUBLIC_KEY_FILE: join(root, "missing-key") },
  });
  assert.equal(unavailable.status, 0, unavailable.stderr);
}
rmSync(root, { recursive: true, force: true });
console.log("human-approval regressions ok");
