// 完成确认这一刻的哨兵闸 —— 「挂着哨兵就不许收工」和「先撤再收工要留痕」。
//
// 这条闸补的是用户 2026-10-16 提出、而当时只做了另一半的那件事：那一轮（提交 69d67845）
// 交付的是**说清楚在等什么**（`reservationWaitReason` + 会话区的哨兵卡），判据一直是
// 「任务有没有停下来」（`task.question || task.resumePrompt`），所以 `complete_task` 这条
// 路上一个字都没拦 —— 2026-10-20 任务 u7nb4wnGcX2O 就是从这里走掉的：挂上哨兵 10 秒后自撤、
// 直接确认完成，哨兵 0 事件、它等的结果再也没人去取。
//
// 这份回归钉三件事，少一件闸就会以别的方式漏：
//  ① 还在盯的哨兵**真的拦得住**（而且没放行 —— 看 `complete_confirmed_at` 本身，不是只看
//     HTTP 码）；
//  ② **审查豁免两边同口径**：属于一次仍在进行的审查的哨兵活得过这次完成（`stopMonitorsForTask`
//     放过它们），所以闸也不许拦它；那次审查一结束，豁免立刻失效；
//  ③ 「先撤再完成」放行，但**本回合**撤的那几个要留在时间线上；上一回合撤的不算（时间窗）。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { isSilentWaitLoop, monitorEventTally, silentWaitNotice } from "@ash/shared/monitor-silence";
import {
  db, insertMonitorRow, makeTask, monitors, now, reviewInFlight, root, schema, sessions, tasks, teardown,
} from "./monitors-fixture.js";

const { mountTaskRunRoutes } = await import("../src/task-run-routes.js");
const { sessionTranscriptPath } = await import("../src/transcript.js");

const api = new Hono();
mountTaskRunRoutes(api);

const complete = (taskId: string) => api.request(`/tasks/${taskId}/complete`, {
  method: "POST", headers: { "content-type": "application/json" }, body: "{}",
});
const confirmedAt = async (taskId: string): Promise<string | null> =>
  (await db.select({ at: tasks.completeConfirmedAt }).from(tasks).where(eq(tasks.id, taskId))).at(0)?.at ?? null;

/** 一条带回合起点的执行会话 —— 「本回合」这个时间窗就是从它身上读的。 */
async function sessionWithTurn(taskId: string, turnStartedAt: string): Promise<string> {
  const id = `sess-${taskId}`;
  await db.insert(sessions).values({
    id, taskId, role: "single", agentType: "claude", executor: "claude",
    cwd: root, startedAt: turnStartedAt, turnStartedAt,
  });
  return id;
}
const transcriptOf = (sessionId: string, taskId: string): string => {
  try { return readFileSync(sessionTranscriptPath(taskId, sessionId), "utf8"); }
  catch { return ""; }
};

// ── ① 还在盯的哨兵拦得住，而且真的没放行 ──────────────────────────────────────
{
  const taskId = await makeTask();
  await insertMonitorRow(taskId, { command: "tail -F build.log" });
  const res = await complete(taskId);
  assert.equal(res.status, 409, "挂着活哨兵时完成确认必须被拒");
  const body = await res.json() as { error: string };
  assert.match(body.error, /还有 1 个哨兵/, "拒绝文案要说清有几个");
  // 出路必须在文案里：少了它，agent 撞上一个永远等不到的哨兵就被锁死在这个任务上。
  assert.match(body.error, /pause_task/, "要给出「还要结果」那条路");
  assert.match(body.error, /stop_monitor/, "要给出「不要了」那条路");
  assert.equal(await confirmedAt(taskId), null, "被拒的那一次不许留下完成确认");
}

// ── ② 属于一次仍在进行的审查的哨兵：活得过这次完成，所以不许拦 ────────────────
{
  const taskId = await makeTask();
  await reviewInFlight(taskId, "run-gate-live", { round: 2 });
  await insertMonitorRow(taskId, { reviewRun: "run-gate-live", round: 2 });
  const res = await complete(taskId);
  assert.equal(res.status, 200, "审查哨兵有终态豁免，闸必须跟着放行");
  assert.notEqual(await confirmedAt(taskId), null, "放行就要真的写下确认");
}

// ── ③ 那次审查结束之后，豁免立刻失效 ─────────────────────────────────────────
{
  const taskId = await makeTask();
  await reviewInFlight(taskId, "run-gate-done", { round: 1 });
  await insertMonitorRow(taskId, { reviewRun: "run-gate-done", round: 1 });
  await db.update(schema.freeReviewRuns)
    .set({ status: "done" }).where(eq(schema.freeReviewRuns.id, "run-gate-done"));
  assert.equal((await complete(taskId)).status, 409, "审查已结束 ⇒ 这条哨兵会被收走 ⇒ 必须拦");
  assert.equal(await confirmedAt(taskId), null);
}

// ── ④ 先撤再完成：放行，但本回合撤的要落在时间线上 ───────────────────────────
{
  const taskId = await makeTask();
  const turnStart = new Date(Date.now() - 60_000).toISOString();
  const sessionId = await sessionWithTurn(taskId, turnStart);
  const monitorId = await insertMonitorRow(taskId, { command: "until grep -q OK log; do sleep 15; done" });
  await db.update(monitors).set({
    status: "stopped", endedAt: now(), endedReason: "全量测试只是旁证,不为它挂起整个任务",
  }).where(eq(monitors.id, monitorId));

  assert.equal((await complete(taskId)).status, 200, "撤干净之后完成该放行");
  const text = transcriptOf(sessionId, taskId);
  assert.match(text, /本回合撤掉 1 个哨兵后确认完成/, "撤了哨兵就收工这件事必须看得见");
  assert.match(text, /全量测试只是旁证/, "撤的理由要原样带出来");
  // 0 事件要说人话：用户看到一个「0」只会以为哨兵坏了。
  assert.match(text, /一条事件都没推/, "没推出任何事件这件事要说出口");
}

// ── ⑤ 上一回合撤的不算：时间窗必须真的起作用 ─────────────────────────────────
{
  const taskId = await makeTask();
  const turnStart = new Date(Date.now() - 60_000).toISOString();
  const sessionId = await sessionWithTurn(taskId, turnStart);
  const monitorId = await insertMonitorRow(taskId);
  await db.update(monitors).set({
    status: "stopped",
    endedAt: new Date(Date.now() - 600_000).toISOString(), // 这一轮开跑之前就撤了
    endedReason: "上一轮的事",
  }).where(eq(monitors.id, monitorId));

  assert.equal((await complete(taskId)).status, 200);
  assert.doesNotMatch(transcriptOf(sessionId, taskId), /本回合撤掉/, "上一回合撤的不该算进这一轮");
}

// ── ⑥ 静默命令的判据本身 ─────────────────────────────────────────────────────
{
  // 那次空转的原命令：循环体里只有 sleep ⇒ 跳出之前结构上不可能有输出。
  const real = 'until grep -qE "^(OK|FAILED)" /tmp/u7nb-fulltest.log 2>/dev/null; do sleep 15; done; '
    + 'grep -E "^(OK|FAILED|Ran )" /tmp/u7nb-fulltest.log | tail -3';
  assert.equal(isSilentWaitLoop(real), true, "只有 sleep 的等待循环 = 静默");
  assert.equal(isSilentWaitLoop("until grep -q OK log\ndo\n  sleep 5\ndone"), true, "换行写法也要认出来");
  // 循环体里有会吐字的东西就**什么都不说**：宁可漏报也不误报。
  assert.equal(
    isSilentWaitLoop('until grep -q OK log; do echo "[等待] $(wc -l < log)"; sleep 15; done'),
    false, "循环里会报活 ⇒ 不是静默",
  );
  assert.equal(isSilentWaitLoop("tail -F build.log | grep --line-buffered ERROR"), false, "压根没有等待循环");

  assert.match(silentWaitNotice(real, 1_800_000) ?? "", /30 分钟后到期/, "提醒里要带上它会哑多久");
  assert.equal(silentWaitNotice("tail -F x.log", 60_000), null, "不是静默循环就一个字都不说");

  assert.match(monitorEventTally(0, real), /它等的条件直到最后都没出现/, "静默循环的 0 条要解释清楚");
  assert.match(monitorEventTally(0, "tail -F x.log"), /没吐出一行/, "普通命令的 0 条也要说人话");
  assert.equal(monitorEventTally(3, real), "共推送 3 条事件", "推出去过就照旧报数");
}

await teardown();
console.log("✓ 完成确认的哨兵闸");
