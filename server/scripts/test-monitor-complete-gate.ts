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
//
// 第 2 轮审查又从**那几关之间的缝**走穿了四条，所以下面还钉上了：
//  ⑦ 最后一关放行到终态行落库之间那条缝（闩：期间 `startMonitor` 一律 409；R2-1）；
//  ⑧ 补录被闸拦下时落的是**可恢复的等待**，不是 failed（R2-1 实测 `monitorAfter:"stopped"`）；
//  ⑨ 原生命令回合、以及续聊回合里**没交卷**那一支，也都会收走哨兵 ⇒ 一样过闸（R2-1）；
//  ⑩ 系统替它写下的那段等待**有有效期**：阻塞物没了、重新交卷就清掉，而 agent 自己
//     `pause_task` 写的那段谁也不许抹（R2-2）；
//  ⑪ 「这个结果不要了」用**真的** `stop_monitor` 对一条**已经结束**的哨兵也走得通（R2-3）。
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { isSilentWaitLoop, monitorEventTally, silentWaitNotice, spanWords } from "@ash/shared/monitor-silence";
import { checkpointGroups } from "./monitor-complete-checkpoint-groups.js";
import { resultHandoffGroups } from "./monitor-result-handoff-groups.js";
import {
  beginTerminalLanding, complete, confirmedAt, db, dropByActor, inTurnCaller, insertMonitorRow, makeTask,
  monitorRow, monitors, monitorStatus, now, pendingOf, queueMonitorEvent, redeliverResultHandoffs,
  replayUndeliveredMcpCalls, reviewInFlight, runs, schema, scheduledMessages, serialize, sessionWithTurn,
  setTaskStatus, settleTaskStatus, sleep, startMonitor, stopMonitor, tasks, taskRow, teardown,
  terminalLandingInFlight, transcriptOf, until, writeLostCompleteCall,
} from "./monitor-complete-gate-harness.js";

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
  // **真起、真停**：预写一行 `ended_by='actor'` 证明不了这条出路通（第 2 轮审查 R2-3 就是
  // 从这里漏的 —— 旧用例预写终态字段，而真 `stopMonitor` 在那条路上一笔凭证都没写）。
  const started = await startMonitor({ taskId, command: "tail -f /dev/null", description: "太吵的日志" });
  assert.ok(started.ok, `先得真的挂上一条：${started.ok ? "" : started.error}`);
  const monitorId = started.ok ? started.monitor.id : "";
  // `stop_monitor` 不会取消已经攒进托盘的那几行（它们是已经发生的事实），所以这个组合
  // 必须放行 —— 否则「不要了 → stop_monitor → complete_task」这条出路自己走不通。
  await queueMonitorEvent(taskId, monitorId, "[12:00] 又一行进度");
  assert.ok(await stopMonitor(monitorId, "这条日志太吵，不看了"), "真接口停得掉");

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
  writeLostCompleteCall(taskId, sessId, turnStart);

  // 返回的 1 是「落了一笔可恢复的等待」，**不是**「补上了那份确认」—— 后者看
  // `complete_confirmed_at`，它必须还是空的（拦下来的那一笔一个字都不许落库）。
  await replayUndeliveredMcpCalls({ taskId, sessId, turnStart, agentType: "codex" });
  assert.equal(await confirmedAt(taskId), null, "挂着哨兵时补录也不许把确认写进来（F1 实测那一条）");

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

// ── ⑭b R2-4：撤哨兵那句话里的「有没有产出」读的是日志文件，不是投递游标 ───────────
{
  const taskId = await makeTask();
  const sessionId = await sessionWithTurn(taskId, new Date(Date.now() - 60_000).toISOString());
  const monitorId = await insertMonitorRow(taskId, { command: "tail -F build.log" });
  // **日志里有字、投递游标却是 0**：被终态/归档拒投、以及终态清理丢掉未投递缓冲，都正好
  // 长这样（第 2 轮审查 R2-4：`offset` 只在事件被接受投递时才推进，它不是产出证据）。
  const logPath = (await db.select({ p: monitors.logPath }).from(monitors)
    .where(eq(monitors.id, monitorId))).at(0)!.p;
  writeFileSync(logPath, "[12:00] 正在编译\n[12:01] 还在编译\n");
  await dropByActor(monitorId, "不等它了");

  assert.equal((await complete(taskId)).status, 200);
  const text = transcriptOf(sessionId, taskId);
  assert.match(text, /日志里有 \d+ 字节输出/, "日志里有字就不许说它一个字都没产出（R2-4）");
  assert.doesNotMatch(text, /日志文件也是空的/, "游标为 0 推不出「什么都没产出」");
}

// ── ⑭c R2-4 的另一半：日志压根读不出来时，照实说「说不准」──────────────────────
{
  const taskId = await makeTask();
  const sessionId = await sessionWithTurn(taskId, new Date(Date.now() - 60_000).toISOString());
  // 这条哨兵的日志文件从来没被创建过（创建期就夭折的那种）。
  const monitorId = await insertMonitorRow(taskId, { command: "tail -F nowhere.log" });
  await dropByActor(monitorId, "起都没起来");

  assert.equal((await complete(taskId)).status, 200);
  const text = transcriptOf(sessionId, taskId);
  assert.match(text, /读不出来/, "读不出来就说读不出来，不许当成「日志是空的」（R2-4）");
  assert.doesNotMatch(text, /日志文件也是空的/, "不许从读不到反推没产出");
}

// ── ⑮ R2-1：最后一关放行之后、终态行落库之前，一个哨兵都不许插进来 ─────────────
//
// 上一版这里是条真缝：结算先核阻塞物（放行），松手之后才写 `done` 那一行，审查探针在缝里
// 用真 `startMonitor` 起了一条 `sleep 45`，放开之后任务落 done、新哨兵被终态清理停掉
// （`OLD_F1_FINAL_SETTLEMENT_RACE {"startMonitor":true,"monitorAfter":"stopped"}`）。
// 现在那一关**核完就把闩置上**，所以这一节不必去抢那几毫秒：它直接站在缝里看。
{
  const taskId = await makeTask();
  await sessionWithTurn(taskId, new Date(Date.now() - 60_000).toISOString());
  assert.equal((await complete(taskId)).status, 200, "名下干净，先正常确认");

  assert.equal(await beginTerminalLanding(taskId), null, "没有阻塞物 ⇒ 最后一关放行");
  assert.equal(terminalLandingInFlight(taskId), true, "放行的同一把锁里必须把闩置上");

  const squeezed = await startMonitor({ taskId, command: "sleep 45", description: "缝里插进来的" });
  assert.equal(squeezed.ok, false, "正在落终态 ⇒ 这一刻挂不上哨兵（R2-1）");
  assert.match(squeezed.ok ? "" : squeezed.error, /正在落终态/, "拒绝文案要说清为什么");
  assert.equal(
    (await db.select().from(monitors).where(eq(monitors.taskId, taskId))).length, 0,
    "拒掉的创建一行都不许留下（命令也一个字都没跑）",
  );

  const settled = await settleTaskStatus(taskId, 0, null);
  assert.equal(settled.status, "done", "缝被焊上了，但正常路径照旧落 done");
  assert.equal(terminalLandingInFlight(taskId), false, "终态行落库之后闩必须撤掉");
}

// ── ⑯ 闩的另一半：落位不是终态时也要撤，否则这个任务被挡到闩过期 ───────────────
{
  const taskId = await makeTask();
  assert.equal(await beginTerminalLanding(taskId), null);
  assert.equal(terminalLandingInFlight(taskId), true);
  // 续聊回合核过闩之后恢复的可能是 paused/backlog 一类非终态 —— 只在终态分支撤闩的话，
  // 那一轮会把这个任务的哨兵创建挡到闩自己过期为止。
  await setTaskStatus(taskId, "paused");
  assert.equal(terminalLandingInFlight(taskId), false, "任何一次状态落库都撤闩");
  await setTaskStatus(taskId, "running");
  const after = await startMonitor({ taskId, command: "sleep 1", description: "撤闩之后" });
  assert.ok(after.ok, `撤闩之后照旧挂得上：${after.ok ? "" : after.error}`);
  if (after.ok) await stopMonitor(after.monitor.id, "用例收尾");
}

// ── ⑰ R2-1：补录被闸拦下 ⇒ 落可恢复的等待，而不是按「没交卷」记 failed ───────────
//
// 上一版拦下来就什么都不说，那一轮照旧按没交卷落 failed —— 而 failed 同样是终态，哨兵跟着
// 被收走（`OLD_F1_REPLAY_REJECTED_THEN_FAILED {"settlement":"failed","monitorAfter":"stopped"}`）。
// 它确实交了卷，只是那一笔丢在了断掉的通道里。
{
  const taskId = await makeTask();
  const sessId = `sess-blocked-${taskId}`;
  await sessionWithTurn(taskId, new Date(Date.now() - 60_000).toISOString(), { id: sessId });
  const monitorId = await insertMonitorRow(taskId, { command: "tail -F train.log" });
  const turnStart = "2026-10-20T05:11:00.000Z";
  writeLostCompleteCall(taskId, sessId, turnStart);

  await replayUndeliveredMcpCalls({ taskId, sessId, turnStart, agentType: "codex" });
  assert.equal(await confirmedAt(taskId), null, "拦下来的那一笔确认一个字都不许落库");
  const held = await taskRow(taskId);
  assert.ok(held.resumePrompt, "必须留下一段可恢复的等待（R2-1）");
  assert.equal(held.resumePromptAuto, true, "它要记着自己是系统写的，好在失效时被清掉");
  assert.match(
    transcriptOf(sessId, taskId), /通道中断/,
    "为什么这一轮变成了暂停，要在它自己那条会话上说清",
  );

  const settled = await settleTaskStatus(taskId, 0, null);
  assert.equal(settled.status, "paused", "落位是检查点暂停，不是 failed");
  assert.equal(await monitorStatus(monitorId), "running", "哨兵必须活着 —— 它等的结果还没来");
}

// ── ⑱ R2-1：原生命令回合（`/compact`）正常收尾也会收走哨兵 ⇒ 一样过闸 ────────────
{
  const taskId = await makeTask();
  await sessionWithTurn(taskId, new Date(Date.now() - 60_000).toISOString());
  const monitorId = await insertMonitorRow(taskId, { command: "tail -F deploy.log" });
  await db.update(tasks).set({ nativeTurn: true }).where(eq(tasks.id, taskId));

  const settled = await settleTaskStatus(taskId, 0, null);
  assert.equal(settled.status, "paused", "压缩一次上下文不该顺手把哨兵停掉（R2-1）");
  assert.equal(settled.nativeTurn, true, "它仍然是原生回合：结算钩子照旧整段跳过");
  assert.equal(await monitorStatus(monitorId), "running");
}

// ── ⑲ R2-1：续聊回合**没交卷**那一支也过闸（恢复终态跟落终态是同一件事）──────────
{
  const taskId = await makeTask();
  await sessionWithTurn(taskId, new Date(Date.now() - 60_000).toISOString());
  const monitorId = await insertMonitorRow(taskId, { command: "tail -F deploy.log" });
  await db.update(tasks).set({ followUpFrom: "done" }).where(eq(tasks.id, taskId));

  const settled = await settleTaskStatus(taskId, 0, null);
  assert.equal(settled.status, "paused", "恢复 done 会连坐停掉这一轮新挂的哨兵（R2-1）");
  assert.equal(await monitorStatus(monitorId), "running");
  assert.equal((await taskRow(taskId)).followUpFrom, null, "旁路身份要一起清掉");
}

// ── ⑲b 对称面：恢复的原状态**不是**终态时不许问闸（问了只会白写一段系统等待）────
{
  const taskId = await makeTask();
  await sessionWithTurn(taskId, new Date(Date.now() - 60_000).toISOString());
  const monitorId = await insertMonitorRow(taskId, { command: "tail -F deploy.log" });
  await db.update(tasks).set({ followUpFrom: "paused" }).where(eq(tasks.id, taskId));

  const settled = await settleTaskStatus(taskId, 0, null);
  assert.equal(settled.status, "paused", "原样恢复它本来的 paused");
  assert.equal(
    (await taskRow(taskId)).resumePrompt, null,
    "这一笔不碰哨兵，所以不该留下任何系统等待",
  );
  assert.equal(await monitorStatus(monitorId), "running");
}

// ── ⑳ ⑳b ⑳c ㉑ 检查点归属那一半（搬去 monitor-complete-checkpoint-groups.ts：
//    两份共用同一套台子，合在一个文件里超过 700 行的约定）────────────────────────────
await checkpointGroups();

// ── ㉒ R2-2：创建侧跟闸共用同一份判据 —— 属于活跃审查的新哨兵不该撤掉确认 ─────────
{
  const taskId = await makeTask();
  await reviewInFlight(taskId, "run-hold-spared", { round: 1 });
  runs.claimTurn(taskId, "reviewer", { run: "run-hold-spared", round: 1 });
  await db.update(tasks).set({ workflowMode: "free" }).where(eq(tasks.id, taskId));
  assert.equal((await complete(taskId)).status, 200, "审查豁免 ⇒ 确认放行");
  const confirmed = await confirmedAt(taskId);
  assert.notEqual(confirmed, null);

  const started = await startMonitor({
    taskId, command: "sleep 45", description: "审查还要等的那件事",
    caller: await inTurnCaller(taskId, "tok-spared"),
  });
  assert.ok(started.ok, `审查进行中就该挂得上：${started.ok ? "" : started.error}`);
  // 这条哨兵活得过这次完成（终态清理对它有豁免），所以它不是「会被这次完成毁掉的东西」——
  // 上一版无条件撤确认、写等待，把一次本不该被打断的收尾改成了暂停（R2-2 的同类实例）。
  assert.equal(started.ok ? started.notice ?? null : null, null, "没有东西要撤，就别跟它说撤了");
  assert.equal(await confirmedAt(taskId), confirmed, "那份确认必须原样留着");
  assert.equal((await taskRow(taskId)).resumePrompt, null, "也不该凭空写一段等待");
  runs.releaseTurn(taskId);
  if (started.ok) await stopMonitor(started.monitor.id, "用例收尾");
}

// ── ㉓ R2-3：已经跑完的哨兵，照提示用真 `stop_monitor` 放弃它的结果 ───────────────
//
// 实测走不通的那条出路：哨兵 `exited`、结果还排在待发送里，完成 409 并推荐 stop_monitor；
// 照做之后仍是 `exited` / `ended_by=system` / `pending=1`，再完成仍 409，文案还在重复推荐
// 同一个动作（`NEW_COMPLETED_RESULT_CANNOT_BE_DISCARDED`）。
{
  const taskId = await makeTask();
  const sessionId = await sessionWithTurn(taskId, new Date(Date.now() - 60_000).toISOString());
  const started = await startMonitor({ taskId, command: "printf 'RESULT_READY\\n'", description: "出一次结果就走" });
  assert.ok(started.ok, `先真起一条：${started.ok ? "" : started.error}`);
  const monitorId = started.ok ? started.monitor.id : "";
  await until("它自己跑完、并且结果还排在待发送里", async () =>
    await monitorStatus(monitorId) === "exited" && (await pendingOf(taskId)).length > 0);

  assert.equal((await complete(taskId)).status, 409, "出了结果没送到 ⇒ 先拦住（F2 那道保护不许撤）");

  assert.ok(await stopMonitor(monitorId, "这份结果不要了，换别的办法核对"), "停一条已经结束的哨兵不该 404");
  const row = (await db.select().from(monitors).where(eq(monitors.id, monitorId))).at(0)!;
  assert.equal(row.status, "exited", "结束事实一个字都不许改写 —— 它不是被停掉的");
  assert.notEqual(row.endedBy, "actor", "「谁让进程结束的」也不许被这一次改写");
  assert.ok(row.resultsAbandonedAt, "放弃凭证要单独落下来（R2-3）");
  assert.match(row.resultsAbandonedReason ?? "", /不要了/, "理由要留着：用户之后得看得出为什么放行了");
  assert.equal((await pendingOf(taskId)).length, 1, "放弃的是「必须先收下它」这条条件，不是那几行事件本身");
  assert.match(transcriptOf(sessionId, taskId), /不再等哨兵/, "已经结束的那种不会再走收尾播报，这里得补一行");

  assert.equal((await complete(taskId)).status, 200, "照提示做完之后，完成必须真的放得行（R2-3）");

  // 幂等：再点一次停，不改第一次的时刻与理由。
  const again = row.resultsAbandonedAt;
  await stopMonitor(monitorId, "手滑又点了一次");
  const after = (await db.select().from(monitors).where(eq(monitors.id, monitorId))).at(0)!;
  assert.equal(after.resultsAbandonedAt, again, "重复点停不许改写第一次的时刻");
  assert.match(after.resultsAbandonedReason ?? "", /不要了/, "也不许改写第一次的理由");
}

// ── ㉔ F1：哨兵正常跑完的那一瞬 —— 结局已写定、结束通知还没入队，照样拦得住 ──────────
//
// 这是第 1 轮审查（PUfD6pQBJUri）走穿的那条缝：结束是两件事（把行写成终态、把通知排进待
// 发送），上一版中间还隔着写时间线那一笔 await。那一瞬前两类判据都看不见它，于是完成放行、
// 任务落 done，紧接着的入队被终态挡回 —— 一条没有 stdout 的命令唯一能告诉执行者「等到了」
// 的通知就此蒸发（`F1_END_RESULT_HANDOFF {"statusAtSeam":"exited","pendingBefore":0,
// "completeHttp":200,"settlement":"done","messagesAfter":[]}`）。
//
// 台子怎么站进那条缝里：**让入队这一笔真的写不进去**（触发器 ABORT）。于是库里就是那一瞬
// 的样子 —— 行已经终态、托盘里一条消息都没有 —— 而凭证跟终态是同一条语句落的，闸看得见。
{
  const taskId = await makeTask();
  await sessionWithTurn(taskId, new Date(Date.now() - 60_000).toISOString());
  await db.run(
    "CREATE TRIGGER block_enqueue BEFORE INSERT ON scheduled_messages"
    + " BEGIN SELECT RAISE(ABORT, '注入:结束通知入不了队'); END" as never,
  );
  let monitorId = "";
  try {
    const started = await startMonitor({ taskId, command: "printf 'READY\n'", description: "一跑就完" });
    assert.ok(started.ok, `创建要成功：${started.ok ? "" : started.error}`);
    monitorId = started.ok ? started.monitor.id : "";
    await until("它自己跑完、终态已落库", async () => (await monitorStatus(monitorId)) === "exited");

    const seam = await monitorRow(monitorId);
    assert.ok(seam.resultHandoffAt, "结局已写定、通知还没入队 ⇒ 必须留着一笔闸看得见的责任（F1）");
    assert.match(seam.resultHandoffText ?? "", /哨兵结束/, "凭证里带着要送的原文，重启后才补得上");
    assert.equal((await pendingOf(taskId)).length, 0, "托盘确实还是空的 —— 台子正站在那条缝里");

    const res = await complete(taskId);
    assert.equal(res.status, 409, "缝里的完成必须被拦下（上一版这里是 200，结果就此蒸发）");
    assert.match(
      ((await res.json()) as { error?: string }).error ?? "", /正在送/,
      "拒绝文案要说清这是第三类（刚跑完、通知在路上），别让 agent 以为是「还在盯」",
    );
    assert.equal(await confirmedAt(taskId), null, "那一笔确认一个字都不许落库");
    // **最后一关同样站在这条缝上**：结算落终态之前问的是同一份判据（`beginTerminalLanding`
    // 返回非空 = 这一刻不许落终态）。这里直接问它，而不是跑整条结算 —— 那条路上「这一轮没
    // 交卷」本身就会落 failed（严格完成协议,见 settle-status.ts），测的就不是这道闸了。
    assert.match(
      await beginTerminalLanding(taskId) ?? "", /正在送/,
      "最后一关也拦得住，而且拦的理由是同一类",
    );
  } finally {
    await db.run("DROP TRIGGER block_enqueue" as never);
  }

  // 入队恢复之后：**启动重投把这笔交接做完**（凭证里有原文，所以进程死在中间也补得上）。
  // 分项统计（第 2 轮审查 N2）：送出去几条、几条已经无人可收、几条仍然失败，各算各的。
  assert.deepEqual(await redeliverResultHandoffs(), { delivered: 1, dropped: 0, failed: 0 },
    "有一笔没做完的交接要补,而且要算进「真送出去了」那一格");
  assert.match(
    (await pendingOf(taskId)).map((m) => m.text).join("\n"), /哨兵结束/,
    "结果真的到了任务头上 —— 这才是整条不变量要护的东西",
  );
  assert.equal((await monitorRow(monitorId)).resultHandoffAt, null, "送进托盘了就销凭证");
  // 凭证销了,但结果还排在托盘里 ⇒ 换第二类接着拦。两类之间没有空档,这正是 F1 的要求。
  assert.equal((await complete(taskId)).status, 409, "交接完了换「排着没送到」继续拦，中间没有空档");
  // 出路照旧走得通:明确放弃这份结果,完成就放行。
  assert.ok(await stopMonitor(monitorId, "结果我已经从日志看过了"), "放弃这份结果");
  assert.equal((await complete(taskId)).status, 200, "放弃之后放行 —— 闸不是永久锁");
}

// ── ㉔b F1 的结构锁：终态与交接凭证必须**同一条语句**落库 ─────────────────────────
//
// 上一节证明「缝里拦得住」，这一节钉住「压根没有缝」：触发器只盯这一条哨兵，一旦有人把这两
// 笔拆成两条 UPDATE（先写终态、再补凭证），第一条就会 ABORT —— 行停在 running，下面那个
// `until` 超时，当场失败。单测「凭证存在」是看不出这件事的。
{
  const taskId = await makeTask();
  await sessionWithTurn(taskId, new Date(Date.now() - 60_000).toISOString());
  const started = await startMonitor({ taskId, command: "printf 'ONE\n'", description: "原子性探针" });
  assert.ok(started.ok, `创建要成功：${started.ok ? "" : started.error}`);
  const monitorId = started.ok ? started.monitor.id : "";
  await db.run(
    `CREATE TRIGGER handoff_atomic AFTER UPDATE OF status ON monitors`
    + ` WHEN NEW.id = '${monitorId}' AND NEW.status <> 'running' AND NEW.result_handoff_at IS NULL`
    + " BEGIN SELECT RAISE(ABORT, '终态与交接凭证必须同一条语句落库'); END" as never,
  );
  try {
    await until(
      "终态连着凭证一起落库（拆成两笔的话这一步会一直等不到）",
      async () => (await monitorStatus(monitorId)) === "exited",
    );
    // **凭证在、或者通知已经送到,两者都算**:这一节的保证整个来自那个触发器 —— 拆成两笔的话
    // 第一笔就 ABORT,行压根落不上终态,上面那个 `until` 会超时。而「读到终态的这一刻凭证还在」
    // 是时序,不是不变量:收尾紧接着就会把这笔交接做完并销掉凭证(这条哨兵有 stdout,通知还会被
    // 合并进那条事件消息里)。上一版把时序当不变量断言,时序一变就假红。
    const landed = await monitorRow(monitorId);
    const delivered = (await pendingOf(taskId)).some((m) => /哨兵结束/.test(m.text));
    assert.ok(
      landed.resultHandoffAt || delivered,
      "落上终态就意味着那笔责任有人认:要么凭证还在,要么已经把通知送到了",
    );
  } finally {
    await db.run("DROP TRIGGER handoff_atomic" as never);
  }
  await stopMonitor(monitorId, "探针用完了");
}

// ── ㉘ 及后续：结果交接那一半（搬去 monitor-result-handoff-groups.ts，同一套台子）────
await resultHandoffGroups();

// ── ㉕ F3：旧方向的断线补录，一个字都不许写到新方向头上 ──────────────────────────
//
// 实测走穿的那条：补录在函数开头读到旧方向 → 排在任务锁后面 → 用户这期间改派了方向 → 它
// 拿到锁后先被哨兵闸拦下（那一支上一版压根不执行身份条件），接着**无条件**给当前方向补了
// 一段暂停指令（`F3_STALE_REPLAY_MUTATES_NEW_DIRECTION {"replayed":1,
// "activeDirection":"new-direction","promptInjected":true,"promptAuto":true}`）。
//
// 现在那段等待由同一个入口在**同一份身份 CAS**下落：方向换走了就是 0 行，整笔不生效。
{
  const taskId = await makeTask();
  const sessId = `sess-stale-${taskId}`;
  await sessionWithTurn(taskId, new Date(Date.now() - 60_000).toISOString(), { id: sessId });
  const monitorId = await insertMonitorRow(taskId, { command: "tail -F deploy.log" });
  const turnStart = "2026-10-20T07:30:00.000Z";
  writeLostCompleteCall(taskId, sessId, turnStart);
  await db.update(tasks)
    .set({ activeDirectionToken: "old-direction", activeDirectionVersion: 1 })
    .where(eq(tasks.id, taskId));

  // 先把任务锁占住,补录只能排在后面;占着的这段时间里把方向换掉 —— 这就是那个现场。
  let switched = false;
  const holder = serialize(`task:${taskId}`, async () => {
    await sleep(150);
    await db.update(tasks)
      .set({ activeDirectionToken: "new-direction", activeDirectionVersion: 2 })
      .where(eq(tasks.id, taskId));
    switched = true;
  });
  const replay = replayUndeliveredMcpCalls({ taskId, sessId, turnStart, agentType: "codex" });
  const [, replayed] = await Promise.all([holder, replay]);

  assert.ok(switched, "台子自检:方向确实在补录拿到锁之前就换掉了");
  assert.equal(replayed, 0, "旧方向的补录整笔不生效（它连「受阻」都不算，那是身份过期）");
  const after = await taskRow(taskId);
  assert.equal(after.resumePrompt, null, "新方向头上不许被补一段旧方向的暂停指令（F3）");
  assert.equal(after.resumePromptAuto, false, "更不许留下一个「系统写的」标记");
  assert.equal(after.completeConfirmedAt, null, "确认同样不许落");
  assert.equal(after.activeDirectionToken, "new-direction", "新方向原样留着");
  assert.equal(await monitorStatus(monitorId), "running");
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

  // 事后那句话只陈述能证实的两样：推了几条、**日志文件此刻多大** —— 一个字都不提「它等的
  // 条件」。第二个入参从前传的是 `offset`（投递游标），而那一列只在事件被接受投递时才推进：
  // 被终态/归档拒投、或者终态清理丢掉未投递缓冲时，日志里明明有字，它仍然是 0（第 2 轮审查
  // R2-4）。现在传的是 `statSync(logPath).size`，读不出来就老实说读不出来。
  assert.match(monitorEventTally(0, 0), /日志文件也是空的/, "0 事件 + 空文件：如实说两样都没有");
  assert.match(monitorEventTally(0, 128), /128 字节/, "文件里有字就把字数说出来");
  assert.match(monitorEventTally(0, 128), /没有一条送到这个任务头上/, "有输出但 0 事件要分得开");
  assert.match(monitorEventTally(0, null), /说不准/, "日志读不出来时不许替它断言有没有产出（R2-4）");
  assert.doesNotMatch(monitorEventTally(0, null), /空/, "读不出来 ≠ 空的");
  assert.doesNotMatch(monitorEventTally(0, 0), /条件/, "不许从没有输出推断业务条件没满足（F3）");
  assert.equal(monitorEventTally(3, 500), "共推送 3 条事件", "推出去过就照旧报数");
}

// 结算会甩出几件后台活（回合基线、待发送投递、时间线）。台子一关库它们就刷一屏
// 「database is not open」—— 噪声本身不是失败，但它会盖住真正的失败。所以先把还排在托盘里
// 的那几条清掉（它们是用例故意留下的「没送到的结果」，到这一步已经断言完了；留着的话投递
// 链会在回合空闲时去送、送不出去又要回填检查点，正好撞上已经关掉的库），再等余下的落完。
await db.delete(scheduledMessages);
await sleep(1200);
await teardown();
console.log("✓ 完成确认的哨兵闸");
