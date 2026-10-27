// 唤醒链路三缺陷的回归（任务 hprbvyaE6SDy）。2026-10-26 现场（任务 z2lq7MAWeKx7，哨兵
// IuniSx_yTlAh / 消息 7Sc_gCjZddiw）:
// 一把占着不动的回合锁把任务钉在 queued,排队消息于是永远判「等它空下来」,在托盘里躺了
// 70+ 分钟而日志一声不吭;stop_task 救不回来(它只杀进程),/run 一律 409,全仓当时
// 没有任何入口能解,唯一解法是重启整个 server。
//
// 覆盖:
//   ① 可疑判定(turn-lock-reclaim):三条判据缺一不可、等待无上界的角色不进判据;
//   ② **巡检只报告、绝不自动放开** —— duet 在人工裁决门上持锁数小时,三条判据全中而
//      持有者活着,自动回收会解除互斥造出双跑(本轮审查 F1);
//   ③ **条件释放** —— 快照带不可复用的占用身份,换了主人就一个字节都不动(F2);
//   ④ HTTP 放开入口:判据不因为是人点的就放宽,成功时明示副作用;
//   ⑤ 队列占位:不再因「释放那一瞬锁被占着」而永久放弃,**且延期回滚只撤自己那一代**
//      (F3:endTurn 按注册顺序跑回调,排在前面的合法回调已抢到新锁,旧回滚照样写);
//   ⑥ 被挡回的用户操作留下持久可见的痕迹,**包括从没跑过、没有会话可写的任务**(F4);
//   ⑦ 久久发不出去的待发送消息会出声(pending-delivery-timing)。
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
// 把判据窗口压到毫秒级,好让 HTTP 放开那条真实路径也测得动(见 SUSPECT_TURN_MS)。
process.env.ASH_SUSPECT_TURN_MS = "20";

const { ensureSchema, db, dbClient } = await import("../src/db/index.js");
const { projects, sessions, tasks, taskNotices, queueItems, scheduledMessages } = await import("../src/db/schema.js");
const { createTasks } = await import("../src/task-store.js");
const {
  bindTurnToken, claimReconcileTurn, claimTurn, claimWorkspaceTurn, isTurnClaimed, releaseTurn,
  trackRun, untrackRun, whenTurnIdle,
} = await import("../src/runs.js");
const { forceReleaseTurn } = await import("../src/turn-lock.js");
const { SUSPECT_TURN_MS, releaseSuspectTurn, reportSuspectTurns, suspectTurns } =
  await import("../src/turn-lock-reclaim.js");
const { claimQueueSeat, seatGeneration } = await import("../src/queue-seat.js");
const { reclaimStrandedSeat } = await import("../src/scheduler.js");
const { noteRejectedUserAction, noteSystemNotice, recentRejectionNotices } = await import("../src/user-action-rejection.js");
const { forgetStalled, noteStalledPending } = await import("../src/pending-delivery-timing.js");
const { setTaskStatus } = await import("../src/status.js");
const { beginAccepting, endAccepting } = await import("../src/acceptance-lock.js");
const { mountTaskRunRoutes } = await import("../src/task-run-routes.js");
const { mountTaskRoutes } = await import("../src/task-routes.js");
const { sessionTranscriptPath } = await import("../src/transcript.js");
const { takeFreeze } = await import("../src/turn-freeze.js");

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
mountTaskRoutes(api);
const post = (path: string, body?: unknown) =>
  api.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? (path.endsWith("/reclaim-turn") ? { acknowledgeDuplicateRisk: true } : {})),
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
const past = () => Date.now() + SUSPECT_TURN_MS * 100; // 「已经过了很久」的观察时刻

async function failNextNoticeWrite(run: () => Promise<unknown>): Promise<void> {
  const execute = dbClient.execute.bind(dbClient);
  let injected = false;
  dbClient.execute = ((statement: Parameters<typeof execute>[0]) => {
    const sql = String(typeof statement === "string" ? statement : statement.sql);
    if (!injected && /^\s*insert\s+into\s+"task_notices"/i.test(sql)) {
      injected = true;
      return Promise.reject(new Error("injected notice write failure"));
    }
    return execute(statement);
  }) as typeof dbClient.execute;
  try {
    await run();
    assert.equal(injected, true, "测试必须真的命中一次通知写失败");
  } finally {
    dbClient.execute = execute;
  }
}

// ── ① 三条判据缺一不可 ───────────────────────────────────────────────────────
// 瞬时快照分不出「卡住了」和「正常起跑中」,所以判据是 (超时 ∧ 无句柄 ∧ 无令牌)。任一否证
// 成立就说明这把锁有主,**连报都不该报** —— 它后面那一步(人工放开)拔掉一把正在起跑的锁
// 就是同一个任务起两个回合。
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
  const stale = suspectTurns(past()).map((t) => t.taskId);
  assert.ok(stale.includes("t-ghost"), "无句柄、无令牌、已超时的锁必须判为可疑");
  assert.ok(!stale.includes("t-token"), "绑过回合令牌的锁有主,不许报可疑");
  assert.ok(!stale.includes("t-handle"), "进程登记册里有句柄的锁有主,不许报可疑");
}
// 未超时:同一把 t-ghost 在「现在」这个观察时刻不该命中
assert.equal(suspectTurns(Date.now()).some((t) => t.taskId === "t-fresh"), false,
  "刚占下的锁不许报可疑 —— 正常起跑从 claim 到绑令牌有一段真实窗口");

// ── ② 等待无上界的角色不进判据 ────────────────────────────────────────────────
// 有一整类持有者的等待本来就没有时长上界:duet 等用户点裁决门可以几小时,dispatch 要等
// withRepoLock 再建 worktree,handoff 要打包整个 worktree 传给对端,scm 在跑大仓库的 git。
// 对它们「占了多久」不携带任何信息,报出来纯是噪音。短命的预占(status / lead-wake / team)
// 相反:它们正常只活几毫秒,占久了确实可疑,所以纳入。
await createTasks([
  { ...baseTask, id: "t-scm", title: "scm" },
  { ...baseTask, id: "t-handoff", title: "handoff" },
  { ...baseTask, id: "t-reconcile", title: "reconcile" },
  { ...baseTask, id: "t-dispatch", title: "dispatch" },
  { ...baseTask, id: "t-status", title: "status preclaim" },
]);
const releaseScm = claimWorkspaceTurn(["t-scm"]);
assert.ok(releaseScm, "SCM 预占应占到锁");
assert.equal(claimTurn("t-handoff", "handoff"), true);
const releaseReconcile = claimReconcileTurn("t-reconcile");
assert.ok(releaseReconcile, "残留结算预占应占到锁");
assert.equal(claimTurn("t-dispatch", "dispatch"), true);
assert.equal(claimTurn("t-status", "status"), true);
{
  const suspect = suspectTurns(past()).map((t) => t.taskId);
  for (const exempt of ["t-scm", "t-handoff", "t-reconcile", "t-dispatch"]) {
    assert.ok(!suspect.includes(exempt), `${exempt} 的等待没有时长上界,年龄对它不携带信息`);
  }
  assert.ok(suspect.includes("t-status"), "短命预占占久了确实可疑,必须报出来");
}
releaseScm!();
releaseReconcile!();
releaseTurn("t-handoff");
releaseTurn("t-dispatch");
releaseTurn("t-status");

// ── ③ 巡检只报告,一把锁都不碰 ────────────────────────────────────────────────
// **这一条是本轮审查 F1 的回归。** 前一版巡检自动回收,而三条判据证不了持有者已经死了:
// duet 在 `waitForGate` 上等用户点裁决,全程不绑令牌、子进程也不在册 —— 判据全中,持有者
// 却活着。自动拔锁 = 解除互斥,同一个任务两个回合并跑,烧真额度、对着同一个工作区互相改,
// 比原缺陷(任务卡住)严重得多。
await createTasks([
  { ...baseTask, id: "t-duet", title: "duet gate", mode: "duet" },
  { ...baseTask, id: "t-report", title: "reported only" },
  { ...baseTask, id: "t-report-empty", title: "never ran", status: "queued" },
]);
await seedSession("t-report");
assert.equal(claimTurn("t-duet", "duet"), true, "duet 占住它自己这把锁");
assert.equal(claimTurn("t-report"), true);
assert.equal(claimTurn("t-report-empty"), true);
await sleep(SUSPECT_TURN_MS * 3);
{
  const suspect = suspectTurns(past()).map((t) => t.taskId);
  assert.ok(!suspect.includes("t-duet"), "duet 的等待没有上界,不该被判为可疑");
  assert.ok(suspect.includes("t-report"), "t-report 该被判为可疑");
  assert.ok(await reportSuspectTurns() > 0, "可疑的占位要被报出来");
  // 关键断言:报过之后两把锁都必须**还在**
  assert.equal(isTurnClaimed("t-duet"), true, "巡检绝不许碰 duet 的锁 —— 它的持有者还活着");
  assert.equal(isTurnClaimed("t-report"), true, "巡检只报告,连可疑的那把也不许自动放开");
  for (const taskId of ["t-report", "t-report-empty"]) {
    const response = await api.request(`/tasks/${taskId}/notices`);
    assert.equal(response.status, 200);
    const { notices } = await response.json() as { notices: { outcome: string; reason: string }[] };
    assert.equal(notices.length, 1, "有无会话都应从通知接口读回一条诊断");
    assert.equal(notices[0]!.outcome, "system");
    assert.match(notices[0]!.reason, /回合占位占着不动/);
    assert.match(notices[0]!.reason, /不会自动放开/);
    assert.match(notices[0]!.reason, /reclaim-turn/);
  }
  assert.equal(await timelineOf("t-report", "s-t-report"), "", "诊断不应再写一份会话正文");
  // 同一把锁不许每 30 秒报一次
  assert.equal(await reportSuspectTurns(), 0, "同一次占用只报一次");
}
releaseTurn("t-duet");
releaseTurn("t-report-empty");
assert.equal(claimTurn("t-report-empty"), true);
await sleep(SUSPECT_TURN_MS * 3);
assert.equal(await reportSuspectTurns(), 1, "换了一把锁应形成一条新诊断");
assert.equal((await recentRejectionNotices("t-report-empty")).length, 2);
releaseTurn("t-report-empty");
await createTasks([{ ...baseTask, id: "t-report-retry", title: "write retry", status: "queued" }]);
assert.equal(claimTurn("t-report-retry"), true);
await sleep(SUSPECT_TURN_MS * 3);
await failNextNoticeWrite(async () => {
  assert.equal(await reportSuspectTurns(), 0, "写失败不能冒报已持久化");
});
assert.equal((await recentRejectionNotices("t-report-retry")).length, 0);
assert.equal((await Promise.all([reportSuspectTurns(), reportSuspectTurns()])).reduce((sum, count) => sum + count), 1);
assert.equal((await recentRejectionNotices("t-report-retry")).length, 1, "失败后重试且并发扫描不能重复写");
releaseTurn("t-report-retry");

// ── ④ 条件释放:换了主人就一个字节都不动 ──────────────────────────────────────
// **本轮审查 F2 的回归。** 判定要读进程登记册、写时间线,中间全是 await;按任务 id 删锁
// 的写法在那段间隙里认不出锁已经换了主人,拔的就是后来者那把。
{
  const snapshot = suspectTurns(past()).find((t) => t.taskId === "t-report");
  assert.ok(snapshot, "t-report 此刻应判为可疑");
  releaseTurn("t-report");                       // 原持有者自己还了锁
  assert.equal(claimTurn("t-report", "single"), true, "一个正常回合随即占上");
  assert.equal(forceReleaseTurn(snapshot!), null, "快照的号码对不上,条件释放必须什么都不做");
  assert.equal(isTurnClaimed("t-report"), true, "后来者那把锁必须完好 —— 拔掉它就是双跑");
  releaseTurn("t-report");
}

// ── ⑤ 人工放开:判据不放宽,放开时连交接一起放走 ──────────────────────────────
// 占着不动的锁底下往往压着一串「等这一轮跑完再送」的交接(排队消息投递、队列补推),
// 它们跟着这把锁一起被冻住了 —— 拔锁而不放它们走,任务照旧停在原地。
let thawed = 0;
whenTurnIdle("t-ghost", () => { thawed += 1; });
assert.equal(thawed, 0, "锁还占着时,交接必须排在队里等");
{
  const outcome = await releaseSuspectTurn("t-ghost");
  assert.ok(outcome.ok, "满足判据时人工放开应成功");
}
assert.equal(isTurnClaimed("t-ghost"), false, "人工放开之后锁必须真的放开");
assert.equal(thawed, 1, "被冻住的交接必须随放开一起放走");
assert.equal(claimTurn("t-ghost"), true, "放开之后新回合必须能正常占到锁");
releaseTurn("t-ghost");
{
  const notices = await recentRejectionNotices("t-ghost");
  const released = notices.find((notice) => notice.action === "回合占位已放开");
  assert.ok(released, "没有会话的人工放开也必须持久留痕");
  assert.equal(released.outcome, "system");
  assert.match(released.reason, /已由你手动放开/);
  assert.match(released.reason, /互斥就没了/, "痕迹里必须明示副作用,别让用户以为只是清了个垃圾");
}
// 锁已经不在了:再放一次必须如实说没有,不许误报成功
{
  const again = await releaseSuspectTurn("t-ghost");
  assert.equal(again.ok, false, "没有锁被占着时应如实失败");
  assert.equal(again.ok === false && again.why, "no-lock");
}

// 判据不因为是人点的就放宽:有令牌 / 有句柄 / 刚占下,三种都要挡回并说清是哪一条没过
assert.equal(claimTurn("t-token"), false, "t-token 的锁还占着(它有令牌)");
{
  const refused = await releaseSuspectTurn("t-token");
  assert.equal(refused.ok, false, "绑过令牌的锁有正常结算路径,不许从旁边拔");
  assert.match(refused.ok === false ? refused.reason : "", /令牌/, "409 要说清是哪一条判据没过");
}
{
  const refused = await releaseSuspectTurn("t-handle");
  assert.equal(refused.ok, false, "真有 CLI 在跑时不许拔锁");
  assert.match(refused.ok === false ? refused.reason : "", /进程在跑/);
}
{
  const refused = await releaseSuspectTurn("t-fresh", 60_000);
  assert.equal(refused.ok, false, "刚占下、还在正常起跑窗口内的不许拔");
  assert.match(refused.ok === false ? refused.reason : "", /还在正常起跑的时间范围内/);
}
releaseTurn("t-token");
untrackRun("t-handle", liveHandle);
releaseTurn("t-handle");
releaseTurn("t-fresh");

// ── ⑥ HTTP 放开入口 ─────────────────────────────────────────────────────────
// 2026-10-26 现场:全仓没有任何入口能释放这把锁,唯一解法是重启 server。
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
  assert.equal(tooEarly.status, 409, "刚占下还不到阈值,不许强行放开");
  assert.match((await tooEarly.json() as { error: string }).error, /正常起跑的时间范围/);
}
await sleep(SUSPECT_TURN_MS * 3);
{
  const rescued = await post("/tasks/t-http/reclaim-turn");
  assert.equal(rescued.status, 200, "满足判据时人工放开应成功");
  const body = await rescued.json() as { reclaimed: boolean; note: string };
  assert.equal(body.reclaimed, true);
  assert.match(body.note, /两个回合并行/, "响应里必须明示副作用");
}
assert.equal(isTurnClaimed("t-http"), false, "人工放开后锁必须放开");
assert.equal((await post("/tasks/t-http/reclaim-turn")).status, 409, "放开过了再点应如实 409");
// 挡回也要留痕 —— 这条 409 本身就是一次「用户点了、没执行」
assert.ok(
  (await recentRejectionNotices("t-http")).some((n) => n.action === "放开回合占位"),
  "被挡回的放开操作必须留下持久可见的痕迹",
);

// ── ⑦ 队列占位:不永久放弃,但只撤自己那一代 ─────────────────────────────────
// 旧版 seat.release() / reclaimStrandedSeat 都以 `if (isTurnClaimed) return` 开头,于是
// 释放那一瞬恰好有人占着锁(哪怕只是 PATCH status 那种几毫秒的预占),这具 queued 占位就
// 永远没人回滚 —— 任务永久「排队中」,投递判定永远是「等它空下来」。
// 占位前的状态刻意用 failed / done:队列推进会**真的 spawn CLI**(烧真额度),而 failed 被
// 透明跳过、done 已完成,回滚之后 selectNextInQueue 挑不出人,这条链路就测得干净。
await createTasks([
  { ...baseTask, id: "t-seat", title: "seat rollback", status: "failed" },
  { ...baseTask, id: "t-strand", title: "stranded seat", status: "done" },
  { ...baseTask, id: "t-gen", title: "seat generation", status: "failed" },
  { ...baseTask, id: "t-live", title: "live seat", status: "failed" },
]);
await db.insert(queueItems).values([
  { queueId: "q1", taskId: "t-seat", position: 0, createdAt: stamp },
  { queueId: "q1", taskId: "t-strand", position: 1, createdAt: stamp },
  { queueId: "q2", taskId: "t-gen", position: 0, createdAt: stamp },
  { queueId: "q3", taskId: "t-live", position: 0, createdAt: stamp },
]);
const statusOf = async (taskId: string): Promise<string | undefined> =>
  (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0)?.status;

{
  const claim = await claimQueueSeat("t-seat");
  assert.ok(claim.ok && claim.seat, "空闲队列应认领到执行占位");
  assert.equal(await statusOf("t-seat"), "queued", "认领到占位 = 任务立刻是 queued");
  // 释放的那一刻锁被别人占着(真实来源:PATCH status 的 "status" 预占)
  assert.equal(claimTurn("t-seat", "status"), true);
  await claim.seat!.release();
  assert.equal(await statusOf("t-seat"), "queued",
    "锁被人占着时不许当场回滚 —— 那可能是别人正拿着这个占位起跑");
  // 锁一释放,排在后面的那一眼就该发生
  releaseTurn("t-seat");
  await sleep(30);
  assert.equal(await statusOf("t-seat"), "failed",
    "锁释放之后必须把没人接手的 queued 占位回滚掉,不能永久停在「排队中」");
}

// **本轮审查 F3 的回归。** `endTurn` 按注册顺序跑回调:排在旧回滚**之前**的那个合法回调
// 完全可以在同一个释放点上抢到新锁,而旧回滚只看「状态还是 queued 吗」就照写 —— 审查者
// 实测 `{"newTurnStillHeld":{"role":"single"},"statusAfterOldRollback":"failed"}`,后来者的
// 占位被撤掉、任务翻回终态,结算钩子放行下一个成员,反而造出双跑。
{
  const claim = await claimQueueSeat("t-gen");
  assert.ok(claim.ok && claim.seat, "应认领到执行占位");
  assert.equal(claimTurn("t-gen", "status"), true, "释放那一刻锁被占着 → 回滚延期");
  // 后继者**先**登记:它会排在我们的延期回滚之前,在同一个释放点上抢到新锁
  let successorClaimed = false;
  whenTurnIdle("t-gen", () => { successorClaimed = claimTurn("t-gen", "single"); });
  await claim.seat!.release();   // 这才登记我们的延期回滚
  releaseTurn("t-gen");          // endTurn:先跑后继者(抢锁),再跑我们的回滚
  await sleep(30);
  assert.equal(successorClaimed, true, "后继者应在这个释放点上抢到新锁");
  assert.equal(isTurnClaimed("t-gen"), true, "后继者那把锁必须完好");
  assert.equal(await statusOf("t-gen"), "queued",
    "延期回滚必须认出锁已被接手,不许把后来者的占位撤成终态");
  // 收敛性:后继者只占了锁、没落新占位也没改状态,它放手之后这具 queued 仍该被收拾
  releaseTurn("t-gen");
  await sleep(30);
  assert.equal(await statusOf("t-gen"), "failed", "后继者放手后,没人认领的 queued 仍要回滚");
}

{
  // reclaimStrandedSeat 收的是「没有任何活着的 seat 认领」的 queued 遗留。有活着的 seat
  // 时它不许插手 —— 那具 queued 是那个 seat 的,撤掉它同样是撤后来者的占位。
  const live = await claimQueueSeat("t-live");
  assert.ok(live.ok && live.seat, "应认领到执行占位");
  assert.notEqual(seatGeneration("t-live"), 0, "认领成功应发出一个世代号");
  await reclaimStrandedSeat("t-live", "q3", "failed");
  assert.equal(await statusOf("t-live"), "queued", "有活着的 seat 时守卫不许替它回滚");
  await live.seat!.release();
  await sleep(30);
  assert.equal(await statusOf("t-live"), "failed", "seat 自己的 release 负责回滚");
  assert.equal(seatGeneration("t-live"), 0, "回滚落地后世代号要清掉");
}

{
  // reclaimStrandedSeat 同款:锁被占着时排到释放之后,而不是直接放弃
  await setTaskStatus("t-strand", "queued");
  assert.equal(claimTurn("t-strand", "status"), true);
  await reclaimStrandedSeat("t-strand", "q1", "done");
  assert.equal(await statusOf("t-strand"), "queued", "锁被占着时不动");
  releaseTurn("t-strand");
  await sleep(30);
  assert.equal(await statusOf("t-strand"), "done", "锁释放之后遗留占位必须被收拾");
}

// ── ⑦b 提交期间锁在回滚手里 ──────────────────────────────────────────────────
// **第 2 轮审查 F1 的回归。** `setTaskStatus` 自己内部就有 await(先整行 SELECT 再 UPDATE),
// 所以「写之前再查一次所有权」挡不住那段窗口:新持有者能在那次 SELECT 期间占锁、绑令牌、
// 落 running,旧回滚随后照样把它写回终态,还连带触发结算与队列推进(审查者实测新锁仍在
// 而状态已被翻成 failed)。改成**占着锁提交**之后,提交期间就不可能有人占进来。
await createTasks([{ ...baseTask, id: "t-commit", title: "commit under lock", status: "failed" }]);
await db.insert(queueItems).values([{ queueId: "q4", taskId: "t-commit", position: 0, createdAt: stamp }]);
{
  const claim = await claimQueueSeat("t-commit");
  assert.ok(claim.ok && claim.seat, "应认领到执行占位");
  // 不 await:release() 同步走到 claimNonTurn 才遇到第一个 await,此刻锁必须已在它手里
  const committing = claim.seat!.release();
  assert.equal(claimTurn("t-commit", "single"), false,
    "回滚提交期间不许有人占到锁 —— 那正是新一轮能插进 setTaskStatus 内部 await 的入口");
  await committing;
  assert.equal(isTurnClaimed("t-commit"), false, "提交完必须把锁还回去");
  assert.equal(await statusOf("t-commit"), "failed", "没人接手的占位照常回滚");
}
{
  // 对称点:scheduler 的兜底补偿同患同一个毛病,所以同样要占着锁提交
  await createTasks([{ ...baseTask, id: "t-commit2", title: "guard commits under lock", status: "done" }]);
  await db.insert(queueItems).values([{ queueId: "q4", taskId: "t-commit2", position: 1, createdAt: stamp }]);
  await setTaskStatus("t-commit2", "queued");
  const committing = reclaimStrandedSeat("t-commit2", "q4", "done"); // 不 await
  assert.equal(claimTurn("t-commit2", "single"), false, "守卫提交期间同样不许有人占到锁");
  await committing;
  assert.equal(isTurnClaimed("t-commit2"), false, "提交完必须把锁还回去");
  assert.equal(await statusOf("t-commit2"), "done", "遗留占位照常被收拾");
}

// ── ⑦c 责任交回:幽灵锁压着的占位,放开之后要被收拾 ─────────────────────────
// **第 2 轮审查 F2 的回归。** 回滚被一把没人还的锁挡住时,责任仍在这个 seat 手上(世代
// 号非 0),scheduler 的兜底据此让位。问题出在「放弃时留着号码」—— 那就成了谁都不来收。
// 现在放弃路径会清号并交接;而正常的恢复路径是:用户手动放开那把锁,被冻住的回滚跟着放走。
await createTasks([{ ...baseTask, id: "t-ghostseat", title: "seat under ghost lock", status: "failed" }]);
await db.insert(queueItems).values([{ queueId: "q5", taskId: "t-ghostseat", position: 0, createdAt: stamp }]);
{
  const claim = await claimQueueSeat("t-ghostseat");
  assert.ok(claim.ok && claim.seat, "应认领到执行占位");
  assert.equal(claimTurn("t-ghostseat", "single"), true, "一把没人会来还的锁压在上面");
  await claim.seat!.release();
  assert.equal(await statusOf("t-ghostseat"), "queued", "锁占着,回滚只能排队等");
  assert.notEqual(seatGeneration("t-ghostseat"), 0, "责任还在这个 seat 手上,兜底该让位");
  await reclaimStrandedSeat("t-ghostseat", "q5", "failed");
  assert.equal(await statusOf("t-ghostseat"), "queued", "有活着的 seat 负责时兜底不插手");
  // 恢复:用户手动放开那把锁 → afterTurn 回调放走 → 回滚跑完 → 号码交回
  await sleep(SUSPECT_TURN_MS * 3);
  assert.ok((await releaseSuspectTurn("t-ghostseat")).ok, "满足判据时人工放开应成功");
  await sleep(30);
  assert.equal(await statusOf("t-ghostseat"), "failed",
    "锁一放开,被它冻住的占位回滚必须跑完 —— 否则任务永久停在「排队中」");
  assert.equal(seatGeneration("t-ghostseat"), 0, "责任交回后号码要清掉,不能永久屏蔽兜底");
}

// ── ⑦d 停止:等到真的释放才说「可以重新运行」 ────────────────────────────────
// **第 2 轮审查 F3 的回归。** `freezeStartingTurn` 只要看见一个非预占身份就返回 true ——
// 活着的起跑流程和一把没人管的锁在它眼里一模一样。上一版拿它的返回值当「已撤回启动」,
// 于是真正泄漏的锁也被说成撤回了,用户据此去点运行,仍是 409。现在改成**观察释放**。
await createTasks([
  { ...baseTask, id: "t-stoplive", title: "stop with live starter", status: "queued" },
  { ...baseTask, id: "t-stopghost", title: "stop with ghost lock", status: "queued" },
]);
{
  // 活着的起跑流程:占着位,稍后走到 spawn 前那道闸,消费冻结标记并撤回这一轮
  assert.equal(claimTurn("t-stoplive", "single"), true);
  // 不 unref:停止那一侧正等着这个回调把锁还回去
  setTimeout(() => {
    if (takeFreeze("t-stoplive")) releaseTurn("t-stoplive"); // 闸命中 → 撤回 → 还锁
  }, 20);
  const res = await post("/tasks/t-stoplive/stop");
  assert.equal(res.status, 200);
  const body = await res.json() as { strandedTurn: boolean; note: string };
  assert.equal(body.strandedTurn, false, "活着的起跑流程会消费冻结并还锁,停止该等到");
  assert.match(body.note, /现在可以重新运行/);
  assert.equal(isTurnClaimed("t-stoplive"), false, "等到的就是锁真的空了");
}
{
  // 没人会还的锁:等不到就如实说,不猜、更不强拔
  assert.equal(claimTurn("t-stopghost", "single"), true);
  const res = await post("/tasks/t-stopghost/stop");
  assert.equal(res.status, 200);
  const body = await res.json() as { strandedTurn: boolean; note: string };
  assert.equal(body.strandedTurn, true, "等不到释放要如实说,不许谎称已撤回启动");
  assert.match(body.note, /放开回合占位/, "要告诉用户那个开关在哪");
  assert.doesNotMatch(body.note, /现在可以重新运行/, "没等到就不许说可以重新运行了");
  assert.equal(isTurnClaimed("t-stopghost"), true, "停止不许强拔锁 —— 证不了原持有者已结束");
  const notices = await recentRejectionNotices("t-stopghost");
  assert.equal(notices.length, 1, "没等到释放要留下持久痕迹");
  assert.equal(notices[0]!.action, "停止");
  assert.equal(notices[0]!.outcome, "incomplete", "已经取消但锁还占着是生效未到位,不是拒绝");
  assert.equal((await db.select().from(tasks).where(eq(tasks.id, "t-stopghost"))).at(0)?.status, "canceled");
  releaseTurn("t-stopghost");
}

// ── ⑧ 被挡回的用户操作留下持久可见的痕迹 ─────────────────────────────────────
// 只弹一次 toast 的话,刷新页面之后用户看不出「点过、没成、为什么」—— 2026-10-26 他
// 因此两次误判(以为按钮坏了 / 以为任务已经跑完)。
//
// **落点只有一处**(第 2 轮审查 F4):上一版同时写表和会话正文、前端只在对话流为空时读表,
// 于是任务一跑出正文,第一次被拒的记录还在库里却再也显示不出来。「有没有正文」跟「这段
// 历史该不该可见」没有关系,所以改成只写表、由前端无条件合进同一条历史。
await createTasks([{ ...baseTask, id: "t-note", title: "rejection note" }]);
const noteSession = await seedSession("t-note");
{
  assert.equal(await noteRejectedUserAction("t-note", "派审查", "任务正等待答复或续跑，处理后再派审"), true);
  const notices = await recentRejectionNotices("t-note");
  assert.equal(notices.length, 1, "被挡回的操作必须留下持久记录");
  assert.ok(notices[0]!.id, "记录要有稳定身份 —— 前端靠它合进时间线并去重");
  assert.equal(notices[0]!.action, "派审查");
  assert.match(notices[0]!.reason, /任务正等待答复或续跑/, "痕迹里必须带上挡回的理由");
  // **有会话也不写会话正文**:两份记录就会出现「只有一份写成」的半可见状态
  assert.equal(await timelineOf("t-note", noteSession), "",
    "通知只有表这一处落点,不许再往会话正文写第二份");
  // 去重:按钮没反应时用户会连点,一次一条会把历史刷满、把真正的进展埋掉
  assert.equal(await noteRejectedUserAction("t-note", "派审查", "任务正等待答复或续跑，处理后再派审"), false,
    "同一条挡回在去重窗口内只记一次");
  assert.equal(await noteRejectedUserAction("t-note", "派审查", "任务回合正在进行，结束后再派审"), true,
    "换了理由就是新事实,照记");
}
{
  // 从没跑过的任务也必须留下痕迹 —— 「点运行被同队前项挡回」最常发生的正是这一档。
  await createTasks([{ ...baseTask, id: "t-nosession", title: "never ran", status: "backlog" }]);
  assert.equal(
    await noteRejectedUserAction("t-nosession", "运行", "同一队列里还有未完成或正在运行的任务"),
    true,
    "没有会话的任务同样要留下持久痕迹",
  );
  const notices = await recentRejectionNotices("t-nosession");
  assert.equal(notices.length, 1, "通知表里应有这一条");
  assert.equal(notices[0]!.action, "运行");
  assert.match(notices[0]!.reason, /同一队列/);
}
{
  // **不按时间窗砍历史。** 上一版只回看 24 小时,窗口之外的记录还在库里却无法从界面
  // 追溯(第 2 轮审查 F4)—— 这是任务历史的一部分,不是「刚才那一下」的提示。
  await createTasks([{ ...baseTask, id: "t-old", title: "old notice", status: "backlog" }]);
  const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString();
  await db.insert(taskNotices).values({
    id: "n-old", taskId: "t-old", action: "运行", reason: "很久以前被挡回的那一次", occurredAt: longAgo,
  });
  const notices = await recentRejectionNotices("t-old");
  assert.equal(notices.length, 1, "一个月前的挡回仍要能读出来");
  assert.equal(notices[0]!.id, "n-old");
}
{
  // 删任务要连它的通知一起删,别留下指着已删任务、再也打不开的孤儿行。
  await db.delete(taskNotices).where(eq(taskNotices.taskId, "t-old"));
  assert.equal((await recentRejectionNotices("t-old")).length, 0);
}
{
  // 路由层:验收锁下点运行 409,痕迹要落下来
  // status 必须是**可运行**的那一档:done 任务会先被「当前状态不可运行」挡掉,而那一类
  // 挡板刻意不留痕(用户在界面上一眼就能看出任务已经完成)。
  await createTasks([{ ...baseTask, id: "t-run409", title: "run rejected", status: "failed" }]);
  assert.equal(beginAccepting("t-run409"), true);
  const res = await post("/tasks/t-run409/run");
  assert.equal(res.status, 409);
  endAccepting("t-run409");
  const notices = await recentRejectionNotices("t-run409");
  assert.equal(notices.length, 1, "/run 的状态性 409 必须留下持久可见的痕迹");
  assert.match(notices[0]!.reason, /验收/, "痕迹里要说清是被什么挡的");
  assert.equal(isTurnClaimed("t-run409"), false, "挡回不许留下占着的回合锁");
}

// ── ⑨ 久久发不出去的待发送消息会出声 ────────────────────────────────────────
// 上面那套分段计时只在**送成之后**结算,所以「一直没送成」正好落在它的盲区里:现场那条
// 消息躺了 70+ 分钟,日志从头到尾一声不吭。
await createTasks([
  { ...baseTask, id: "t-stall", title: "stalled message" },
  { ...baseTask, id: "t-stall-empty", title: "never ran", status: "queued" },
  { ...baseTask, id: "t-stall-retry", title: "retry notice", status: "queued" },
]);
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
  for (const taskId of ["t-stall", "t-stall-empty"]) {
    const message = { ...row, id: `m-${taskId}`, taskId };
    await db.insert(scheduledMessages).values(message as never);
    const reason = "任务停在「排队中」，但队列里没有别的任务在跑";
    await Promise.all([noteStalledPending(message, reason), noteStalledPending(message, reason)]);
    const response = await api.request(`/tasks/${taskId}/notices`);
    assert.equal(response.status, 200);
    const { notices } = await response.json() as { notices: { id: string; outcome: string; reason: string }[] };
    assert.equal(notices.length, 1, "有无会话的滞留消息都应有持久诊断");
    assert.equal(notices[0]!.outcome, "system");
    assert.match(notices[0]!.reason, /还没发出去/);
    assert.match(notices[0]!.reason, /排队中/);
    assert.match(notices[0]!.reason, /不会丢/);
    forgetStalled(message.id);
    await noteStalledPending(message, "重扫时的新理由");
    assert.deepEqual(await recentRejectionNotices(taskId), notices, "内存去重丢失后也不能重复写或改旧事实");
    assert.equal(await noteSystemNotice(taskId, `stalled-message:${message.id}`, "重扫", "重复诊断"), true);
    assert.deepEqual(await recentRejectionNotices(taskId), notices, "持久事件键应让独立写入也保持幂等");
  }
  assert.equal(await timelineOf("t-stall", stallSession), "", "诊断不能依赖会话正文或重复写正文");
  const retry = { ...row, id: "m-stall-retry", taskId: "t-stall-retry" };
  await db.insert(scheduledMessages).values(retry as never);
  await failNextNoticeWrite(() => noteStalledPending(retry, "写失败后应重试"));
  assert.equal((await recentRejectionNotices(retry.taskId)).length, 0);
  await noteStalledPending(retry, "写失败后应重试");
  assert.equal((await recentRejectionNotices(retry.taskId)).length, 1, "写失败不能永久压住后续扫描");

  // 定时消息按 sendAt 起算:排在一小时后的那条「还没发出去」是本意,不是卡住
  const future = { ...row, id: "m-future", mode: "timed", sendAt: soon };
  await db.insert(scheduledMessages).values(future as never);
  await noteStalledPending(future, "还没到发送时间");
  assert.doesNotMatch(JSON.stringify(await recentRejectionNotices("t-stall")), /还没到发送时间/,
    "定时消息在 sendAt 之前不算滞留,不该报警");
}

console.log("turn-reclaim regressions ok");
dbClient.close();
process.exit(0);
