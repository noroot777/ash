// 哨兵结果的回合内交付(monitor-turn-handoff.ts):交出去、带回回执号才算送到(monitor-turn-ack.ts)、
// 收口时结清。「最后一批输出 + 结束」并成一次那一半在 test-monitor-merge-window.ts。
//
//  ① pause_task 那一刻结果已在托盘 ⇒ 不暂停、不记检查点,返回里带着结果和回执号;会话里一条带类型的记录
//  ② complete_task 被「结果排着没送到」拦下 ⇒ 随 409 交出去;带回回执号再调一次就过
//  ③ 两个出口撞在同一刻:恰好一个拿走
//  ④ 审查者的结果不会被执行回合收走
//  ⑤ 那一轮没正常收口 ⇒ 退回待发送,熬得过终态连坐、终态上等着(不作废)
//  ⑥ 开机那一扫:记号挂在没接回来的回合上 ⇒ 退回;⑥b 正常收口、却没带回回执号 ⇒ 退回
//  ⑧ 第 1 轮审查:挑完候选之后方向换了 ⇒ 一行都领不到(F2);扫描读到之后行换了领取者 ⇒ 不碰(F3);
//    老行认结束(N1)
//  ⑨ 领取之后出错、什么都没补上 ⇒ 拦着完成、回合里不再交、收口时退回(第 2 轮 1 / 第 4 轮 2);业务
//    拒绝里的结果正文写着 ECONNRESET ⇒ 补捞认得出是 ash 应答过的,不退回、不补录(第 2 轮 2)
//  ⑩ 第 3 轮审查:并发的两次 pause 不重复交、不换回执号(1);明确放弃了的「交过没确认」不拦完成、
//    审查等待那一侧同一份集合(2);不分执行器,带不回回执号的调用方不交(4)
//  ⑪ 第 4 轮审查:MCP 拿到了返回不算 agent 收到 —— 不带回回执号,完成照样拦着(1);过多久都不在回合里
//    重交、迟到的回执号照样认(2);断线补录的那次调用里带着的回执号也认
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { ASH_TURN_IDENTITY_ENV } from "@ash/shared/mcp";
import { db, monitors, now, pending, pendingOf, reviewInFlight, root, runs, scheduledMessages, tasks, teardown } from "./monitors-fixture.js";
import { api, liveTurn, notices, onSelect, post, queuedResult, rowOf, sleep, taskOf } from "./monitor-turn-handoff-fixture.js";
import {
  handMonitorResultsOnPause, returnOrphanTurnHandoffs, settleTurnHandoffs,
} from "../src/monitor-turn-handoff.js";
import { confirmHandoffs } from "../src/monitor-turn-ack.js";
import { answeredMcpError, isUndeliveredMcpFailure } from "@ash/shared/mcp-delivery";
import { detachedPathsFor } from "../src/executors/detached.js";
import { replayUndeliveredMcpCalls } from "../src/mcp-handoff.js";
import { RUNS_DIR } from "../src/paths.js";
import { unsettledMonitorResponsibility } from "../src/monitor-responsibility.js";
import { settleTaskStatus } from "../src/settle-status.js";
import { deliveryVerdict } from "../src/pending-verdict.js";
import { id } from "../src/util.js";

/** 把那一次交付挪到很久以前:回合里过多久都不重交(第 4 轮审查 2)。 */
const age = (messageId: string) => db.update(scheduledMessages)
  .set({ turnHandoff: sql`json_set(${scheduledMessages.turnHandoff}, '$.at', ${new Date(Date.now() - 600_000).toISOString()})` })
  .where(eq(scheduledMessages.id, messageId));

try {
  // ── ① pause_task:结果已到 ⇒ 不暂停,当场交出 ──────────────────────────────────
  {
    const { taskId, token, owner, sessionId } = await liveTurn();
    const result = await queuedResult(taskId, "RESULT_READY_PAUSE");
    const res = await post(`/tasks/${taskId}/pause`, token, { resumePrompt: "继续：等结果" });
    assert.equal(res.status, 200);
    const body = await res.json() as { paused: boolean; note: string; monitorResults: string; monitorResultsReceipt: string };
    assert.equal(body.paused, false, "没有暂停");
    assert.match(body.note, /没有暂停/);
    assert.match(body.monitorResults, /RESULT_READY_PAUSE/, "结果原文随返回交出");
    assert.match(body.monitorResultsReceipt, /^[0-9a-f]{12}$/, "带着这一次的回执号");
    assert.ok(body.note.includes(`monitorReceipt="${body.monitorResultsReceipt}"`), "返回里那句话告诉它怎么带回来");
    assert.equal((await rowOf(result.id)).turnHandoff?.ackedAt, undefined, "带回来之前不算送到");
    assert.equal((await taskOf(taskId)).resumePrompt, null, "不记检查点");
    const after = await rowOf(result.id);
    assert.equal(after.status, "sent");
    assert.equal(after.turnTakenBy, token, "记下交给了哪一轮");
    assert.equal((await pendingOf(taskId)).length, 0, "托盘里不再排着");
    const handed = notices(taskId, sessionId).find((n) => n.kind === "monitor.handed") as
      { kind: string; via: string; monitorWake: { events: Array<{ monitorId: string; kind: string; body: string }> } } | undefined;
    assert.ok(handed, "会话里有一条带类型的记录");
    assert.equal(handed!.via, "pause");
    assert.deepEqual(handed!.monitorWake.events.map((e) => [e.monitorId, e.kind]), [[result.monitorId, "ended"]]);
    // 托盘空了之后再调 = 老路:记检查点、这一轮会落 paused。
    // 这一次带回回执号 ⇒ 确认落在行上。
    const again = await post(`/tasks/${taskId}/pause`, token,
      { resumePrompt: "继续：别的", monitorReceipt: body.monitorResultsReceipt });
    assert.equal(((await again.json()) as { paused: boolean }).paused, true);
    assert.ok((await rowOf(result.id)).turnHandoff?.ackedAt, "确认落在行上");
    // 正常收口(留了检查点)且确认过 ⇒ 送达,记号销掉。
    await settleTurnHandoffs(taskId, token, true);
    const settled = await rowOf(result.id);
    assert.equal(settled.status, "sent");
    assert.equal(settled.turnTakenBy, null);
    runs.releaseTurn(taskId, owner);
  }

  // ── ② complete_task:被排着的结果拦下 ⇒ 随 409 交出;再调一次就过 ───────────────
  {
    const { taskId, token, owner } = await liveTurn();
    const result = await queuedResult(taskId, "RESULT_READY_COMPLETE");
    const first = await post(`/tasks/${taskId}/complete`, token);
    assert.equal(first.status, 409, "这一次不算确认");
    const body = await first.json() as { error: string; monitorResults: string; monitorResultsReceipt: string };
    assert.match(body.error, /没有生效/);
    assert.match(body.error, /再调一次 complete_task/, "没剩别的就直说再调一次(刚交的这几行不算进那句话)");
    assert.match(body.monitorResults, /RESULT_READY_COMPLETE/);
    assert.equal((await taskOf(taskId)).completeConfirmedAt, null);
    assert.equal((await rowOf(result.id)).status, "sent");
    assert.equal((await post(`/tasks/${taskId}/complete`, token)).status, 409, "没带回回执号 ⇒ 照样拦着");
    const second = await post(`/tasks/${taskId}/complete`, token, { monitorReceipt: body.monitorResultsReceipt });
    assert.equal(second.status, 200, "带回回执号 = 它读到了 ⇒ 闸放行");
    assert.ok((await taskOf(taskId)).completeConfirmedAt);
    await settleTurnHandoffs(taskId, token, true);
    assert.equal((await rowOf(result.id)).turnTakenBy, null, "交卷收口 ⇒ 送达");
    runs.releaseTurn(taskId, owner);
  }

  // ── ③ 两个出口撞在同一刻:恰好一个拿走 ────────────────────────────────────────
  for (let i = 0; i < 5; i += 1) {
    const { taskId, token, owner } = await liveTurn();
    const result = await queuedResult(taskId, `RACE_${i}`);
    const [handed, leased] = await Promise.all([
      handMonitorResultsOnPause(taskId, token, [eq(tasks.status, "running")]),
      pending.beginDelivery(result.id),
    ]);
    assert.equal(!!handed !== !!leased, true, `第 ${i} 次:只许一条路拿到`);
    const row = await rowOf(result.id);
    if (handed) assert.equal(row.deliveringSince, null);
    else assert.equal(row.status, "pending");
    if (handed) assert.equal(await confirmHandoffs(taskId, token, [handed.hand]), 1);
    await settleTurnHandoffs(taskId, token, true);
    runs.releaseTurn(taskId, owner);
  }

  // ── ④ 审查者挂的哨兵:执行回合收不走 ──────────────────────────────────────────
  {
    const { taskId, token, owner } = await liveTurn();
    await reviewInFlight(taskId, `run-${taskId}`, { round: 1 });
    const result = await queuedResult(taskId, "REVIEWER_ONLY", { reviewer: { run: `run-${taskId}`, round: 1 } });
    const res = await post(`/tasks/${taskId}/pause`, token, { resumePrompt: "继续" });
    assert.equal(((await res.json()) as { paused: boolean }).paused, true, "照老路暂停");
    const row = await rowOf(result.id);
    assert.equal(row.status, "pending");
    assert.equal(row.turnTakenBy, null);
    runs.releaseTurn(taskId, owner);
  }

  // ── ⑤ 没正常收口 ⇒ 退回,终态连坐收不走它 ─────────────────────────────────────
  for (const [label, exit, stopped] of [["崩掉", 1, null], ["被停", 0, "canceled"]] as const) {
    const { taskId, token, owner } = await liveTurn();
    const result = await queuedResult(taskId, `RETURNED_${label}`);
    assert.ok(await handMonitorResultsOnPause(taskId, token, []));
    const settled = await settleTaskStatus(taskId, exit, stopped);
    assert.ok(["failed", "canceled"].includes(settled.status), `${label}:落 ${settled.status}`);
    runs.releaseTurn(taskId, owner);
    await sleep(800);   // 终态钩子:哨兵连坐 + 托盘扫描(都在后台)
    const row = await rowOf(result.id);
    assert.equal(row.status, "pending", `${label}:回到托盘,没被作废`);
    assert.ok(row.turnReturnedAt, `${label}:带着退回记号`);
    assert.equal(row.turnTakenBy, null);
    assert.deepEqual(
      deliveryVerdict(row, { mode: "single", status: settled.status, archived: false }, new Date()),
      { action: "wait" }, `${label}:终态上等下一次起跑`,
    );
    // 下一次起跑:这一轮调 pause_task 时它又会被交出来。
    await db.update(tasks).set({ status: "running" }).where(eq(tasks.id, taskId));
    const next = runs.claimOwnTurn(taskId, "single");
    const nextToken = `turn-${id()}`;
    await db.update(tasks).set({ activeTurnToken: nextToken }).where(eq(tasks.id, taskId));
    runs.bindTurnToken(taskId, nextToken);
    const res = await post(`/tasks/${taskId}/pause`, nextToken, { resumePrompt: "继续" });
    const again = (await res.json()) as { monitorResults?: string; monitorResultsReceipt?: string };
    assert.match(again.monitorResults ?? "", new RegExp(`RETURNED_${label}`));
    assert.equal(await confirmHandoffs(taskId, nextToken, [again.monitorResultsReceipt!]), 1);
    await settleTurnHandoffs(taskId, nextToken, true);
    runs.releaseTurn(taskId, next!);
  }
  // 没有退回记号的普通结果在终态上照旧作废(这条行为不动)。
  assert.equal(
    deliveryVerdict({ mode: "queued", sendAt: now(), origin: "monitor:x" }, { mode: "single", status: "failed", archived: false }, new Date()).action,
    "cancel",
  );

  // ── ⑥ 开机那一扫:回合没接回来 ⇒ 退回 ────────────────────────────────────────
  {
    const { taskId, token, owner } = await liveTurn();
    const result = await queuedResult(taskId, "ORPHAN");
    assert.ok(await handMonitorResultsOnPause(taskId, token, []));
    assert.equal(await returnOrphanTurnHandoffs(), 0, "回合还占着 ⇒ 不动");
    runs.releaseTurn(taskId, owner);
    assert.equal(await returnOrphanTurnHandoffs(), 1);
    const row = await rowOf(result.id);
    assert.equal(row.status, "pending");
    assert.ok(row.turnReturnedAt);
  }

  // ── ⑥b 正常收口、却没带回回执号(返回没回到它手上)⇒ 退回 ───────────────────────────
  {
    const { taskId, token, owner } = await liveTurn();
    const result = await queuedResult(taskId, "NO_RECEIPT");
    assert.ok(await handMonitorResultsOnPause(taskId, token, []));
    await settleTurnHandoffs(taskId, token, true);
    const row = await rowOf(result.id);
    assert.equal(row.status, "pending", "回到托盘");
    assert.ok(row.turnReturnedAt);
    assert.equal(row.turnTakenBy, null);
    assert.equal(row.turnHandoff, null);
    runs.releaseTurn(taskId, owner);
    await db.update(scheduledMessages).set({ status: "canceled" }).where(eq(scheduledMessages.id, result.id));
  }

  // ── ⑧/⑨-1 领取之后那一步出错(而且什么都不补)⇒ 没确认:拦着完成、回合里不再交,收口时退回 ────
  for (const ending of ["再调一次", "直接收口"] as const) {
    const { taskId, token, owner } = await liveTurn();
    const result = await queuedResult(taskId, `MUST_READ_${ending}`);
    // 领取之后、返回构造之前:复核来源审查那一问读哨兵行。在这里抛 = 领取已经落库、返回没构造成。
    let injected = false;
    const restore = onSelect(monitors, (p) => !!p && "reviewGeneration" in p && !("cls" in p), async (rows) => {
      if (injected || (await rowOf(result.id)).status !== "sent") return rows;
      injected = true;
      throw new Error("注入:领取之后出错");
    });
    const first = await post(`/tasks/${taskId}/complete`, token);
    restore();
    assert.ok(injected, "注入点真的落在领取之后");
    assert.equal(first.status, 500);
    const held = await rowOf(result.id);
    assert.equal(held.status, "sent", "没有任何补偿写入:停在「交了、没确认」");
    if (ending === "再调一次") {
      const second = await post(`/tasks/${taskId}/complete`, token);
      assert.equal(second.status, 409, "没确认 ⇒ 照样拦下(第 2 轮审查 1:第二次不许直接完成)");
      const inflight = (await second.json()) as { error: string; monitorResults?: string };
      assert.equal(inflight.monitorResults, undefined, "回合里不再交第二遍");
      assert.match(inflight.error, /还没带回回执号/);
      await age(result.id);
      const later = (await (await post(`/tasks/${taskId}/complete`, token)).json()) as { monitorResults?: string };
      assert.equal(later.monitorResults, undefined, "过了多久都不重交:慢不等于丢(第 4 轮审查 2)");
      // 它没见过那次返回 ⇒ 走 pause_task 收尾,收口时退回、唤醒那一路再送。
      const paused = await post(`/tasks/${taskId}/pause`, token, { resumePrompt: "继续" });
      assert.equal(((await paused.json()) as { paused: boolean }).paused, true);
      await settleTurnHandoffs(taskId, token, true);
      const back = await rowOf(result.id);
      assert.equal(back.status, "pending", "没确认 ⇒ 退回");
      assert.ok(back.turnReturnedAt);
      await db.update(scheduledMessages).set({ status: "canceled" }).where(eq(scheduledMessages.id, result.id));
    } else {
      await settleTurnHandoffs(taskId, token, true);
      const back = await rowOf(result.id);
      assert.equal(back.status, "pending", "正常收口也不算送达:没确认就退回");
      assert.ok(back.turnReturnedAt);
      await db.update(scheduledMessages).set({ status: "canceled" }).where(eq(scheduledMessages.id, result.id));
    }
    runs.releaseTurn(taskId, owner);
  }

  // ── ⑨-2 业务拒绝里的结果正文写着 ECONNRESET ⇒ 补捞认得出是 ash 应答过的 ───────────────
  {
    const { taskId, token, owner, sessionId } = await liveTurn();
    const result = await queuedResult(taskId, "ECONNRESET while running remote command");
    const first = await post(`/tasks/${taskId}/complete`, token);
    assert.equal(first.status, 409);
    const body = await first.json() as { error: string; monitorResults: string; monitorResultsReceipt: string };
    assert.equal(await confirmHandoffs(taskId, token, [body.monitorResultsReceipt]), 1);
    // MCP 端交给 agent 的那段话(`failWithMonitorResults` 的形状),agent 随后调了 pause_task、成功了。
    const rendered = answeredMcpError(409, "POST", `/tasks/${taskId}/complete`, `${body.error}\n\n${body.monitorResults}`);
    assert.equal(isUndeliveredMcpFailure({ message: rendered }), false, "ash 应答过的拒绝不算没送达");
    const turnStart = now();
    const out = detachedPathsFor(join(RUNS_DIR, taskId), sessionId, turnStart).out;
    const call = (useId: string, name: string) => JSON.stringify({ type: "assistant", message: { content: [
      { type: "tool_use", id: useId, name: `mcp__ash__${name}`, input: { taskId, resumePrompt: "继续" } }] } });
    const reply = (useId: string, isError: boolean, text: string) => JSON.stringify({ type: "user", message: { content: [
      { type: "tool_result", tool_use_id: useId, is_error: isError, content: text }] } });
    mkdirSync(join(RUNS_DIR, taskId), { recursive: true });
    appendFileSync(out, [call("u1", "complete_task"), reply("u1", true, rendered),
      call("u2", "pause_task"), reply("u2", false, "{\"paused\":true}")].join("\n") + "\n");
    assert.equal(await replayUndeliveredMcpCalls({ taskId, sessId: sessionId, turnStart, agentType: "claude" }), 0,
      "不替它补录 complete_task(它后来要的是暂停)");
    assert.equal((await taskOf(taskId)).completeConfirmedAt, null);
    const row = await rowOf(result.id);
    assert.equal(row.status, "sent", "交过的结果没被退回");
    assert.equal(row.turnTakenBy, token);
    await settleTurnHandoffs(taskId, token, true);
    assert.equal((await rowOf(result.id)).turnTakenBy, null, "确认过 ⇒ 送达,不再叫醒一次");
    runs.releaseTurn(taskId, owner);
  }

  // ── ⑩-1 并发的两次 pause_task:只有一次交出去、回执号不被换掉;错号/别的回合确认不到 ──────────
  {
    const { taskId, token, owner } = await liveTurn();
    const result = await queuedResult(taskId, "CONCURRENT_PAUSE");
    const replies = await Promise.all([1, 2].map(async (n) => (await post(`/tasks/${taskId}/pause`, token,
      { resumePrompt: `继续 ${n}` })).json() as Promise<{ paused: boolean; monitorResults?: string; monitorResultsReceipt?: string }>));
    const handed = replies.filter((b) => b.monitorResults !== undefined);
    assert.equal(handed.length, 1, "同一批结果只交一次");
    assert.match(handed[0]!.monitorResults!, /CONCURRENT_PAUSE/);
    assert.equal(replies.find((b) => b.monitorResults === undefined)!.paused, true, "另一次照老路记检查点");
    const row = await rowOf(result.id);
    assert.equal(row.turnHandoff?.hand, handed[0]!.monitorResultsReceipt, "回执号还是交出去的那一个");
    await age(result.id);
    assert.equal(await handMonitorResultsOnPause(taskId, token, []), null, "过了多久都不再交");
    const hand = handed[0]!.monitorResultsReceipt!;
    assert.equal(await confirmHandoffs(taskId, token, ["0123456789ab"]), 0, "别的号确认不到");
    assert.equal(await confirmHandoffs(taskId, "turn-other", [hand]), 0, "别的回合带回来的不算");
    assert.equal(await confirmHandoffs(taskId, token, [hand]), 1, "迟到多久的回执号都照样认");
    assert.equal(await confirmHandoffs(taskId, token, [hand]), 0, "确认只落一次");
    await settleTurnHandoffs(taskId, token, true);
    assert.equal((await rowOf(result.id)).turnTakenBy, null, "确认过 + 正常收口 ⇒ 送达");
    runs.releaseTurn(taskId, owner);
  }

  // ── ⑩-2 「交过、没确认」跟「排着没送到」同一套规则:放弃了就不拦、不再交;审查那一侧一样认得 ──
  {
    const { taskId, token, owner } = await liveTurn();
    const result = await queuedResult(taskId, "ABANDONED_AFTER_HAND");
    const handed = await handMonitorResultsOnPause(taskId, token, []);
    assert.ok(handed);
    const classes = async () => (await unsettledMonitorResponsibility(db, taskId)).map((r) => [r.cls, r.messageId]);
    assert.deepEqual(await classes(), [["handed", result.id]], "责任集合里是第四类");
    assert.equal((await post(`/tasks/${taskId}/complete`, token)).status, 409, "没确认就拦着");
    await db.update(monitors).set({ resultsAbandonedAt: now() }).where(eq(monitors.id, result.monitorId));
    assert.deepEqual(await classes(), [], "明确放弃了 ⇒ 不再是未了结的责任");
    const done = await post(`/tasks/${taskId}/complete`, token);
    assert.equal(done.status, 200, "放弃了的不拦完成");
    assert.equal(((await done.json()) as { monitorResults?: string }).monitorResults, undefined, "也不再交");
    runs.releaseTurn(taskId, owner);
    await db.update(scheduledMessages).set({ status: "canceled" }).where(eq(scheduledMessages.id, result.id));
  }

  // ── ⑩-4 不分执行器:gemini 的回合照样交;带不回回执号的调用方(升级前的 MCP)不交 ───────────
  {
    const { taskId, token, owner } = await liveTurn({ agentType: "gemini" });
    const result = await queuedResult(taskId, "ANY_EXECUTOR");
    const legacy = await post(`/tasks/${taskId}/pause`, token, { resumePrompt: "继续", monitorAck: false });
    assert.equal(((await legacy.json()) as { paused: boolean }).paused, true, "没声明会确认 ⇒ 照老路暂停");
    assert.equal((await rowOf(result.id)).status, "pending");
    await db.update(tasks).set({ resumePrompt: null }).where(eq(tasks.id, taskId));
    const res = await post(`/tasks/${taskId}/pause`, token, { resumePrompt: "继续" });
    const body = (await res.json()) as { paused: boolean; monitorResults?: string; monitorResultsReceipt?: string };
    assert.equal(body.paused, false, "gemini 的回合也交");
    assert.match(body.monitorResults ?? "", /ANY_EXECUTOR/);
    assert.equal(await confirmHandoffs(taskId, token, [body.monitorResultsReceipt!]), 1);
    await settleTurnHandoffs(taskId, token, true);
    runs.releaseTurn(taskId, owner);
  }

  // ── ⑪-1 真 MCP 那一侧:pause_task 工具拿到返回、交给执行器 —— MCP 收到不算 agent 收到 ────────────
  // 第 4 轮审查 1 的现场:MCP 拿到了返回(这里是工具函数真的返回了),agent 却没再带回回执号 ⇒ 完成
  // 照样拦着;带回来(同一个工具、`monitorReceipt`)才放行。
  {
    const token = `turn-${id()}`;
    const server = serve({ fetch: new Hono().route("/api", api).fetch, hostname: "127.0.0.1", port: 0 });
    await new Promise((resolve) => server.once("listening", resolve));
    process.env.ASH_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    process.env[ASH_TURN_IDENTITY_ENV.turnToken] = token;
    const { taskId, owner } = await liveTurn({ token, agentType: "opencode" });
    const result = await queuedResult(taskId, "VIA_REAL_MCP");
    const handlers = new Map<string, (args: Record<string, unknown>) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>>();
    const { registerTaskTurnTools } = await import("../../mcp/src/tools/task-turn.js");
    registerTaskTurnTools({
      registerTool(name: string, _config: unknown, handler: never) { handlers.set(name, handler); },
    } as never);
    const out = await handlers.get("pause_task")!({ taskId, resumePrompt: "继续", directionToken: "" });
    assert.match(out.content[0]!.text, /没有暂停[\s\S]*VIA_REAL_MCP/, "执行器拿到的是摊开的结果");
    assert.equal((await rowOf(result.id)).turnHandoff?.ackedAt, undefined, "MCP 拿到了不算 agent 收到");
    const blocked = await handlers.get("complete_task")!({ taskId, directionToken: "" });
    assert.equal(blocked.isError, true, "没带回回执号 ⇒ 完成照样拦着");
    const hand = /monitorReceipt="([0-9a-f]{12})"/.exec(out.content[0]!.text)?.[1];
    assert.ok(hand, "回执号就在它读到的那段话里");
    const done = await handlers.get("complete_task")!({ taskId, directionToken: "", monitorReceipt: hand });
    server.close();
    assert.notEqual(done.isError, true, "带回回执号 ⇒ 放行");
    assert.ok((await rowOf(result.id)).turnHandoff?.ackedAt);
    await settleTurnHandoffs(taskId, token, true);
    assert.equal((await rowOf(result.id)).turnTakenBy, null);
    runs.releaseTurn(taskId, owner);
  }

  // ── ⑪-2 断线补录:那次 complete_task 带着回执号、通道断了 ⇒ 补录时回执号一起认 ────────────────
  {
    const { taskId, token, owner, sessionId } = await liveTurn();
    const result = await queuedResult(taskId, "REPLAYED_RECEIPT");
    const handed = await handMonitorResultsOnPause(taskId, token, []);
    assert.ok(handed);
    const turnStart = now();
    const out = detachedPathsFor(join(RUNS_DIR, taskId), sessionId, turnStart).out;
    mkdirSync(join(RUNS_DIR, taskId), { recursive: true });
    appendFileSync(out, [
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "c1", name: "mcp__ash__complete_task",
        input: { taskId, monitorReceipt: handed!.hand } }] } }),
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "c1", is_error: true,
        content: "连不上 ash server：fetch failed ECONNREFUSED" }] } }),
    ].join("\n") + "\n");
    assert.equal(await replayUndeliveredMcpCalls({ taskId, sessId: sessionId, turnStart, agentType: "claude" }), 1);
    assert.ok((await rowOf(result.id)).turnHandoff?.ackedAt, "补录的那次调用里带着的回执号照样认");
    assert.ok((await taskOf(taskId)).completeConfirmedAt, "认了之后闸放行、确认落库");
    await settleTurnHandoffs(taskId, token, true);
    runs.releaseTurn(taskId, owner);
  }

  // ── ⑧ F2:挑完候选之后方向换了 ⇒ 领取那一笔一行都改不到 ─────────────────────────
  {
    const { taskId, token, owner } = await liveTurn();
    await db.update(tasks).set({ activeDirectionToken: "dir-A" }).where(eq(tasks.id, taskId));
    const result = await queuedResult(taskId, "DIRECTION_RACE");
    let steered = false;
    const restore = onSelect(tasks, (p) => !!p && Object.keys(p).length === 1 && p.id === tasks.id, async (rows) => {
      if (!steered) {
        steered = true;
        await db.update(tasks).set({ activeDirectionToken: "dir-B" }).where(eq(tasks.id, taskId));
      }
      return rows;
    });
    const res = await post(`/tasks/${taskId}/pause`, token, { resumePrompt: "继续" }, { "x-ash-direction-token": "dir-A" });
    restore();
    assert.ok(steered, "方向是在资格那一问之后换的");
    const body = await res.json() as { paused?: boolean; monitorResults?: string };
    assert.equal(body.monitorResults, undefined, "过期请求拿不到结果");
    assert.notEqual(body.paused, false);
    const row = await rowOf(result.id);
    assert.equal(row.status, "pending");
    assert.equal(row.turnTakenBy, null);
    runs.releaseTurn(taskId, owner);
    await db.update(scheduledMessages).set({ status: "canceled" }).where(eq(scheduledMessages.id, result.id));
  }

  // ── ⑧ F3:扫描读到之后,那一行换了领取者 ⇒ 退回按当时的领取者 CAS,不碰新一轮的 ──────
  {
    const { taskId, token, owner } = await liveTurn();
    const result = await queuedResult(taskId, "ABA");
    assert.ok(await handMonitorResultsOnPause(taskId, token, []));
    runs.releaseTurn(taskId, owner);
    const next = runs.claimOwnTurn(taskId, "single");
    const nextToken = `turn-${id()}`;
    runs.bindTurnToken(taskId, nextToken);
    // 生产上领取与扫描排在同一条队列里,这条缝只能硬造:扫描读到旧领取者之后,行换成新一轮的。
    let swapped = false;
    const restore = onSelect(scheduledMessages, (p) => !!p && "by" in p && "id" in p, async (rows) => {
      if (!swapped && (rows as Array<{ id: string }>).some((m) => m.id === result.id)) {
        swapped = true;
        await db.update(scheduledMessages).set({ turnTakenBy: nextToken }).where(eq(scheduledMessages.id, result.id));
      }
      return rows;
    });
    const returned = await returnOrphanTurnHandoffs();
    restore();
    assert.ok(swapped);
    assert.equal(returned, 0, "旧快照里的领取者已经不是它了");
    const row = await rowOf(result.id);
    assert.equal(row.status, "sent");
    assert.equal(row.turnTakenBy, nextToken, "新一轮的领取原样留着");
    await settleTurnHandoffs(taskId, nextToken, true);
    runs.releaseTurn(taskId, next!);
  }

  // ── ⑧ N1:升级前没有结构的老行,正文带结束抬头 ⇒ 记成结束 ────────────────────────
  {
    const { taskId, token, owner, sessionId } = await liveTurn();
    const result = await queuedResult(taskId, "【哨兵结束】老哨兵（monitorId=x），退出码 0");
    await db.update(scheduledMessages).set({ monitorWake: null }).where(eq(scheduledMessages.id, result.id));
    assert.ok(await handMonitorResultsOnPause(taskId, token, []));
    const handed = notices(taskId, sessionId).find((n) => n.kind === "monitor.handed") as
      { monitorWake: { events: Array<{ kind: string }> } } | undefined;
    assert.deepEqual(handed?.monitorWake.events.map((e) => e.kind), ["ended"]);
    await settleTurnHandoffs(taskId, token, true);
    runs.releaseTurn(taskId, owner);
  }

  console.log("monitor turn handoff ok");
} finally {
  await teardown();
}
