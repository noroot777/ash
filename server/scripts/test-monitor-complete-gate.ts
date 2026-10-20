// 完成确认这一刻的哨兵闸 —— 「挂着哨兵就不许收工」「结果没收到就不许收工」「先撤再收工要留痕」。
//
// 这条闸补的是用户 2026-10-16 提出、而当时只做了另一半的那件事：那一轮（提交 69d67845）
// 交付的是**说清楚在等什么**（`reservationWaitReason` + 会话区的哨兵卡），判据一直是
// 「任务有没有停下来」（`task.question || task.resumePrompt`），所以 `complete_task` 这条
// 路上一个字都没拦 —— 2026-10-20 任务 u7nb4wnGcX2O 就是从这里走掉的：挂上哨兵 10 秒后自撤、
// 直接确认完成，哨兵 0 事件、它等的结果再也没人去取。
//
// 下面每一节钉的都是一条**能让闸以别的方式漏掉**的路，第 1 轮审查从中走穿过三条：
//  ① 还在盯的哨兵真的拦得住（看 `complete_confirmed_at` 本身，不是只看 HTTP 码）；
//  ② 审查豁免两边同口径（属于一次仍在进行的审查的哨兵活得过这次完成），审查一结束豁免失效；
//  ③ 「先撤再完成」放行，但本回合**主动**撤的那几个要留在时间线上、写进那一回合**自己**
//     那条会话（上一回合撤的不算；额度自动停不算主动撤 —— N1）；
//  ④ **已经出了结果、但还排在待发送里没送到执行者手上的**也要拦（F2）；
//  ⑤ 确认之后再挂哨兵、断线补录绕过入口、结算最后一关（F1 的三条路）；
//  ⑥ 静默与零输出的措辞只说可证实的事实（F3、N3）。
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { isSilentWaitLoop, monitorEventTally, silentWaitNotice, spanWords } from "@ash/shared/monitor-silence";
import {
  db, insertMonitorRow, makeTask, monitors, now, reviewInFlight, root, schema, scheduledMessages,
  sessions, sleep, startMonitor, tasks, teardown, uniq,
} from "./monitors-fixture.js";

const { mountTaskRunRoutes } = await import("../src/task-run-routes.js");
const { sessionTranscriptPath } = await import("../src/transcript.js");
const { settleTaskStatus } = await import("../src/single-run.js");
const { replayUndeliveredMcpCalls } = await import("../src/mcp-handoff.js");
const { RUNS_DIR } = await import("../src/paths.js");

const api = new Hono();
mountTaskRunRoutes(api);

const complete = (taskId: string) => api.request(`/tasks/${taskId}/complete`, {
  method: "POST", headers: { "content-type": "application/json" }, body: "{}",
});
const taskRow = async (taskId: string) =>
  (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0)!;
const confirmedAt = async (taskId: string): Promise<string | null> =>
  (await taskRow(taskId)).completeConfirmedAt ?? null;
const monitorStatus = async (monitorId: string): Promise<string> =>
  (await db.select({ s: monitors.status }).from(monitors).where(eq(monitors.id, monitorId))).at(0)!.s;

/** 一条带回合起点的执行会话 —— 「本回合」这个时间窗就是从它身上读的。 */
async function sessionWithTurn(
  taskId: string, turnStartedAt: string,
  opts: { id?: string; agentType?: string; startedAt?: string; turn?: boolean } = {},
): Promise<string> {
  const id = opts.id ?? `sess-${taskId}`;
  await db.insert(sessions).values({
    id, taskId, role: "single", agentType: opts.agentType ?? "claude", executor: "claude",
    cwd: root, startedAt: opts.startedAt ?? turnStartedAt,
    turnStartedAt: opts.turn === false ? null : turnStartedAt,
  });
  return id;
}
const transcriptOf = (sessionId: string, taskId: string): string => {
  try { return readFileSync(sessionTranscriptPath(taskId, sessionId), "utf8"); }
  catch { return ""; }
};
/** 主动撤掉一条哨兵（`ended_by='actor'`，跟 `stopMonitor` 落的那一行一致）。 */
const dropByActor = (monitorId: string, reason: string, endedAt = now()) =>
  db.update(monitors).set({ status: "stopped", endedAt, endedReason: reason, endedBy: "actor" })
    .where(eq(monitors.id, monitorId));
/** 一条哨兵推来的事件，还排在待发送托盘里。 */
const queueMonitorEvent = async (taskId: string, monitorId: string, text: string): Promise<string> => {
  const id = uniq("msg");
  await db.insert(scheduledMessages).values({
    id, taskId, text, origin: `monitor:${monitorId}`, mode: "queued",
    sendAt: now(), status: "pending", createdAt: now(),
  });
  return id;
};

// ── ① 还在盯的哨兵拦得住，而且真的没放行 ──────────────────────────────────────
{
  const taskId = await makeTask();
  await insertMonitorRow(taskId, { command: "tail -F build.log" });
  const res = await complete(taskId);
  assert.equal(res.status, 409, "挂着活哨兵时完成确认必须被拒");
  const body = await res.json() as { error: string };
  assert.match(body.error, /1 个哨兵还在盯着/, "拒绝文案要说清有几个");
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
  await dropByActor(monitorId, "全量测试只是旁证,不为它挂起整个任务");

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
  // 这一轮开跑之前就撤了
  await dropByActor(monitorId, "上一轮的事", new Date(Date.now() - 600_000).toISOString());

  assert.equal((await complete(taskId)).status, 200);
  assert.doesNotMatch(transcriptOf(sessionId, taskId), /本回合撤掉/, "上一回合撤的不该算进这一轮");
}

// ── ⑥ N1：额度自动停不是「主动撤掉」────────────────────────────────────────
{
  const taskId = await makeTask();
  const sessionId = await sessionWithTurn(taskId, new Date(Date.now() - 60_000).toISOString());
  const monitorId = await insertMonitorRow(taskId);
  await db.update(monitors).set({
    status: "stopped", endedAt: now(), endedBy: "limit",
    endedReason: "推够了 200 条事件自动停——每条事件都要唤醒任务跑一轮",
  }).where(eq(monitors.id, monitorId));

  assert.equal((await complete(taskId)).status, 200, "它已经停了，完成该放行");
  assert.doesNotMatch(
    transcriptOf(sessionId, taskId), /本回合撤掉/,
    "推满上限自动停不是人或 agent 主动撤的，不许说成「撤掉」（N1）",
  );
}

// ── ⑦ N2：留痕要写进这一回合自己那条会话 ─────────────────────────────────────
{
  const taskId = await makeTask();
  const turnStart = new Date(Date.now() - 60_000).toISOString();
  // 先建的 claude 会话正在跑这一回合；后建的 codex 会话从没跑过回合（`appendTaskTimeline`
  // 的默认挑法按创建时间取最新，正好会挑错它）。
  const mine = await sessionWithTurn(taskId, turnStart, { id: `sess-mine-${taskId}` });
  const other = await sessionWithTurn(taskId, turnStart, {
    id: `sess-other-${taskId}`, agentType: "codex", startedAt: now(), turn: false,
  });
  const monitorId = await insertMonitorRow(taskId);
  await dropByActor(monitorId, "换个法子等");

  assert.equal((await complete(taskId)).status, 200);
  assert.match(transcriptOf(mine, taskId), /本回合撤掉/, "说明要落在确认来自的那条会话上");
  assert.doesNotMatch(
    transcriptOf(other, taskId), /本回合撤掉/,
    "不许写进另一位智能体的时间线（N2）",
  );
}

// ── ⑧ F2：已经出了结果、还排在待发送里没送到 ⇒ 一样要拦 ──────────────────────
{
  const taskId = await makeTask();
  const monitorId = await insertMonitorRow(taskId, { status: "exited", command: "printf 'RESULT_READY\\n'" });
  await db.update(monitors).set({ endedAt: now(), exitCode: 0, events: 1 }).where(eq(monitors.id, monitorId));
  const messageId = await queueMonitorEvent(taskId, monitorId, "RESULT_READY");

  const res = await complete(taskId);
  assert.equal(res.status, 409, "进程不再 running ≠ 结果已经被执行者消费（F2）");
  const body = await res.json() as { error: string };
  assert.match(body.error, /1 条哨兵结果还排在待发送/, "要说清拦的是哪一类");
  assert.match(body.error, /pause_task/, "出路是「先收下来看一眼」");
  assert.equal(await confirmedAt(taskId), null);

  // 收下来之后闸自己就开 —— 不是给所有历史终态哨兵永久加锁。
  await db.update(scheduledMessages).set({ status: "sent", sentAt: now() })
    .where(eq(scheduledMessages.id, messageId));
  assert.equal((await complete(taskId)).status, 200, "结果已经送到就该放行");
}

// ── ⑧b 出路②必须真的走得通：主动撤掉的哨兵，它排着的结果按「明确放弃」算 ──────
{
  const taskId = await makeTask();
  const sessionId = await sessionWithTurn(taskId, new Date(Date.now() - 60_000).toISOString());
  const monitorId = await insertMonitorRow(taskId, { command: "tail -F deploy.log" });
  // `stop_monitor` 不会取消已经攒进托盘的那几行（它们是已经发生的事实），所以这个组合
  // 必须放行 —— 否则「不要了 → stop_monitor → complete_task」这条出路自己走不通。
  await queueMonitorEvent(taskId, monitorId, "[12:00] 又一行进度");
  await dropByActor(monitorId, "这条日志太吵，不看了");

  assert.equal((await complete(taskId)).status, 200, "主动撤掉之后完成必须放行");
  assert.match(
    transcriptOf(sessionId, taskId), /这条日志太吵/,
    "「明确放弃」要看得见：撤的理由连事件计数一起落时间线",
  );
}

// ── ⑨ F2 的豁免同口径：审查哨兵排着的事件不作废，所以也不拦 ───────────────────
{
  const taskId = await makeTask();
  await reviewInFlight(taskId, "run-gate-pending", { round: 1 });
  const monitorId = await insertMonitorRow(taskId, {
    status: "exited", reviewRun: "run-gate-pending", round: 1,
  });
  await queueMonitorEvent(taskId, monitorId, "审查哨兵的结果");
  assert.equal((await complete(taskId)).status, 200, "审查哨兵的待发事件有豁免，不许拦");
}

// ── ⑩ F1-A：确认之后再挂哨兵 —— 那份确认当场失效，结算落检查点暂停而不是 done ──
{
  const taskId = await makeTask();
  const sessionId = await sessionWithTurn(taskId, new Date(Date.now() - 60_000).toISOString());
  assert.equal((await complete(taskId)).status, 200, "没有哨兵时确认该放行");
  assert.notEqual(await confirmedAt(taskId), null);

  const started = await startMonitor({ taskId, command: "sleep 120", description: "等一个结果" });
  assert.ok(started.ok, "挂哨兵本身要成功");
  assert.match(
    started.ok ? started.notice ?? "" : "", /撤掉本回合的完成确认/,
    "撤掉确认这件事要当场告诉 agent（它读创建结果的那一眼）",
  );
  assert.equal(await confirmedAt(taskId), null, "确认必须真的撤掉，不能只在嘴上说");
  const held = await taskRow(taskId);
  assert.ok(held.resumePrompt, "撤了确认就要留下续跑指令，否则这一轮会被记成「没交卷」");

  const settled = await settleTaskStatus(taskId, 0, null);
  assert.equal(settled.status, "paused", "确认之后挂的哨兵不许被 done 连坐停掉（F1 实测那一条）");
  const monitorId = started.ok ? started.monitor.id : "";
  assert.equal(await monitorStatus(monitorId), "running", "它必须还活着");
  assert.match(transcriptOf(sessionId, taskId), /撤掉本回合的完成确认/, "落位变了要留痕");
}

// ── ⑪ F1-B：断线补录这条旁路也要过同一道闸 ───────────────────────────────────
{
  const taskId = await makeTask();
  const sessId = `sess-replay-${taskId}`;
  await sessionWithTurn(taskId, new Date(Date.now() - 60_000).toISOString(), { id: sessId });
  const monitorId = await insertMonitorRow(taskId, { command: "tail -F deploy.log" });
  const turnStart = "2026-10-20T04:08:22.911Z";
  const stream = JSON.stringify({
    type: "item.completed",
    item: {
      id: "item_1", type: "mcp_tool_call", server: "ash", tool: "complete_task",
      arguments: { taskId }, result: null,
      error: { message: "tool call error: tool call failed for `ash/complete_task`\n\nCaused by:\n    Transport closed" },
      status: "failed",
    },
  });
  mkdirSync(join(RUNS_DIR, taskId), { recursive: true });
  const outPath = join(RUNS_DIR, taskId, `${sessId}-${turnStart.replace(/[^0-9A-Za-z]/g, "")}.agent-out.jsonl`);
  writeFileSync(outPath, stream);

  assert.equal(
    await replayUndeliveredMcpCalls({ taskId, sessId, turnStart, agentType: "codex" }), 0,
    "挂着哨兵时补录也不许把确认写进来（F1 实测那一条）",
  );
  assert.equal(await confirmedAt(taskId), null, "补录被拦下就不该留下确认");

  // 撤掉之后同一条记录该补得上 —— 闸拦的是哨兵，不是补录这条路本身。
  await dropByActor(monitorId, "不等它了");
  assert.equal(
    await replayUndeliveredMcpCalls({ taskId, sessId, turnStart, agentType: "codex" }), 1,
    "没有哨兵要护了，这一笔照旧补",
  );
  assert.notEqual(await confirmedAt(taskId), null);
}

// ── ⑫ F1-C：结算是最后一关 —— 确认从别处写进来，done 落位之前照样拦 ────────────
{
  const taskId = await makeTask();
  await sessionWithTurn(taskId, new Date(Date.now() - 60_000).toISOString());
  // 模拟「某条路径绕过了入口闸」：直接把确认写进库（历史上补录就长这样）。
  await db.update(tasks).set({ completeConfirmedAt: now() }).where(eq(tasks.id, taskId));
  const monitorId = await insertMonitorRow(taskId, { command: "tail -F train.log" });

  const settled = await settleTaskStatus(taskId, 0, null);
  assert.equal(settled.status, "paused", "落 done 之前要再问一次同一份判据");
  assert.equal(settled.confirmedDone, false);
  assert.equal(await monitorStatus(monitorId), "running", "哨兵不许被这一次结算收走");
  assert.ok((await taskRow(taskId)).resumePrompt, "拦下来要留一段续跑指令");
}

// ── ⑬ 没有哨兵要护的时候，结算照旧落 done（闸不许顺手改掉正常路径）─────────────
{
  const taskId = await makeTask();
  await sessionWithTurn(taskId, new Date(Date.now() - 60_000).toISOString());
  assert.equal((await complete(taskId)).status, 200);
  const settled = await settleTaskStatus(taskId, 0, null);
  assert.equal(settled.status, "done", "名下干干净净时该落 done");
  assert.equal(settled.confirmedDone, true);
}

// ── ⑭ 静默判据与零输出措辞：只说可证实的事实（F3、N3）───────────────────────
{
  // 那次空转的原命令：循环体里只有 sleep、条件是 `grep -q` ⇒ 跳出之前结构上不会出声。
  const real = 'until grep -qE "^(OK|FAILED)" /tmp/u7nb-fulltest.log 2>/dev/null; do sleep 15; done; '
    + 'grep -E "^(OK|FAILED|Ran )" /tmp/u7nb-fulltest.log | tail -3';
  assert.equal(isSilentWaitLoop(real), true, "只有 sleep 的等待循环 = 看着像静默");
  assert.equal(isSilentWaitLoop("until grep -q OK log\ndo\n  sleep 5\ndone"), true, "换行写法也要认出来");
  assert.equal(
    isSilentWaitLoop('until grep -q OK log; do echo "[等待] $(wc -l < log)"; sleep 15; done'),
    false, "循环里会报活 ⇒ 不是静默",
  );
  // **循环条件本身也会执行、也会输出**（F3 实测：150ms 内吐了好几行 HEARTBEAT）。
  assert.equal(
    isSilentWaitLoop("while printf 'HEARTBEAT\\n'; do sleep 0.02; done"),
    false, "条件里会吐字的不许声称它不说话（F3）",
  );
  assert.equal(isSilentWaitLoop("tail -F build.log | grep --line-buffered ERROR"), false, "压根没有等待循环");

  // 提醒**通篇是条件句**：没有任何一句断言这条命令一定不出声、或者它等的条件一定不成立。
  const notice = silentWaitNotice(real, 1_800_000) ?? "";
  assert.match(notice, /如果/, "事前提醒只能是条件句");
  assert.match(notice, /30 分钟后到期/, "提醒里要带上它会哑多久");
  assert.doesNotMatch(notice, /中途没有任何事件[^，。]*$/, "不许把推测写成断言（F3）");
  assert.equal(silentWaitNotice("tail -F x.log", 60_000), null, "不是静默循环就一个字都不说");
  // N3：timeoutMs 从 1 秒起，`Math.round(ms/60000)` 会说成「0 分钟」。
  assert.equal(spanWords(1_000), "1 秒");
  assert.equal(spanWords(90_000), "1 分 30 秒");
  assert.match(silentWaitNotice(real, 1_000) ?? "", /1 秒后到期/, "短期限用秒说（N3）");

  // 事后那句话只陈述能证实的两样：推了几条、日志里读到过没有 —— 一个字都不提「它等的条件」。
  assert.match(monitorEventTally(0, 0), /日志里也没有任何输出/, "0 事件 0 字节：如实说两样都没有");
  assert.match(monitorEventTally(0, 128), /没有一条送到这个任务头上/, "有输出但 0 事件要分得开");
  assert.doesNotMatch(monitorEventTally(0, 0), /条件/, "不许从没有输出推断业务条件没满足（F3）");
  assert.equal(monitorEventTally(3, 500), "共推送 3 条事件", "推出去过就照旧报数");
}

// 结算会甩出几件后台活（回合基线、待发送投递、时间线）。台子一关库它们就刷一屏
// 「database is not open」—— 噪声本身不是失败，但它会盖住真正的失败。等它们落完再收台子。
await sleep(800);
await teardown();
console.log("✓ 完成确认的哨兵闸");
