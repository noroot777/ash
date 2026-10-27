// 唤醒链路三缺陷的回归（任务 hprbvyaE6SDy）。2026-10-26 现场（任务 z2lq7MAWeKx7，哨兵
// IuniSx_yTlAh / 消息 7Sc_gCjZddiw）:
// 一把无主的回合锁把任务钉在 queued,排队消息于是永远判「等它空下来」,在托盘里躺了
// 70+ 分钟而日志一声不吭;stop_task 救不回来(它只杀进程),/run 一律 409,全仓当时
// 没有任何入口能解,唯一解法是重启整个 server。
//
// 覆盖三条:
//   ① 幽灵锁的判定与回收(turn-lock-reclaim):三条判据缺一不可、预占角色豁免、
//      回收时放走被它冻住的交接、HTTP 救援入口、巡检计数;
//   ② 队列占位不再因「释放那一瞬锁被占着」而永久放弃(queue-seat / scheduler):
//      改成排到锁释放之后再看一眼 —— 这是把任务钉在 queued 的那一环;
//   ③ 被挡回的用户操作留下持久可见的痕迹(user-action-rejection)+ 久久发不出去的
//      待发送消息会出声(pending-delivery-timing)。
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";

const root = mkdtempSync(join(tmpdir(), "ash-turn-reclaim-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
// 把回收窗口压到毫秒级,好让 HTTP 救援那条真实路径也测得动(见 STALE_TURN_MS)。
process.env.ASH_STALE_TURN_MS = "20";

const { ensureSchema, db, dbClient } = await import("../src/db/index.js");
const { projects, sessions, tasks, queueItems, scheduledMessages } = await import("../src/db/schema.js");
const { createTasks } = await import("../src/task-store.js");
const {
  bindTurnToken, claimReconcileTurn, claimTurn, claimWorkspaceTurn, isTurnClaimed, releaseTurn,
  trackRun, untrackRun, whenTurnIdle,
} = await import("../src/runs.js");
const { STALE_TURN_MS, reclaimStaleTurn, staleTurns, sweepStaleTurns } = await import("../src/turn-lock-reclaim.js");
const { claimQueueSeat } = await import("../src/queue-seat.js");
const { reclaimStrandedSeat } = await import("../src/scheduler.js");
const { noteRejectedUserAction } = await import("../src/user-action-rejection.js");
const { noteStalledPending } = await import("../src/pending-delivery-timing.js");
const { setTaskStatus } = await import("../src/status.js");
const { beginAccepting, endAccepting } = await import("../src/acceptance-lock.js");
const { mountTaskRunRoutes } = await import("../src/task-run-routes.js");
const { sessionTranscriptPath } = await import("../src/transcript.js");

await ensureSchema();
const stamp = new Date().toISOString();
await db.insert(projects).values({
  id: "p1", name: "turn reclaim", repoPath: join(root, "repo"), apiKeys: null, workflowId: null, createdAt: stamp,
});

const baseTask = {
  projectId: "p1", groupId: null, parentId: null, body: "test", mode: "single", status: "done",
  labels: "[]", dependsOn: "[]", resumeDependsOn: "[]", agentType: "codex",
  executorId: null, model: null, reasoningEffort: null, autoTitle: false,
  duet: null, team: null, reportBack: false, scheduleId: null,
  createdAt: stamp, updatedAt: stamp,
  useWorktree: false, worktreeBase: null, originTaskId: null, workflowMode: "free",
};

const api = new Hono();
mountTaskRunRoutes(api);
const post = (path: string, body?: unknown) =>
  api.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });

/** 给任务造一条会话行 —— appendTaskTimeline 只往已有会话里写,没有会话的任务只留日志。 */
async function seedSession(taskId: string, id = `s-${taskId}`): Promise<string> {
  await db.insert(sessions).values({
    id, taskId, agentType: "codex", role: "single", executor: "codex", cwd: root,
    commandLine: "", startedAt: new Date().toISOString(), endedAt: null, cliSessionId: null,
  });
  return id;
}
// 直接读那份 transcript:要验的就是「落到磁盘上、刷新页面后还在」这件事。
const timelineOf = async (taskId: string, sessionId: string): Promise<string> => {
  try { return await readFile(sessionTranscriptPath(taskId, sessionId), "utf8"); }
  catch { return ""; }
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const past = () => Date.now() + STALE_TURN_MS * 100; // 「已经过了很久」的观察时刻

// ── ① 三条判据缺一不可 ───────────────────────────────────────────────────────
// 瞬时快照分不出幽灵和「正常起跑中」,所以判据是 (超时 ∧ 无句柄 ∧ 无令牌)。任一否证成立
// 就说明这把锁有主,**绝不能拔** —— 拔掉一把正在起跑的锁就是同一个任务起两个回合。
await createTasks([
  { ...baseTask, id: "t-ghost", title: "ghost lock" },
  { ...baseTask, id: "t-token", title: "has token" },
  { ...baseTask, id: "t-handle", title: "has handle" },
  { ...baseTask, id: "t-fresh", title: "just claimed" },
]);

assert.equal(claimTurn("t-ghost"), true);
assert.equal(claimTurn("t-token"), true);
assert.equal(claimTurn("t-handle"), true);
assert.equal(claimTurn("t-fresh"), true);

// 有令牌 = 这一轮已经落过库,结算路径认得它
bindTurnToken("t-token", "tok-1");
// 有句柄 = 真有 CLI 在跑,它的消费循环会在 finally 里还锁
const liveHandle = { kill: () => {} };
trackRun("t-handle", liveHandle);

{
  const stale = staleTurns(past()).map((t) => t.taskId);
  assert.ok(stale.includes("t-ghost"), "无句柄、无令牌、已超时的锁必须判为幽灵");
  assert.ok(!stale.includes("t-token"), "绑过回合令牌的锁有主,不许回收");
  assert.ok(!stale.includes("t-handle"), "进程登记册里有句柄的锁有主,不许回收");
}
// 未超时:同一把 t-ghost 在「现在」这个观察时刻不该命中
assert.equal(staleTurns(Date.now()).some((t) => t.taskId === "t-fresh"), false,
  "刚占下的锁不许回收 —— 正常起跑从 claim 到绑令牌有一段真实窗口");

// ── ② 预占角色的豁免 ─────────────────────────────────────────────────────────
// scm / handoff / reconcile 天生长时间「无句柄无令牌」(大仓库 git、打包整个 worktree),
// 各自都包在明确的 try/finally 里,纳入就会被误判。lead-wake 与 dispatch 相反:它们
// 正常只活几毫秒到几秒,一旦泄漏症状与幽灵锁完全一致,所以**必须**纳入。
await createTasks([
  { ...baseTask, id: "t-scm", title: "scm" },
  { ...baseTask, id: "t-handoff", title: "handoff" },
  { ...baseTask, id: "t-reconcile", title: "reconcile" },
  { ...baseTask, id: "t-dispatch", title: "dispatch" },
]);
const releaseScm = claimWorkspaceTurn(["t-scm"]);
assert.ok(releaseScm, "SCM 预占应占到锁");
assert.equal(claimTurn("t-handoff", "handoff"), true);
const releaseReconcile = claimReconcileTurn("t-reconcile");
assert.ok(releaseReconcile, "残留结算预占应占到锁");
assert.equal(claimTurn("t-dispatch", "dispatch"), true);
{
  const stale = staleTurns(past()).map((t) => t.taskId);
  for (const exempt of ["t-scm", "t-handoff", "t-reconcile"]) {
    assert.ok(!stale.includes(exempt), `${exempt} 是带 finally 的预占,不许被当幽灵回收`);
  }
  assert.ok(stale.includes("t-dispatch"), "派审占位泄漏的症状与幽灵锁一致,必须纳入回收");
}
releaseScm!();
releaseReconcile!();
releaseTurn("t-handoff");
releaseTurn("t-dispatch");

// ── ③ 回收:拔锁 + 放走被它冻住的交接 + 留痕 ─────────────────────────────────
// 幽灵锁底下往往正压着一串「等这一轮跑完再送」的交接(排队消息投递、队列补推) ——
// 它们跟着这把锁一起被冻住了,拔锁而不放它们走,任务照旧停在原地。
const ghostSession = await seedSession("t-ghost");
let thawed = 0;
whenTurnIdle("t-ghost", () => { thawed += 1; });
assert.equal(thawed, 0, "锁还占着时,交接必须排在队里等");
{
  const stale = staleTurns(past()).find((t) => t.taskId === "t-ghost");
  assert.ok(stale, "t-ghost 应被判为幽灵");
  assert.equal(await reclaimStaleTurn(stale!, "巡检"), true, "回收应成功");
}
assert.equal(isTurnClaimed("t-ghost"), false, "回收之后锁必须真的放开");
assert.equal(thawed, 1, "被幽灵锁冻住的交接必须随回收一起放走");
assert.equal(claimTurn("t-ghost"), true, "放开之后新回合必须能正常占到锁");
releaseTurn("t-ghost");
{
  // 持久可见:只打日志不算数,用户刷新页面后仍要能看出这里卡过一次。
  const timeline = await timelineOf("t-ghost", ghostSession);
  assert.match(timeline, /回合占位已被巡检回收/, "回收必须往任务时间线写一条");
  assert.match(timeline, /任务回合正在进行/, "痕迹里要说清卡住时用户看到的是什么");
}

// 判定之后原持有者自己还了锁:再拔一次必须是 no-op,不许误报成功
assert.equal(await reclaimStaleTurn({ taskId: "t-ghost", role: "single", heldMs: 1 }, "人工"), false,
  "锁已经不在了,回收应如实返回 false");

// 巡检计数
assert.equal(claimTurn("t-token"), false, "t-token 的锁还占着(它有令牌,不该被回收)");
releaseTurn("t-token");
untrackRun("t-handle", liveHandle);
releaseTurn("t-handle");
releaseTurn("t-fresh");
{
  await createTasks([{ ...baseTask, id: "t-sweep", title: "sweep" }]);
  await seedSession("t-sweep");
  assert.equal(claimTurn("t-sweep"), true);
  await sleep(STALE_TURN_MS * 3);
  assert.equal(await sweepStaleTurns(), 1, "巡检应回收掉这一把");
  assert.equal(isTurnClaimed("t-sweep"), false);
  assert.equal(await sweepStaleTurns(), 0, "没有幽灵锁时巡检不该做事");
}

// ── ④ HTTP 救援入口 ─────────────────────────────────────────────────────────
// 2026-10-26 现场:全仓没有任何入口能释放这把锁。判据不因为「用户点了」就放宽。
await createTasks([{ ...baseTask, id: "t-http", title: "http rescue" }]);
await seedSession("t-http");
{
  const idle = await post("/tasks/t-http/reclaim-turn");
  assert.equal(idle.status, 409, "没有锁被占着时应 409");
  assert.match((await idle.json() as { error: string }).error, /没有被占着的回合占位/);
}
assert.equal(claimTurn("t-http"), true);
{
  const tooEarly = await post("/tasks/t-http/reclaim-turn");
  assert.equal(tooEarly.status, 409, "刚占下还不到阈值,不许强行回收");
  assert.match((await tooEarly.json() as { error: string }).error, /仍有主/);
}
await sleep(STALE_TURN_MS * 3);
{
  const rescued = await post("/tasks/t-http/reclaim-turn");
  assert.equal(rescued.status, 200, "满足判据时人工回收应成功");
  assert.equal((await rescued.json() as { reclaimed: boolean }).reclaimed, true);
}
assert.equal(isTurnClaimed("t-http"), false, "人工回收后锁必须放开");
assert.equal((await post("/tasks/t-http/reclaim-turn")).status, 409, "回收过了再点应如实 409");

// ── ⑤ 队列占位不再永久放弃 ───────────────────────────────────────────────────
// 旧版 seat.release() / reclaimStrandedSeat 都以 `if (isTurnClaimed) return` 开头,于是
// 释放那一瞬恰好有人占着锁(哪怕只是 PATCH status 那种几毫秒的预占,更别说一把幽灵锁),
// 这具 queued 占位就永远没人回滚 —— 任务永久「排队中」,投递判定永远是「等它空下来」。
// 占位前的状态刻意用 failed / done:队列推进会**真的 spawn CLI**(烧真额度),而 failed 被
// 透明跳过、done 已完成,回滚之后 selectNextInQueue 挑不出人,这条链路就测得干净。
// 回滚本身与目标状态无关 —— 它只问「还停在 queued 吗」。
await createTasks([
  { ...baseTask, id: "t-seat", title: "seat rollback", status: "failed" },
  { ...baseTask, id: "t-strand", title: "stranded seat", status: "done" },
]);
await db.insert(queueItems).values([
  { queueId: "q1", taskId: "t-seat", position: 0, createdAt: stamp },
  { queueId: "q1", taskId: "t-strand", position: 1, createdAt: stamp },
]);
{
  const claim = await claimQueueSeat("t-seat");
  assert.ok(claim.ok && claim.seat, "空闲队列应认领到执行占位");
  assert.equal((await db.select().from(tasks).where(eq(tasks.id, "t-seat"))).at(0)?.status, "queued",
    "认领到占位 = 任务立刻是 queued");
  // 释放的那一刻锁被别人占着(真实来源:PATCH status 的 "status" 预占、或一把幽灵锁)
  assert.equal(claimTurn("t-seat", "status"), true);
  await claim.seat!.release();
  assert.equal((await db.select().from(tasks).where(eq(tasks.id, "t-seat"))).at(0)?.status, "queued",
    "锁被人占着时不许当场回滚 —— 那可能是别人正拿着这个占位起跑");
  // 锁一释放,排在后面的那一眼就该发生
  releaseTurn("t-seat");
  await sleep(30);
  assert.equal((await db.select().from(tasks).where(eq(tasks.id, "t-seat"))).at(0)?.status, "failed",
    "锁释放之后必须把没人接手的 queued 占位回滚掉,不能永久停在「排队中」");
}
{
  // reclaimStrandedSeat 同款:锁被占着时排到释放之后,而不是直接放弃
  await setTaskStatus("t-strand", "queued");
  assert.equal(claimTurn("t-strand", "status"), true);
  await reclaimStrandedSeat("t-strand", "q1", "done");
  assert.equal((await db.select().from(tasks).where(eq(tasks.id, "t-strand"))).at(0)?.status, "queued",
    "锁被占着时不动");
  releaseTurn("t-strand");
  await sleep(30);
  assert.equal((await db.select().from(tasks).where(eq(tasks.id, "t-strand"))).at(0)?.status, "done",
    "锁释放之后遗留占位必须被收拾");
}

// ── ⑥ 被挡回的用户操作留下持久可见的痕迹 ─────────────────────────────────────
// 只弹一次 toast 的话,刷新页面之后用户看不出「点过、没成、为什么」—— 2026-10-26 他
// 因此两次误判(以为按钮坏了 / 以为任务已经跑完)。
await createTasks([{ ...baseTask, id: "t-note", title: "rejection note" }]);
const noteSession = await seedSession("t-note");
{
  assert.equal(await noteRejectedUserAction("t-note", "派审查", "任务正等待答复或续跑，处理后再派审"), true);
  const timeline = await timelineOf("t-note", noteSession);
  assert.match(timeline, /你点的「派审查」这一次没有执行/, "被挡回的操作必须写进任务时间线");
  assert.match(timeline, /任务正等待答复或续跑/, "痕迹里必须带上挡回的理由");
  // 去重:按钮没反应时用户会连点,一次一条会把时间线刷满、把真正的进展埋掉
  assert.equal(await noteRejectedUserAction("t-note", "派审查", "任务正等待答复或续跑，处理后再派审"), false,
    "同一条挡回在去重窗口内只记一次");
  assert.equal(await noteRejectedUserAction("t-note", "派审查", "任务回合正在进行，结束后再派审"), true,
    "换了理由就是新事实,照记");
}
{
  // 路由层:验收锁下点运行 409,痕迹要落在时间线上
  // status 必须是**可运行**的那一档:done 任务会先被「当前状态不可运行」挡掉,而那一类
  // 挡板刻意不留痕(用户在界面上一眼就能看出任务已经完成)。
  await createTasks([{ ...baseTask, id: "t-run409", title: "run rejected", status: "failed" }]);
  const runSession = await seedSession("t-run409");
  assert.equal(beginAccepting("t-run409"), true);
  const res = await post("/tasks/t-run409/run");
  assert.equal(res.status, 409);
  endAccepting("t-run409");
  assert.match(await timelineOf("t-run409", runSession), /你点的「运行」这一次没有执行.*验收/s,
    "/run 的状态性 409 必须留下持久可见的痕迹");
  assert.equal(isTurnClaimed("t-run409"), false, "挡回不许留下占着的回合锁");
}

// ── ⑦ 久久发不出去的待发送消息会出声 ────────────────────────────────────────
// 上面那套分段计时只在**送成之后**结算,所以「一直没送成」正好落在它的盲区里:现场那条
// 消息躺了 70+ 分钟,日志从头到尾一声不吭。
await createTasks([{ ...baseTask, id: "t-stall", title: "stalled message" }]);
const stallSession = await seedSession("t-stall");
{
  const longAgo = new Date(Date.now() - 45 * 60_000).toISOString();
  const soon = new Date(Date.now() + 60 * 60_000).toISOString();
  const row = {
    id: "m-stall", taskId: "t-stall", text: "继续", mode: "queued", status: "pending",
    // queued 模式的 sendAt 只是入队时刻（排先后用），滞留起点按 createdAt 算
    sendAt: longAgo, createdAt: longAgo, sentAt: null, deliveringSince: null,
    attachments: "[]", agent: null, executorId: null, model: null, reasoningEffort: null,
    origin: null, execution: false, sessionRole: null,
  };
  await db.insert(scheduledMessages).values(row as never);
  noteStalledPending(row, "任务停在「排队中」，但队列里没有别的任务在跑");
  await sleep(40); // 时间线是 fire-and-forget 写的
  const timeline = await timelineOf("t-stall", stallSession);
  assert.match(timeline, /还没发出去/, "久久发不出去的消息必须留下持久可见的说明");
  assert.match(timeline, /排队中/, "说明里要带上「在等什么」");
  assert.match(timeline, /不会丢/, "必须告诉用户原话还在托盘里");

  // 定时消息按 sendAt 起算:排在一小时后的那条「还没发出去」是本意,不是卡住
  const future = { ...row, id: "m-future", mode: "timed", sendAt: soon };
  await db.insert(scheduledMessages).values(future as never);
  noteStalledPending(future, "还没到发送时间");
  await sleep(40);
  assert.doesNotMatch(await timelineOf("t-stall", stallSession), /还没到发送时间/,
    "定时消息在 sendAt 之前不算滞留,不该报警");
}

console.log("turn-reclaim regressions ok");
dbClient.close();
process.exit(0);
