import "./isolated-data.js";
import assert from "node:assert/strict";
import { acquireRuntimeHandover } from "../src/runtime-handover.js";
import { releaseRuntimeHandover, runtimeHandoverActive, runtimeHandoverMatches } from "../src/runtime-handover-state.js";
import { claimOwnTurn, claimOwnTurnWhenReady, heldTurns, releaseTurn, whenTurnIdle, turnBusyText, tryClaimOwnTurn } from "../src/turn-lock.js";
import type { RestartImpact } from "../src/reattach.js";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { spawnTestFixture } from "../../scripts/test-process-scope.mjs";
import { withTestResources } from "../../scripts/test-process-resources.mjs";

process.env.NAVI_LAX_DONE = "1";
const empty: RestartImpact = { survives: [], resumes: [], interrupted: [], mcpDisrupted: [] };
const owner = claimOwnTurn("survivor");
assert.ok(owner);
owner.token = "turn-token";
let transferredRan = false;
const cancelTransferred = whenTurnIdle("survivor", () => { transferredRan = true; });
const survivor = { id: "survivor", title: "still working", pid: process.pid };
const impact = { ...empty, survives: [survivor], mcpDisrupted: [survivor] };
const accepted = await acquireRuntimeHandover(async () => {
  assert.equal(claimOwnTurn("racing-start"), null);
  return impact;
}, heldTurns);
assert.ok(accepted.lease);
assert.equal(runtimeHandoverActive(), true);
assert.equal(runtimeHandoverMatches(accepted.lease), true);
assert.equal(releaseRuntimeHandover("wrong-lease"), false);
assert.equal(claimOwnTurn("another"), null);
assert.ok((await acquireRuntimeHandover(async () => empty, heldTurns)).error);
releaseTurn("survivor", owner);
cancelTransferred();
releaseRuntimeHandover(accepted.lease);
assert.equal(transferredRan, false);
assert.equal(runtimeHandoverActive(), false);
console.log("✓ 保留 MCP 的 detached 回合可接管，接管期间新起跑与并发接管被拦住");

for (const blocked of [
  { ...empty, interrupted: [{ id: "queued", title: "queued" }] },
  { ...empty, resumes: [{ id: "team", title: "active team turn" }] },
]) {
  assert.ok((await acquireRuntimeHandover(async () => blocked, heldTurns)).error);
  assert.equal(runtimeHandoverActive(), false);
}
const starting = claimOwnTurn("starting");
assert.ok(starting);
assert.ok((await acquireRuntimeHandover(async () => empty, heldTurns)).error);
releaseTurn("starting", starting);
await assert.rejects(acquireRuntimeHandover(async () => { throw new Error("probe failed"); }, heldTurns), /probe failed/);
assert.equal(runtimeHandoverActive(), false);
console.log("✓ 团队当前回合、排队、未落库起跑与探测失败均保留旧服务并撤销闸门");

const originalNow = Date.now;
const expires = await acquireRuntimeHandover(async () => empty, heldTurns);
assert.ok(expires.lease);
const expirationWaiter = claimOwnTurnWhenReady("expiry-waiter");
try {
  Date.now = () => originalNow() + 61_000;
  assert.equal(runtimeHandoverMatches(expires.lease), false);
  const after = claimOwnTurn("after-expiry");
  assert.ok(after);
  releaseTurn("after-expiry", after);
  const resumed = await expirationWaiter;
  assert.ok(resumed);
  releaseTurn("expiry-waiter", resumed);
} finally {
  Date.now = originalNow;
  releaseRuntimeHandover(expires.lease);
}
console.log("✓ 启动器退出后接管许可自动过期，不留下永久冻结");

const waitingLease = await acquireRuntimeHandover(async () => empty, heldTurns);
assert.ok(waitingLease.lease);
assert.equal(tryClaimOwnTurn("manual-run").kind, "handover");
let attempts = 0;
let canceledRan = false;
const cancelWaiting = whenTurnIdle("canceled-wait", () => { canceledRan = true; });
cancelWaiting();
const reviewStarted = new Promise<void>((resolve) => {
  const dispatch = () => whenTurnIdle("review-target", () => {
    attempts += 1;
    const review = claimOwnTurn("review-target", "reviewer");
    assert.ok(review, "a released handover must not consume review retries");
    releaseTurn("review-target", review);
    resolve();
  });
  dispatch();
});
const pendingRun = claimOwnTurnWhenReady("manual-run");
await new Promise((resolve) => setTimeout(resolve, 20));
assert.equal(attempts, 0);
assert.match(turnBusyText("manual-run", "运行"), /切换新版服务/);
releaseRuntimeHandover(waitingLease.lease);
await reviewStarted;
const resumedRun = await pendingRun;
assert.ok(resumedRun);
releaseTurn("manual-run", resumedRun);
assert.equal(attempts, 1);
assert.equal(canceledRan, false);
console.log("✓ 冻结期间派审不消耗重排次数，手动起跑与空闲回调等许可释放，取消等待有效");

if (process.platform === "darwin") {
  const { desktopRuntimeMcp } = await import("../src/mcp-registry/desktop-runtime.js");
  const { pointsAt } = await import("../src/mcp-registry/host-setup.js");
  const home = mkdtempSync(join(tmpdir(), "navi-runtime-host-mcp-"));
  try {
    const store = join(home, ".mac-runtimes");
    const versions = ["a".repeat(64), "b".repeat(64)];
    for (const id of versions) {
      const code = join(store, id);
      mkdirSync(code, { recursive: true });
      writeFileSync(join(code, ".runtime.json"), JSON.stringify({ format: 1, id }));
    }
    writeFileSync(join(store, "mcp.sh"), "#!/bin/sh\n");
    symlinkSync(versions[0], join(store, "current"));
    const first = desktopRuntimeMcp(join(store, versions[0]), home, "http://127.0.0.1:4317");
    assert.ok(first);
    assert.equal(first.command, "/bin/sh");
    const registration = { command: first.command, args: first.args, naviUrl: first.env.NAVI_URL };
    rmSync(join(store, "current"));
    symlinkSync(versions[1], join(store, "current"));
    const second = desktopRuntimeMcp(join(store, versions[1]), home, "http://127.0.0.1:4317");
    assert.deepEqual(second, first);
    assert.equal(pointsAt(registration, second!), true);
    assert.equal(pointsAt({ ...registration, args: [join(home, "Navi.app/Contents/Resources/app/mcp/dist/index.js")] }, second!), false);
    assert.equal(desktopRuntimeMcp(home, home, "http://127.0.0.1:4317"), null);
    console.log("✓ 宿主登记建议使用不变的外置入口，更新后仍认作自家，旧包登记明确提示迁移");
  } finally { rmSync(home, { recursive: true, force: true }); }
}

const { STRICT_DONE_PROTOCOL } = await import("../src/settle-status.js");
assert.equal(STRICT_DONE_PROTOCOL, false, "the detached fixture must initialize lax completion before loading production modules");
const { db, ensureSchema } = await import("../src/db/index.js");
const { tasks, projects, sessions } = await import("../src/db/schema.js");
const { reattachRunningTasks, restartImpact } = await import("../src/reattach.js");
const { inspectProcess } = await import("../src/proc.js");
const { isRunning } = await import("../src/runs.js");
const { turnIdentity } = await import("../src/turn-lock.js");
const { RUNS_DIR } = await import("../src/paths.js");
const directory = mkdtempSync(join(tmpdir(), "navi-runtime-reattach-"));
const runDir = join(RUNS_DIR, "upgrade-survivor");
mkdirSync(runDir, { recursive: true });
const output = join(directory, "agent.out");
const errors = join(directory, "agent.err");
const result = join(directory, "agent.rc");
const finish = join(directory, "finish");
const source = join(directory, "agent.cjs");
writeFileSync(errors, "");
writeFileSync(output, "");
writeFileSync(source, `
const fs = require('node:fs');
const emit = value => fs.appendFileSync(${JSON.stringify(output)}, JSON.stringify(value) + '\\n');
emit({ type: 'system', session_id: 'runtime-upgrade' });
setInterval(() => {
  emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'after upgrade\\n' } } });
  if (fs.existsSync(${JSON.stringify(finish)})) {
    emit({ type: 'result', subtype: 'success', session_id: 'runtime-upgrade' });
    fs.writeFileSync(${JSON.stringify(result)}, '0'); process.exit(0);
  }
}, 100);
`);
const fixture = spawnTestFixture(process.execPath, [source], { cwd: directory, stdio: "ignore" });
await withTestResources(async () => {
  await ensureSchema();
  const { continueWhenIdle } = await import("../src/turn-idle-delivery.js");
  const { claimReconcileTurnWhenReady } = await import("../src/runs.js");
  const { claimLaunchTurn } = await import("../src/launch-capacity.js");
  const deferredLease = await acquireRuntimeHandover(async () => empty, heldTurns);
  assert.ok(deferredLease.lease);
  const failures: string[] = [];
  const deferredReview = new Promise<void>((resolve) => {
    continueWhenIdle("deferred-review", "review", {}, (_message, failure) => {
      failures.push(failure); resolve();
    }, undefined, async () => "test ownership superseded");
  });
  const reconciliation = claimReconcileTurnWhenReady("deferred-reconcile");
  const launch = claimLaunchTurn("deferred-launch", null);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(failures, []);
  assert.equal(heldTurns().length, 0);
  releaseRuntimeHandover(deferredLease.lease);
  await deferredReview;
  assert.deepEqual(failures, ["superseded"]);
  const finishReconciliation = await reconciliation;
  assert.ok(finishReconciliation);
  finishReconciliation();
  const launched = await launch;
  assert.equal(launched.ok, true);
  if (launched.ok) releaseTurn("deferred-launch", launched.turn);
  console.log("✓ 生产派审投递、残留结算与容量认领都等待冻结释放，不落误失败、不丢结算");
  const startedAt = new Date().toISOString();
  await db.insert(projects).values({ id: "runtime-upgrade-project", name: "upgrade", repoPath: directory, createdAt: startedAt });
  await db.insert(tasks).values({
    id: "upgrade-survivor", projectId: "runtime-upgrade-project", title: "runtime upgrade", body: "", status: "running",
    mode: "single", agentType: "claude", labels: "[]", createdAt: startedAt, updatedAt: startedAt,
    autoTitle: 0, useWorktree: 0, activeTurnToken: "retained-turn-token",
  });
  const pid = fixture.pid;
  assert.ok(pid);
  await db.insert(sessions).values({
    id: "upgrade-session", taskId: "upgrade-survivor", role: "single", agentType: "claude", executor: "claude@local",
    cwd: directory, cliSessionId: "runtime-upgrade", commandLine: "fixture", startedAt, turnStartedAt: startedAt,
    agentPid: pid, agentStartedAt: inspectProcess(pid)?.startedAt, agentOutPath: output, agentErrPath: errors,
    agentRcPath: result, agentOffset: 0,
  });
  const permit = await acquireRuntimeHandover(restartImpact, heldTurns);
  assert.ok(permit.lease);
  releaseRuntimeHandover(permit.lease);
  const adopted = await reattachRunningTasks();
  assert.ok(adopted.has("upgrade-survivor"));
  assert.equal(isRunning("upgrade-survivor"), true);
  assert.equal(turnIdentity("upgrade-survivor")?.token, "retained-turn-token");
  process.kill(pid, 0);
  writeFileSync(finish, "finish");
  let ended = false;
  for (let attempt = 0; attempt < 200; attempt++) {
    const session = (await db.select().from(sessions).where(eq(sessions.id, "upgrade-session")))[0];
    if (session?.endedAt) { ended = true; break; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(ended);
  assert.equal((await db.select().from(tasks).where(eq(tasks.id, "upgrade-survivor")))[0]?.status, "done");
  assert.ok(existsSync(join(runDir, "upgrade-session.md")));
  assert.match(readFileSync(join(runDir, "upgrade-session.md"), "utf8"), /after upgrade/);
  console.log("✓ 真实接管入口保留原 agent PID 和回合令牌，接续输出并完成原任务");
}, [
  () => fixture.dispose(),
  () => rmSync(directory, { recursive: true, force: true }),
  () => rmSync(runDir, { recursive: true, force: true }),
]);
