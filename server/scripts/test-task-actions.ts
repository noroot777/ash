// 任务「此刻能做什么」:下发给前端的结论与路由的挡板**同源**(task-action-verdicts.ts、
// task-retry-turn.ts 的 retryTurnRejection,下发通道在 task-actions.ts)。
//
// 钉住的是两句话:
//  ① 下发说不能做 → 路由 409,原因一字不差;
//  ② 下发说能做 → 路由不会因为确定性的事实拒绝。这里先占住回合锁再按:请求一路走过全部
//     判据,停在「撞车」那一道(回合正在进行)—— 证明它没被判据挡,又不真把 agent 拉起来。
// 外加两条推送:任务自己换了状态、同队成员换了状态,打开着的那个任务都会收到重算后的结论
// (队列挡路是别人的状态,它自己的行一个字都不变)。
//
// 覆盖任务 G4J3ykMmJHgC 列出的几处对不上:验证轮没结束时归档、队列挡路时运行、接力出去的任务、
// 讨论排队中的停止、分组暂停时重跑上一回合、等答复时派验证。
// 跑:npm -w server run test:task-actions
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { ActionVerdict, ServerEvent, TaskActions } from "@ash/shared";
import { releaseTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "ash-task-actions-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");

const { ensureSchema, db } = await import("../src/db/index.js");
const { groups, projects, queueItems, sessions, tasks } = await import("../src/db/schema.js");
const { createTasks } = await import("../src/task-store.js");
const { claimTurn, releaseTurn } = await import("../src/runs.js");
const { setTaskStatus } = await import("../src/status.js");
const { bus } = await import("../src/bus.js");
const { mountTaskRunRoutes } = await import("../src/task-run-routes.js");
const { mountReviewRoutes } = await import("../src/review.js");
const { sessionTranscriptPath } = await import("../src/transcript.js");

await ensureSchema();
const stamp = new Date().toISOString();
await db.insert(projects).values({
  id: "p1", name: "task actions", repoPath: join(root, "repo"), apiKeys: null, workflowId: null, createdAt: stamp,
});

const baseTask = {
  projectId: "p1", groupId: null, parentId: null, body: "test", mode: "single", status: "done",
  labels: "[]", dependsOn: "[]", resumeDependsOn: "[]", agentType: "claude",
  executorId: null, model: null, reasoningEffort: null, autoTitle: false,
  duet: null, team: null, reportBack: false, scheduleId: null,
  createdAt: stamp, updatedAt: stamp,
  useWorktree: false, worktreeBase: null, originTaskId: null, workflowMode: "free",
};

const api = new Hono();
mountTaskRunRoutes(api);
mountReviewRoutes(api);

async function actionsOf(taskId: string): Promise<TaskActions> {
  const response = await api.request(`/tasks/${taskId}/actions`);
  assert.equal(response.status, 200, `取 ${taskId} 的可做动作`);
  return await response.json() as TaskActions;
}

async function post(path: string, body?: unknown): Promise<{ status: number; error?: string }> {
  const response = await api.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const json = await response.json().catch(() => ({})) as { error?: string };
  return { status: response.status, error: json.error };
}

/** ① 下发说不能做:路由 409,同一句话。 */
async function assertRefused(verdict: ActionVerdict | null | undefined, path: string, body?: unknown) {
  assert.ok(verdict && !verdict.ok, `${path}: 下发应当是「不能做」`);
  const result = await post(path, body);
  assert.equal(result.status, 409, `${path}: 路由挡回`);
  assert.equal(result.error, verdict.reason, `${path}: 挡回的原因与下发的一字不差`);
}

/** ② 下发说能做:占住回合再按,请求走过全部判据,只停在撞车那一道。 */
async function assertPassesVerdict(taskId: string, verdict: ActionVerdict | null | undefined, path: string, busy: RegExp, body?: unknown) {
  assert.ok(verdict?.ok, `${path}: 下发应当是「能做」`);
  assert.equal(claimTurn(taskId), true);
  try {
    const result = await post(path, body);
    assert.match(result.error ?? "", busy, `${path}: 只该撞上回合锁，实际是「${result.error}」`);
  } finally {
    releaseTurn(taskId);
  }
}

async function seedCrashedSession(taskId: string): Promise<string> {
  const sessionId = `s-${taskId}`;
  await db.insert(sessions).values({ id: sessionId, taskId, role: "single", agentType: "claude", executor: "claude",
    cwd: root, startedAt: stamp, turnStartedAt: stamp, endedAt: stamp, exitStatus: 1 });
  const path = sessionTranscriptPath(taskId, sessionId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `\x1e${JSON.stringify({ t: "user", agent: "claude", text: "改一下标题", at: stamp })}\nagent 刚开口就崩了\n`);
  return sessionId;
}

// ── 归档:就地验证轮没结束 ───────────────────────────────────────────────────
{
  await createTasks([{ ...baseTask, id: "arch-verify", title: "验证轮挂着", workflowMode: "preset", verifyRound: 2 }]);
  const actions = await actionsOf("arch-verify");
  assert.equal(actions.archive.ok, false);
  assert.ok(!actions.archive.ok && !actions.archive.hidden, "键照出、灰着说原因");
  await assertRefused(actions.archive, "/tasks/arch-verify/archive");

  await createTasks([{ ...baseTask, id: "arch-ok", title: "可以归档" }]);
  await assertPassesVerdict("arch-ok", (await actionsOf("arch-ok")).archive, "/tasks/arch-ok/archive", /回合正在进行/);
}

// ── 运行:队列挡路 / 放行 ─────────────────────────────────────────────────────
{
  await createTasks([
    { ...baseTask, id: "q-head", title: "排头", status: "failed" },
    { ...baseTask, id: "q-next", title: "排第二", status: "backlog" },
  ]);
  await db.update(tasks).set({ status: "backlog" }).where(eq(tasks.id, "q-head"));
  await db.insert(queueItems).values([
    { taskId: "q-head", queueId: "q1", position: 0, createdAt: stamp },
    { taskId: "q-next", queueId: "q1", position: 1, createdAt: stamp },
  ]);
  const next = await actionsOf("q-next");
  assert.equal(next.primary?.kind, "run");
  assert.ok(next.primary && !next.primary.ok && !next.primary.hidden, "队列挡路:运行灰着");
  assert.match(next.primary && !next.primary.ok ? next.primary.reason : "", /排头/, "原因点名挡路的那条");
  await assertRefused(next.primary, "/tasks/q-next/run");
  await assertPassesVerdict("q-head", (await actionsOf("q-head")).primary, "/tasks/q-head/run", /回合正在进行/);

  // 推送:排头完成 → 排第二的那条收到重算后的结论,运行变得可点(它自己的行一个字没变)。
  const seen: TaskActions[] = [];
  const unsubscribe = bus.subscribe((event: ServerEvent) => {
    if (event.type === "task.actions" && event.taskId === "q-next") seen.push(event.actions);
  });
  await setTaskStatus("q-head", "done");
  for (let i = 0; i < 100 && !seen.some((a) => a.primary?.ok); i++) await new Promise((r) => setTimeout(r, 10));
  unsubscribe();
  const pushed = seen.at(-1);
  assert.ok(pushed?.primary?.ok, "同队成员完成后，打开着的任务收到「现在可以运行」");
  assert.ok(pushed.seq > next.seq, "推送的序号比先前取到的大，前端据此丢旧的");
}

// ── 重试:失败的任务被队列挡住 ───────────────────────────────────────────────
{
  await createTasks([
    { ...baseTask, id: "r-run", title: "正在跑", status: "running" },
    { ...baseTask, id: "r-failed", title: "失败的", status: "failed" },
  ]);
  await db.insert(queueItems).values([
    { taskId: "r-run", queueId: "q2", position: 0, createdAt: stamp },
    { taskId: "r-failed", queueId: "q2", position: 1, createdAt: stamp },
  ]);
  const failed = await actionsOf("r-failed");
  assert.equal(failed.primary?.kind, "retry");
  await assertRefused(failed.primary, "/tasks/r-failed/retry");
  // 同队有人在跑,重新排队照样能做(它不起跑,只回队列等):放行后真的落回 backlog,队列不会因此拉起它。
  assert.ok(failed.requeue.ok, "队列里失败的任务可以重新排队");
  const requeued = await post("/tasks/r-failed/requeue");
  assert.equal(requeued.status, 200, `重新排队放行，实际 ${requeued.status} ${requeued.error ?? ""}`);
  assert.equal((await db.select().from(tasks).where(eq(tasks.id, "r-failed"))).at(0)?.status, "backlog");
}

// ── 重新排队:不在队列里 → 不出键,路由同一句话 ──────────────────────────────
{
  await createTasks([{ ...baseTask, id: "rq-solo", title: "独立任务", status: "failed" }]);
  const actions = await actionsOf("rq-solo");
  assert.ok(!actions.requeue.ok && actions.requeue.hidden, "不在队列里就不出重新排队");
  await assertRefused(actions.requeue, "/tasks/rq-solo/requeue");
}

// ── 接力出去的任务:运行不出,路由同一句话 ────────────────────────────────────
{
  await createTasks([{ ...baseTask, id: "handed", title: "接力出去", status: "backlog",
    handoff: JSON.stringify({ direction: "out", peerName: "另一台" }) }]);
  const actions = await actionsOf("handed");
  assert.ok(actions.primary && !actions.primary.ok && actions.primary.hidden, "接力出去的任务不出运行");
  await assertRefused(actions.primary, "/tasks/handed/run");
}

// ── 等答复时:运行 / 继续不出(答复卡才是入口),路由同一句话 ─────────────────
{
  await createTasks([{ ...baseTask, id: "asking", title: "等答复", status: "paused", question: "选哪个？" }]);
  const actions = await actionsOf("asking");
  assert.equal(actions.primary?.kind, "resume");
  assert.ok(actions.primary && !actions.primary.ok && actions.primary.hidden);
  await assertRefused(actions.primary, "/tasks/asking/run");
  // 派验证同理:等答复的任务派不动,灰着说原因。
  assert.ok(!actions.verify.ok && !actions.verify.hidden);
  await assertRefused(actions.verify, "/tasks/asking/review/dispatch");
}

// ── 停止:讨论排队中能停;已完成的没东西可停 ──────────────────────────────────
{
  await createTasks([
    { ...baseTask, id: "duet-queued", title: "讨论排队中", mode: "duet", status: "queued",
      duet: JSON.stringify({ topic: "议题", voiceA: "claude", voiceB: "codex" }) },
    { ...baseTask, id: "stop-done", title: "已完成" },
  ]);
  assert.ok((await actionsOf("duet-queued")).stop.ok, "排队中的讨论有停止");
  const stopped = await post("/tasks/duet-queued/stop");
  assert.equal(stopped.status, 200, `停止放行，实际 ${stopped.status} ${stopped.error ?? ""}`);
  const done = await actionsOf("stop-done");
  assert.ok(!done.stop.ok && done.stop.hidden, "已完成的任务不出停止");
  await assertRefused(done.stop, "/tasks/stop-done/stop");
}

// ── 重跑上一回合:分组暂停 → 灰着;恢复后可做 ──────────────────────────────────
{
  await db.insert(groups).values({ id: "g-paused", projectId: "p1", name: "暂停组", mode: "serial", paused: true, createdAt: stamp });
  await createTasks([{ ...baseTask, id: "crashed", title: "续聊崩了", groupId: "g-paused" }]);
  const sessionId = await seedCrashedSession("crashed");
  const paused = await actionsOf("crashed");
  assert.equal(paused.retryTurn?.kind, "turn");
  assert.ok(paused.retryTurn && !paused.retryTurn.ok && !paused.retryTurn.hidden, "分组暂停:键在、灰着");
  await assertRefused(paused.retryTurn, "/tasks/crashed/retry-turn", { sessionId });
  await db.update(groups).set({ paused: false }).where(eq(groups.id, "g-paused"));
  const resumed = await actionsOf("crashed");
  assert.equal(resumed.retryTurn?.kind === "turn" ? resumed.retryTurn.sessionId : null, sessionId);
  await assertPassesVerdict("crashed", resumed.retryTurn, "/tasks/crashed/retry-turn", /回合正在进行/, { sessionId });
  // 一回合都没崩过的已完成任务没有这颗键。
  assert.equal((await actionsOf("arch-ok")).retryTurn, null);
}

// ── 派验证:放行时只撞回合锁 ─────────────────────────────────────────────────
{
  await createTasks([{ ...baseTask, id: "verify-ok", title: "可以验", workflowMode: "preset" }]);
  await assertPassesVerdict("verify-ok", (await actionsOf("verify-ok")).verify, "/tasks/verify-ok/review/dispatch", /回合正在进行/);
}

// ── 团队执行者:归档跟着团队走,不出键,路由同一句话 ───────────────────────────
{
  await createTasks([{ ...baseTask, id: "team-lead", title: "团队", mode: "team", status: "idle",
    team: JSON.stringify({ lead: "claude", worker: "claude" }) }]);
  await createTasks([{ ...baseTask, id: "worker", title: "执行者", parentId: "team-lead" }]);
  const worker = await actionsOf("worker");
  assert.ok(!worker.archive.ok && worker.archive.hidden);
  await assertRefused(worker.archive, "/tasks/worker/archive");
  // 起过的团队没有「运行」那一步(停 / 续是团队外壳自己的停止全组 / 恢复全组)。
  assert.equal((await actionsOf("team-lead")).primary, null);
}

await releaseTmpDb();
console.log("✓ task actions: 下发结论与路由挡板同源，推送随事实重算");
process.exit(0);
