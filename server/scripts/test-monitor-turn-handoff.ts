// 哨兵结果的回合内交付(monitor-turn-handoff.ts)与「最后一批输出 + 结束」并成一次(monitor-events.ts
// 的 `deferFlush`),外加三条哨兵时间线记录带上 monitorId。
//
//  ① pause_task 那一刻结果已在托盘 ⇒ 不暂停、不记检查点,返回里带着结果;会话里一条带类型的记录
//  ② complete_task 被「结果排着没送到」拦下 ⇒ 随 409 交出去;再调一次就过
//  ③ 两个出口撞在同一刻:恰好一个拿走
//  ④ 审查者的结果不会被执行回合收走
//  ⑤ 那一轮没正常收口 ⇒ 退回待发送,熬得过终态连坐、终态上等着(不作废)
//  ⑥ 开机那一扫:记号挂在没接回来的回合上 ⇒ 退回;⑥b 断线补录之前同样退回
//  ⑦ 空闲任务上 `echo A; exit 0` / 命中 stopWhen:一条消息、两类事件、一次唤醒
//  ⑧ 第 1 轮审查:领取之后出错 ⇒ 退回、再调一次照交(F1);挑完候选之后方向换了 ⇒ 一行都领不到
//    (F2);扫描读到之后行换了领取者 ⇒ 不碰(F3);合并窗口里别的触发源领不走(F4);老行认结束(N1)
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { appendMonitorWake } from "@ash/shared/monitor-wake";
import {
  db, makeTask, monitors, now, pending, pendingOf, reviewInFlight, root, runs, scheduledMessages,
  sessions, startMonitor, tasks, teardown, until,
} from "./monitors-fixture.js";
import { installFakeClaude } from "./scheduled-messages-fixture.js";
import { mountTaskRunRoutes } from "../src/task-run-routes.js";
import {
  handMonitorResultsOnPause, returnOrphanTurnHandoffs, returnTurnHandoffs, settleTurnHandoffs,
} from "../src/monitor-turn-handoff.js";
import { settleTaskStatus } from "../src/settle-status.js";
import { deliveryVerdict } from "../src/pending-verdict.js";
import { sessionTranscriptPath, TURN_SENTINEL } from "../src/transcript.js";
import { id } from "../src/util.js";

type Row = typeof scheduledMessages.$inferSelect;
const log = join(root, "turn-handoff-input.log");
process.env.PATH = `${installFakeClaude(root)}${delimiter}${process.env.PATH ?? ""}`;
process.env.ASH_ALLOW_REAL_AGENT = "1";
process.env.ASH_TEST_LEAD_LOG = log;

const api = new Hono();
mountTaskRunRoutes(api);
const post = (path: string, token: string, body: unknown = {}, headers: Record<string, string> = {}) => api.request(path, {
  method: "POST", headers: { "content-type": "application/json", "x-ash-turn-token": token, ...headers },
  body: JSON.stringify(body),
});

/**
 * 在生产代码某一次 `db.select(<投影>).from(<表>)` 出结果之后先做一件事(可以抛错、可以改库),
 * 用来站进「读完、还没写」那条缝里。`pick` 按投影认是哪一次;返回撤掉这层的函数。
 */
function onSelect(
  table: unknown, pick: (projection: Record<string, unknown> | undefined) => boolean,
  act: (rows: unknown[]) => Promise<unknown[]>,
): () => void {
  const original = db.select.bind(db);
  (db as { select: unknown }).select = (...args: unknown[]) => {
    const query = (original as (...a: unknown[]) => { from: (t: unknown) => unknown })(...args);
    const from = query.from.bind(query);
    query.from = (t: unknown) => {
      const builder = from(t) as { then: (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise<unknown> };
      if (t !== table || !pick(args[0] as Record<string, unknown> | undefined)) return builder;
      const then = builder.then.bind(builder);
      builder.then = (ok, ko) => then((rows) => act(rows as unknown[])).then(ok, ko);
      return builder;
    };
    return query;
  };
  return () => { (db as { select: unknown }).select = original; };
}
const rowOf = async (messageId: string) =>
  (await db.select().from(scheduledMessages).where(eq(scheduledMessages.id, messageId))).at(0)!;
const taskOf = async (taskId: string) => (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0)!;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 一条正在跑的执行回合:回合锁 + 令牌落库并绑上 + 一条会话(时间线落在它上面)。 */
async function liveTurn(opts: { role?: string; review?: { run: string; round: number } } = {}) {
  const taskId = await makeTask();
  const owner = runs.claimOwnTurn(taskId, opts.role ?? "single", opts.review ?? null);
  assert.ok(owner, "占得到回合");
  const token = `turn-${id()}`;
  await db.update(tasks).set({ activeTurnToken: token }).where(eq(tasks.id, taskId));
  runs.bindTurnToken(taskId, token);
  const sessionId = `s-${id()}`;
  await db.insert(sessions).values({
    id: sessionId, taskId, role: "single", agentType: "claude", executor: "claude", cwd: root,
    startedAt: now(), turnStartedAt: now(),
  });
  return { taskId, token, owner: owner!, sessionId };
}

/** 一条哨兵 + 它排在托盘里的一条结果(形状跟 `mergeOrEnqueueMonitorEvent` 新建那一支一致)。 */
async function queuedResult(taskId: string, text: string, opts: {
  kind?: "output" | "ended"; reviewer?: { run: string; round: number };
} = {}): Promise<Row & { monitorId: string }> {
  const monitorId = id();
  await db.insert(monitors).values({
    id: monitorId, taskId, command: "fixture", description: `desc-${text}`, cwd: root, status: "exited",
    logPath: join(root, `${monitorId}.log`), startedAt: now(),
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    sourceRole: opts.reviewer ? "reviewer" : "single",
    sourceReviewRun: opts.reviewer?.run ?? null, sourceReviewRound: opts.reviewer?.round ?? null,
  });
  const message = pending.pendingMessageRow({
    taskId, text, origin: `monitor:${monitorId}`,
    turnSource: opts.reviewer ? { role: "reviewer", review: opts.reviewer } : { role: "single" },
    monitorWake: appendMonitorWake(null, { kind: opts.kind ?? "ended", monitorId, source: `desc-${text}`, body: text }),
  });
  await db.insert(scheduledMessages).values(message);
  return { ...message, monitorId };
}

/** 会话转录里认得出来的那几条带类型的旁注。 */
function notices(taskId: string, sessionId: string): Array<{ kind: string; [key: string]: unknown }> {
  const path = sessionTranscriptPath(taskId, sessionId);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter((line) => line.startsWith(TURN_SENTINEL))
    .map((line) => JSON.parse(line.slice(TURN_SENTINEL.length)) as { notice?: { kind: string } })
    .flatMap((turn) => turn.notice ? [turn.notice] : []);
}

try {
  // ── ① pause_task:结果已到 ⇒ 不暂停,当场交出 ──────────────────────────────────
  {
    const { taskId, token, owner, sessionId } = await liveTurn();
    const result = await queuedResult(taskId, "RESULT_READY_PAUSE");
    const res = await post(`/tasks/${taskId}/pause`, token, { resumePrompt: "继续：等结果" });
    assert.equal(res.status, 200);
    const body = await res.json() as { paused: boolean; note: string; monitorResults: string };
    assert.equal(body.paused, false, "没有暂停");
    assert.match(body.note, /没有暂停/);
    assert.match(body.monitorResults, /RESULT_READY_PAUSE/, "结果原文随返回交出");
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
    const again = await post(`/tasks/${taskId}/pause`, token, { resumePrompt: "继续：别的" });
    assert.equal(((await again.json()) as { paused: boolean }).paused, true);
    // 正常收口(留了检查点) ⇒ 送达,记号销掉。
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
    const body = await first.json() as { error: string; monitorResults: string };
    assert.match(body.error, /没有生效/);
    assert.match(body.error, /再调一次 complete_task/, "没剩别的就直说再调一次");
    assert.match(body.monitorResults, /RESULT_READY_COMPLETE/);
    assert.equal((await taskOf(taskId)).completeConfirmedAt, null);
    assert.equal((await rowOf(result.id)).status, "sent");
    const second = await post(`/tasks/${taskId}/complete`, token);
    assert.equal(second.status, 200, "交完之后闸放行");
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
    assert.match(((await res.json()) as { monitorResults?: string }).monitorResults ?? "", new RegExp(`RETURNED_${label}`));
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

  // ── ⑥b 交出结果的那次调用返回没回来、要被断线补录 ⇒ 补录前先退回 ─────────────────
  {
    const { taskId, token, owner } = await liveTurn();
    const result = await queuedResult(taskId, "REPLAYED");
    assert.ok(await handMonitorResultsOnPause(taskId, token, []));
    await returnTurnHandoffs(taskId, "fixture:通道断了");
    const row = await rowOf(result.id);
    assert.equal(row.status, "pending", "回到托盘");
    assert.ok(row.turnReturnedAt);
    assert.equal(row.turnTakenBy, null);
    // 补录随后把这一轮补成正常收口:已经没有交出去的行,什么都不会被当成送达。
    await settleTurnHandoffs(taskId, token, true);
    assert.equal((await rowOf(result.id)).status, "pending");
    runs.releaseTurn(taskId, owner);
    await db.update(scheduledMessages).set({ status: "canceled" }).where(eq(scheduledMessages.id, result.id));
  }

  // ── ⑧ F1:领取之后那一步出错 ⇒ 按这次领取退回,再调一次照样交出来 ───────────────
  {
    const { taskId, token, owner } = await liveTurn();
    const result = await queuedResult(taskId, "MUST_READ_BEFORE_DONE");
    let injected = false;
    const restore = onSelect(sessions, (p) => !!p && Object.keys(p).length === 1 && p.id === sessions.id, async (rows) => {
      if (injected || (await rowOf(result.id)).status !== "sent") return rows;
      injected = true;
      throw new Error("注入:领取之后读会话出错");
    });
    const first = await post(`/tasks/${taskId}/complete`, token);
    restore();
    assert.ok(injected, "注入点真的落在领取之后");
    assert.equal(first.status, 500);
    const back = await rowOf(result.id);
    assert.equal(back.status, "pending", "领到的那一行退回托盘");
    assert.equal(back.turnTakenBy, null);
    assert.ok(back.turnReturnedAt);
    const second = await post(`/tasks/${taskId}/complete`, token);
    assert.equal(second.status, 409, "再调一次:没看过的结果照样拦下、照样交出");
    assert.match(((await second.json()) as { monitorResults?: string }).monitorResults ?? "", /MUST_READ_BEFORE_DONE/);
    assert.equal((await post(`/tasks/${taskId}/complete`, token)).status, 200);
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

  // ── ⑧ F4:合并窗口落在行上 ⇒ 巡检、按任务扫描、回合里的交付都领不走 ─────────────────
  {
    const taskId = await makeTask({ status: "paused" });
    await db.insert(sessions).values({
      id: `s-${id()}`, taskId, role: "single", agentType: "claude", executor: "claude", cwd: root,
      startedAt: new Date(Date.now() - 60_000).toISOString(), endedAt: new Date(Date.now() - 30_000).toISOString(),
    });
    const started = await startMonitor({ taskId, command: "echo FINAL_OUTPUT; sleep 0.9; exit 0", description: "grace-bypass" });
    assert.ok(started.ok);
    const monitorId = started.ok ? started.monitor.id : "";
    const origin = `monitor:${monitorId}`;
    const ofMonitor = () => db.select().from(scheduledMessages).where(eq(scheduledMessages.origin, origin));
    await until("输出进了托盘", async () => (await ofMonitor()).some((m) => m.text.includes("FINAL_OUTPUT")));
    assert.ok((await ofMonitor())[0]!.mergeHoldUntil, "那一行带着合并窗口");
    await pending.deliverPendingMessages();
    await pending.deliverPendingMessages(taskId);
    const held = await ofMonitor();
    assert.deepEqual(held.map((m) => m.status), ["pending"], "窗口里谁来领都领不走");
    await until("结束并进来、一起送出", async () => (await ofMonitor()).every((m) => m.status === "sent")
      && (await ofMonitor()).some((m) => /哨兵结束/.test(m.text)));
    const rows = await ofMonitor();
    assert.equal(rows.length, 1, "只有一条消息");
    assert.deepEqual((rows[0]!.monitorWake?.events ?? []).map((e) => e.kind), ["output", "ended"]);
    await until("那一回合跑完", async () => !runs.isTurnClaimed(taskId));
  }

  // ── ⑦ 空闲任务:最后一批输出与「结束」并成一条、只叫醒一次 ─────────────────────
  for (const [label, command, stopWhen] of [
    ["自己退出", "echo LAST_LINE_A; exit 0", undefined],
    ["命中 stopWhen", "echo READY_HIT; sleep 30", "READY_HIT"],
  ] as const) {
    const taskId = await makeTask({ status: "paused" });
    const sessionId = `s-${id()}`;
    await db.insert(sessions).values({
      id: sessionId, taskId, role: "single", agentType: "claude", executor: "claude", cwd: root,
      startedAt: new Date(Date.now() - 60_000).toISOString(), endedAt: new Date(Date.now() - 30_000).toISOString(),
    });
    const started = await startMonitor({ taskId, command, description: `merge-${label}`, ...(stopWhen ? { stopWhen } : {}) });
    assert.ok(started.ok, `${label}:挂得上`);
    const monitorId = started.ok ? started.monitor.id : "";
    const origin = `monitor:${monitorId}`;
    await until(`${label}:结束通知入队`, async () => (await db.select().from(scheduledMessages)
      .where(eq(scheduledMessages.origin, origin))).some((m) => /哨兵结束/.test(m.text)));
    await until(`${label}:那一回合跑完`, async () => !runs.isTurnClaimed(taskId) && existsSync(log)
      && readFileSync(log, "utf8").includes(monitorId));
    await sleep(2_500);   // 过了合并窗口,确认没有第二次唤醒
    const rows = await db.select().from(scheduledMessages).where(eq(scheduledMessages.origin, origin));
    assert.equal(rows.length, 1, `${label}:只有一条消息`);
    const kinds = (rows[0]!.monitorWake?.events ?? []).map((e) => e.kind);
    assert.deepEqual(kinds, ["output", "ended"], `${label}:两类事件都在`);
    assert.match(rows[0]!.text, stopWhen ? /READY_HIT[\s\S]*哨兵结束/ : /LAST_LINE_A[\s\S]*哨兵结束[\s\S]*退出码 0/);
    // 第三件:三条哨兵记录里起止两条带着 monitorId。
    const kindsWithId = notices(taskId, sessionId)
      .filter((n) => (n.kind === "monitor.started" || n.kind === "monitor.finished") && n.monitorId === monitorId)
      .map((n) => n.kind);
    assert.deepEqual(kindsWithId.sort(), ["monitor.finished", "monitor.started"], `${label}:起止记录带 monitorId`);
    const status = (await db.select({ status: monitors.status }).from(monitors).where(eq(monitors.id, monitorId))).at(0)?.status;
    assert.equal(status, stopWhen ? "matched" : "exited");
    // 只起过一个唤醒回合:这条哨兵的消息从入队到送达只有那一行,而它只被领走一次。
    const sent = await db.select().from(scheduledMessages)
      .where(and(eq(scheduledMessages.taskId, taskId), eq(scheduledMessages.status, "sent")));
    assert.equal(sent.length, 1, `${label}:恰好一次唤醒`);
  }

  console.log("monitor turn handoff ok");
} finally {
  await teardown();
}
