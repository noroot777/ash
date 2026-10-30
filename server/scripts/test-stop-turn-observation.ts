import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "ash-stop-observation-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
process.env.ASH_SUSPECT_TURN_MS = "60000";

const { ensureSchema, db, dbClient } = await import("../src/db/index.js");
const { projects } = await import("../src/db/schema.js");
const { createTasks } = await import("../src/task-store.js");
const { claimTurn, releaseTurn, bindTurnToken, heldTurns, isTurnClaimed } = await import("../src/turn-lock.js");
const { stopStartingTurn } = await import("../src/stop-starting-turn.js");
const { turnReclaimStatus, suspectTurns, releaseSuspectTurn } = await import("../src/turn-lock-reclaim.js");
const { recentRejectionNotices } = await import("../src/user-action-rejection.js");
const { Hono } = await import("hono");
const { mountTaskRoutes } = await import("../src/task-routes.js");
await ensureSchema();
await db.insert(projects).values({ id: "p-stop", name: "stop observation", repoPath: root, createdAt: new Date().toISOString() });
const api = new Hono();
mountTaskRoutes(api);

async function seed(taskId: string, role = "single"): Promise<void> {
  const stamp = new Date().toISOString();
  await createTasks([{
    id: taskId, projectId: "p-stop", title: taskId, body: "test", mode: "single", status: "canceled",
    agentType: "codex", useWorktree: false, workflowMode: "free", createdAt: stamp, updatedAt: stamp,
  }]);
  assert.equal(claimTurn(taskId, role), true);
}

async function noticesFromApi(taskId: string): Promise<{ notices: { action: string; reason: string }[]; remedy: unknown }> {
  const response = await api.request(`/tasks/${taskId}/notices`);
  assert.equal(response.status, 200);
  return response.json();
}

async function waitForReleaseNotice(taskId: string, count = 1): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const notices = await recentRejectionNotices(taskId);
    if (notices.filter((entry) => entry.action === "停止后的回合占位已释放").length === count) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`release notice missing: ${taskId}`);
}

await seed("young");
const young = await stopStartingTurn("young", 1);
assert.equal(young.strandedTurn, true);
assert.match(young.note, /本次停止等待结束时/);
assert.match(young.note, /当前不提供手动放开.*正常起跑/);
assert.doesNotMatch(young.note, /「放开回合占位」开关|手动解开/);
assert.equal((await noticesFromApi("young")).remedy, null);
assert.equal((await releaseSuspectTurn("young")).ok, false);
await stopStartingTurn("young", 1);
releaseTurn("young");
await waitForReleaseNotice("young");
const youngHistory = await noticesFromApi("young");
assert.ok(youngHistory.notices.some((entry) => /先前“仍被持有”的状态已结束/.test(entry.reason)));
assert.equal(youngHistory.remedy, null);

for (const role of ["duet", "dispatch", "handoff", "scm", "reconcile"]) {
  await seed(role, role);
  const stopped = await stopStartingTurn(role, 1);
  assert.equal(stopped.strandedTurn, true);
  assert.match(stopped.note, /正常就会长时间持有/);
  assert.doesNotMatch(stopped.note, /「放开回合占位」开关|用停止任务|手动解开/);
  assert.equal((await noticesFromApi(role)).remedy, null);
  const admission = await releaseSuspectTurn(role);
  assert.equal(admission.ok, false);
  if (!admission.ok) assert.doesNotMatch(admission.reason, /用停止任务/);
  releaseTurn(role);
  await waitForReleaseNotice(role);
}

await seed("token");
bindTurnToken("token", "current-token");
assert.match((await stopStartingTurn("token", 1)).note, /当前不提供手动放开.*回合令牌/);
releaseTurn("token");
await waitForReleaseNotice("token");

await seed("successor");
await stopStartingTurn("successor", 1);
const prior = heldTurns().find((entry) => entry.taskId === "successor")!;
releaseTurn("successor");
assert.equal(claimTurn("successor"), true);
await waitForReleaseNotice("successor");
assert.equal(isTurnClaimed("successor"), true);
assert.notEqual(heldTurns().find((entry) => entry.taskId === "successor")!.seq, prior.seq);
const resolved = (await noticesFromApi("successor")).notices.find((entry) => entry.action === "停止后的回合占位已释放")!;
assert.match(resolved.reason, /那次回合占位已经释放/);
assert.doesNotMatch(resolved.reason, /现在可以重新运行|已自行释放/);
await stopStartingTurn("successor", 1);
releaseTurn("successor");
await waitForReleaseNotice("successor", 2);

await seed("boundary");
const boundary = heldTurns().find((entry) => entry.taskId === "boundary")!;
for (const elapsed of [59_999, 60_000, 60_001]) {
  const at = boundary.claimedAt + elapsed;
  const status = turnReclaimStatus("boundary", at);
  assert.equal(status.kind === "eligible", elapsed > 60_000);
  assert.equal(suspectTurns(at).some((entry) => entry.taskId === "boundary"), status.kind === "eligible");
}
releaseTurn("boundary");
assert.equal(turnReclaimStatus("boundary").kind, "absent");
await seed("released-in-time");
setTimeout(() => releaseTurn("released-in-time"), 1);
assert.equal((await stopStartingTurn("released-in-time", 100)).strandedTurn, false);
assert.equal((await recentRejectionNotices("released-in-time")).length, 0);
await new Promise((resolve) => setImmediate(resolve));
dbClient.close();
rmSync(root, { recursive: true });
console.log("stop-turn observation regressions ok");
