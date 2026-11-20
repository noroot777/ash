import "./isolated-data.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { acquireRuntimeHandover } from "../src/runtime-handover.js";
import { releaseRuntimeHandover, reserveRuntimeHandover, RuntimeHandoverBlockedError, runtimeHandoverActive, runtimeHandoverMatches } from "../src/runtime-handover-state.js";
import { claimAcceptanceHold, claimIdleWorkspaceTurns, claimOwnTurn, claimOwnTurnWhenReady, heldTurns, releaseTurn, whenTurnIdle, turnBusyText, tryClaimOwnTurn, turnIdentity } from "../src/turn-lock.js";
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

for (const claim of [
  (ids: string[]) => claimIdleWorkspaceTurns(ids),
  (ids: string[]) => claimAcceptanceHold(ids).release,
]) {
  const busy = claimOwnTurn("partial-busy");
  assert.ok(busy);
  const lease = reserveRuntimeHandover();
  assert.ok(lease);
  for (const ids of [[], ["partial-busy"], ["partial-busy", "partial-idle", "partial-idle"]]) {
    assert.throws(() => claim(ids), RuntimeHandoverBlockedError);
    assert.equal(turnIdentity("partial-idle"), null);
    assert.equal(turnIdentity("partial-busy"), busy);
  }
  const pending = claimOwnTurnWhenReady("partial-idle");
  releaseRuntimeHandover(lease);
  const release = claim(["partial-busy", "partial-idle", "partial-idle"]);
  assert.equal(await pending, null);
  assert.ok(turnIdentity("partial-idle"));
  release();
  release();
  assert.equal(turnIdentity("partial-idle"), null);
  assert.equal(turnIdentity("partial-busy"), busy);
  releaseTurn("partial-busy", busy);
}
console.log("✓ 两类部分占位在冻结期整体拒绝（含空集合与全忙集合），只跳过真实占用，释放不伤原回合");

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
  const holdsDirectory = join(directory, "holds");
  mkdirSync(holdsDirectory);
  execFileSync("git", ["init", "-b", "main", holdsDirectory], { stdio: "ignore" });
  const { holdTeamForAcceptance, holdMembers, topUpHold } = await import("../src/team-acceptance-hold.js");
  const { acceptanceGuard } = await import("../src/task-accept-guard.js");
  const { isAcceptingTask } = await import("../src/acceptance-lock.js");
  const { claimWorkspaceWrite, resolveWorkspaceContext } = await import("../src/workspace-write-gate.js");
  const { Hono } = await import("hono");
  const { serve } = await import("@hono/node-server");
  const { mountTaskAcceptanceRoutes } = await import("../src/task-accept-routes.js");
  const { mountScmRoutes } = await import("../src/scm-routes.js");
  const { mountFileRoutes } = await import("../src/file-routes.js");
  const at = new Date().toISOString();
  await db.insert(projects).values({ id: "hold-project", name: "holds", repoPath: holdsDirectory, createdAt: at });
  await db.insert(tasks).values([
    { id: "hold-lead", mode: "team", parentId: null },
    { id: "hold-worker", mode: "single", parentId: "hold-lead" },
    { id: "hold-peer", mode: "single", parentId: "hold-lead" },
  ].map((task) => ({
    ...task, projectId: "hold-project", title: task.id, body: "", status: "done", useWorktree: 0,
    agentType: "claude", labels: "[]", autoTitle: 0, createdAt: at, updatedAt: at,
  })));
  const api = new Hono();
  mountTaskAcceptanceRoutes(api);
  mountScmRoutes(api);
  mountFileRoutes(api);
  await db.update(tasks).set({ acceptedMergeMethod: "no_commit" }).where(eq(tasks.id, "hold-lead"));
  let listening!: (port: number) => void;
  const port = new Promise<number>((resolve) => { listening = resolve; });
  const http = serve({ fetch: api.fetch, hostname: "127.0.0.1", port: 0 }, (address) => listening(address.port));
  const rejectionLease = reserveRuntimeHandover();
  assert.ok(rejectionLease);
  const queuedWorker = claimOwnTurnWhenReady("hold-worker");
  try {
    for (const action of ["accept", "pending-merge/commit", "pending-merge/remerge"]) {
      const response = await fetch(`http://127.0.0.1:${await port}/tasks/hold-lead/${action}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: "{}",
      });
      assert.equal(response.status, 409, action);
      const body = await response.json();
      assert.equal(body.reason, "runtime_handover", action);
      assert.match(body.error, /正在切换新版服务/);
      assert.equal(isAcceptingTask("hold-lead"), false);
      assert.equal(holdMembers("hold-lead").size, 0);
      assert.equal(turnIdentity("hold-lead"), null);
      assert.equal(turnIdentity("hold-worker"), null);
    }
  } finally {
    releaseRuntimeHandover(rejectionLease);
    await new Promise<void>((resolve, reject) => http.close((error) => error ? reject(error) : resolve()));
  }
  const resumedWorker = await queuedWorker;
  assert.ok(resumedWorker);
  releaseTurn("hold-worker", resumedWorker);
  console.log("✓ 真实 HTTP 团队验收、补提交、重合并均在冻结期返回 409，不开始验收、不留互斥位，排着的运行只在拒绝后恢复");

  const occupiedWorker = claimOwnTurn("hold-worker");
  assert.ok(occupiedWorker);
  const releaseTeam = await holdTeamForAcceptance("hold-lead");
  assert.deepEqual([...holdMembers("hold-lead")].sort(), ["hold-lead", "hold-peer"]);
  releaseTurn("hold-worker", occupiedWorker);
  const topUpLease = reserveRuntimeHandover();
  assert.ok(topUpLease);
  const topUpWaiter = claimOwnTurnWhenReady("hold-worker");
  try {
    assert.throws(() => topUpHold("hold-lead"), RuntimeHandoverBlockedError);
    const guard = await acceptanceGuard("hold-lead", "before_merge");
    assert.equal(guard.failure?.reason, "runtime_handover");
    assert.equal(guard.failure?.httpStatus, 409);
    assert.equal(guard.failure?.phase, "before_merge");
    assert.equal(holdMembers("hold-lead").has("hold-worker"), false);
    releaseRuntimeHandover(topUpLease);
    topUpHold("hold-lead");
    assert.equal(await topUpWaiter, null);
    assert.equal(holdMembers("hold-lead").has("hold-worker"), true);
    assert.equal(claimOwnTurn("hold-worker"), null);
  } finally {
    releaseRuntimeHandover(topUpLease);
    releaseTeam();
  }
  assert.equal(holdMembers("hold-lead").size, 0);
  console.log("✓ 验收补占在冻结期拒绝推进阶段，释放许可后补齐成员，验收结束前排着的成员仍不能开跑");

  const context = await resolveWorkspaceContext("hold-worker");
  assert.ok("task" in context);
  const writingWorker = claimOwnTurn("hold-worker");
  assert.ok(writingWorker);
  const writeLease = reserveRuntimeHandover();
  assert.ok(writeLease);
  const marker = join(holdsDirectory, "force-write-marker");
  writeFileSync(marker, "unchanged");
  const writeOptions = {
    taskId: "hold-worker", context, forced: true,
    busyError: () => new Error("unexpected busy refusal"),
    archivedError: (message: string) => new Error(message),
    missingError: () => new Error("unexpected missing workspace"),
  };
  try {
    await assert.rejects(async () => {
      const release = await claimWorkspaceWrite(writeOptions);
      try { writeFileSync(marker, "changed"); } finally { release?.(); }
    }, /正在切换新版服务/);
    assert.equal(readFileSync(marker, "utf8"), "unchanged");
    assert.equal(turnIdentity("hold-peer"), null);
    assert.equal(turnIdentity("hold-worker"), writingWorker);
    for (const request of [
      { path: "/tasks/hold-worker/scm/stage", method: "POST", body: { paths: ["force-write-marker"], force: true } },
      { path: "/tasks/hold-worker/file", method: "DELETE", body: { path: "force-write-marker", mode: "permanent", force: true } },
    ]) {
      const response = await api.request(request.path, {
        method: request.method, headers: { "content-type": "application/json" }, body: JSON.stringify(request.body),
      });
      assert.equal(response.status, 409, request.path);
      const body = await response.json();
      assert.match(body.error, /正在切换新版服务/);
      assert.equal(body.needsForce, undefined);
      assert.equal(readFileSync(marker, "utf8"), "unchanged");
      assert.equal(turnIdentity("hold-peer"), null);
      assert.equal(turnIdentity("hold-worker"), writingWorker);
    }
    assert.equal(execFileSync("git", ["-C", holdsDirectory, "diff", "--cached", "--name-only"], { encoding: "utf8" }).trim(), "");
  } finally { releaseRuntimeHandover(writeLease); }
  const releaseWrite = await claimWorkspaceWrite(writeOptions);
  assert.ok(releaseWrite);
  assert.equal(claimOwnTurn("hold-peer"), null);
  releaseWrite();
  releaseWrite();
  assert.equal(turnIdentity("hold-worker"), writingWorker);
  releaseTurn("hold-worker", writingWorker);
  assert.equal(turnIdentity("hold-peer"), null);
  console.log("✓ 强制 SCM 写入与文件删除均返回 409（不是归档或待确认），不触碰文件或索引；解冻后仍保护闲置同伴");

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
