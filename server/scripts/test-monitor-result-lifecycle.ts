// **命令的命 ≠ 结果的命**，以及「谁来收、按什么资格收」。
//
// 这一份钉的是第 2 轮审查的五条，全部出在「每个判据各自都对、串起来还是漏」的同一类缝里：
//
// ① 终态清理的保留集合曾按「还在 running」构造。命令退出不代表它的通知已经送达 —— 审查者
//    自己还在跑的那几分钟里，stdout 和「哨兵结束」只能排在托盘里等这一轮结束；它 pause
//    退出、任务被恢复成 done，紧接着就轮到清理，于是那一批**已经拿到的结果**被整批作废，
//    审查链继续等一个永远不会到的唤醒（F1）。
// ② 「审查还在进行」推不出「用户仍然允许这个任务的资源继续存在」。删除/归档走的是同一个
//    函数，豁免套上去就留下一个没人能再叫停的后台进程 —— 删除紧接着抹掉 pid 这个唯一线索
//    （F2）。收尾方的枚举还必须跟创建在同一把锁里（F2 的并发缺口）。
// ③ 来源审查是否失效，是**这条消息自己的资格**，不是只在任务终态时才需要的额外豁免：在
//    paused 任务上派的审查收了尾，同样要作废它的遗留结果；而审查收尾时的取消范围也不能按
//    「生产命令还活着吗」裁剪（F5）。
// ④ 取走的续跑交代必须落进持久账本：只留在内存闭包里的话，送达之前进程一换，那段话两边
//    都不在（F4）。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import {
  db, monitors, pending, root, schema, scheduledMessages, sessions, tasks,
  isPidAlive, makeTask, now, pendingOf, sleep, startMonitor, until, teardown, uniq,
} from "./monitors-fixture.js";
import { inspectProcess } from "../src/proc.js";
import { sessionTranscriptPath } from "../src/transcript.js";
import { queueBlockers } from "../src/queues.js";

const { stopMonitorsForTask, stopMonitorsForReviewRun } = await import("../src/monitor-reclaim.js");
const { monitorWakeGuard, deliveryVerdict } = await import("../src/pending-verdict.js");
const { monitorEventSourceState, monitorWakeCheckpoint, monitorWakeGate } = await import("../src/monitor-session.js");

/** 一次正在进行的审查（默认第 1 轮）。 */
async function reviewInFlight(
  taskId: string, runId: string, opts: { round?: number; live?: boolean } = {},
): Promise<void> {
  await db.insert(schema.freeReviewRuns).values({
    id: runId, taskId, reviewerName: "审查者", agentType: "codex", checkMode: "logic",
    status: "reviewing", currentRound: opts.round ?? 1, createdAt: now(), updatedAt: now(),
  });
  if (opts.live !== false) {
    await db.insert(sessions).values({
      id: `s-${runId}`, taskId, role: "reviewer", agentType: "codex", executor: "审查者",
      cwd: root, startedAt: now(), agentPid: process.pid,
      agentStartedAt: inspectProcess(process.pid)?.startedAt ?? null,
    });
  }
}

/**
 * 直接插一条哨兵行。
 *
 * 用在「创建方已经在锁里登记成功」这个时刻上 —— 真正的 `startMonitor` 会去抢同一把
 * `task:<id>` 锁，在测试里拿着锁调它就是自锁，所以这里用一条等价的行站它的位。
 */
async function insertMonitorRow(
  taskId: string, opts: { reviewRun?: string; round?: number; status?: string } = {},
): Promise<string> {
  const id = uniq("mon");
  await db.insert(monitors).values({
    id, taskId, command: "sleep 120", description: "站位", cwd: root,
    status: opts.status ?? "running", pid: null, pidStartedAt: null,
    logPath: `${root}/${id}.log`, offset: 0, events: 0, exitCode: null,
    startedAt: now(), expiresAt: new Date(Date.now() + 600_000).toISOString(),
    endedAt: null, endedReason: null, ownerUserId: null, kind: "ash",
    nativeId: null, cliSessionId: null, toolUseId: null, sourceRun: null, startLowAt: null,
    sourceRole: "reviewer", sourceReviewRun: opts.reviewRun ?? null,
    sourceReviewRound: opts.round ?? null, sourceLifetime: "bounded", lifetimeEvidence: "self",
    sourcePid: null, sourcePidStartedAt: null, startEvidence: "observed",
    startAnchorWidthMs: 0, timeoutMs: 600_000,
  });
  return id;
}

// ── ① 命令已经退出、结果还排在托盘里：终态清理不许作废它（F1）─────────────────
{
  const taskId = await makeTask();
  await reviewInFlight(taskId, "run-exited");
  const started = await startMonitor({
    taskId, command: "printf 'SUITE_DONE\\n'", description: "审查等套件", timeoutMs: 60_000,
  });
  assert.ok(started.ok, `审查进行中就该挂得上：${started.ok ? "" : started.error}`);
  const monitorId = started.ok ? started.monitor.id : "";
  const origin = `monitor:${monitorId}`;

  // 等它**跑完并自己退出**，而通知仍排在托盘里（任务正忙，这正是审查者挂哨兵的常态）。
  await until("命令退出且结果入队", async () => {
    const row = (await db.select().from(monitors).where(eq(monitors.id, monitorId))).at(0)!;
    const queued = (await pendingOf(taskId)).find((m) => m.origin === origin);
    return row.status !== "running" && !!queued && /SUITE_DONE/.test(queued.text);
  });
  const exited = (await db.select().from(monitors).where(eq(monitors.id, monitorId))).at(0)!;
  assert.equal(exited.status, "exited", "命令自己跑完了");

  // 旁路回合退出、任务恢复终态 → 终态连坐（status.ts 调的就是这一个函数）。
  await stopMonitorsForTask(taskId, "任务已done，哨兵一并收回");

  const kept = (await pendingOf(taskId)).find((m) => m.origin === origin);
  assert.ok(kept, "命令退出 ≠ 结果已送达：属于一次仍在进行的审查的通知不许作废（F1）");
  assert.match(kept.text, /SUITE_DONE/, "而且是原封不动的那一批");
  const guard = monitorWakeGuard({ taskId, origin } as never);
  assert.equal(await guard!(), null, "唤醒前最后那道闸也要放它过去，否则等于白留");

  // ── ② 那次审查真的收尾了，**已退出**哨兵的遗留结果也要一起作废（F5）────────
  await db.update(schema.freeReviewRuns).set({ status: "passed" })
    .where(eq(schema.freeReviewRuns.id, "run-exited"));
  await stopMonitorsForReviewRun("run-exited", "这次审查已通过，它挂的哨兵一并收回");
  assert.equal((await pendingOf(taskId)).filter((m) => m.origin === origin).length, 0,
    "取消范围不能按「生产命令还活着吗」裁剪：已退出哨兵的遗留结果同样要收（F5）");
}

// ── ③ 删除/归档：审查还在进行也不留（F2）──────────────────────────────────────
{
  for (const intent of ["task-settled", "destroy"] as const) {
    const taskId = await makeTask();
    await reviewInFlight(taskId, `run-${intent}`);
    const started = await startMonitor({
      taskId, command: "sleep 120", description: "审查等外部结果", timeoutMs: 180_000,
    });
    assert.ok(started.ok, `起不来：${started.ok ? "" : started.error}`);
    const row = (await db.select().from(monitors).where(eq(monitors.id, started.ok ? started.monitor.id : ""))).at(0)!;
    assert.ok(row.pid && isPidAlive(row.pid), "台子前提：进程真的起来了");

    const stopped = await stopMonitorsForTask(taskId, `测试：${intent}`, intent);
    const after = (await db.select().from(monitors).where(eq(monitors.id, row.id))).at(0)!;
    if (intent === "task-settled") {
      assert.equal(stopped, 0, "任务自己落终态 ≠ 审查结束，这一条要放过");
      assert.equal(after.status, "running");
      await stopMonitorsForTask(taskId, "测试收尾", "destroy");
    } else {
      assert.equal(stopped, 1, "用户销毁任务时没有审查豁免（F2）");
      assert.equal(after.status, "stopped", "行要落停止态，否则重启还会去接它");
      await until("进程真的没了", async () => !isPidAlive(row.pid!));
      assert.equal((await pendingOf(taskId)).filter((m) => m.origin === `monitor:${row.id}`).length, 0,
        "销毁时连它的待发结果一起收：任务都要没了，留着喂不到任何人");
    }
  }
}

// ── ④ 审查收尾方的枚举必须跟创建在**同一把锁**里（F2 的并发缺口）────────────────
//
// 拿锁之前查的话：创建方刚在锁里确认「来源审查有效」、进程已经起来、还没插库，收尾方查到
// 空集合就返回了 —— 审查收了尾，却留下一个后台命令。这里用「先占住锁、再插行」把那个顺序
// 摆出来：锁外枚举看不见后插的那一行，锁内枚举看得见。
{
  const taskId = await makeTask();
  await reviewInFlight(taskId, "run-lock");
  const held = await insertMonitorRow(taskId, { reviewRun: "run-lock", round: 1 });

  // 占锁：让 `stopMonitorsForTask` 的来源有效性那一问停在原地（它跑在 task 锁里面）。
  let release = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  let entered = false;
  const original = db.select;
  db.select = ((fields?: Record<string, unknown>) => {
    const keys = fields ? Object.keys(fields) : [];
    if (!entered && keys.length === 2 && keys.includes("status") && keys.includes("round")) {
      entered = true;
      return { from: () => ({ where: async () => { await gate; return [{ status: "reviewing", round: 1 }]; } }) };
    }
    return (original as (f?: unknown) => unknown).call(db, fields);
  }) as typeof db.select;

  const holding = stopMonitorsForTask(taskId, "占住 task 锁");
  await until("锁已被占住", async () => entered);
  db.select = original;

  // 收尾方此刻排在锁外面。锁外枚举的版本会在这一刻就数完（数到 0 条也可能数到 held 那条），
  // 然后再也看不见下面这一行。
  const settling = stopMonitorsForReviewRun("run-lock", "这次审查已收尾");
  await sleep(80);
  const late = await insertMonitorRow(taskId, { reviewRun: "run-lock", round: 1 });

  release();
  await Promise.all([holding, settling]);
  const lateRow = (await db.select().from(monitors).where(eq(monitors.id, late))).at(0)!;
  const heldRow = (await db.select().from(monitors).where(eq(monitors.id, held))).at(0)!;
  assert.equal(lateRow.status, "stopped",
    "锁内枚举才看得见「刚在锁里登记成功」的那一条，否则结束的审查会留下一个后台命令（F2）");
  assert.equal(heldRow.status, "stopped", "本来就在的那条当然也要收");
}

// ── ⑤ 来源资格无条件核验：paused 任务上收了尾的审查，遗留结果不许再唤醒（F5）────
{
  const taskId = await makeTask({ status: "paused" });
  await reviewInFlight(taskId, "run-paused", { live: false });
  const exited = await insertMonitorRow(taskId, { reviewRun: "run-paused", round: 1, status: "exited" });
  const origin = `monitor:${exited}`;

  // 审查还在进行时：paused 任务上照旧该唤醒（豁免的那一半不能被这一条带走）。
  assert.equal(await monitorEventSourceState(origin), "live");
  assert.equal(await monitorWakeGate({ id: taskId, status: "paused" }, { reviewRun: "run-paused", reviewRound: 1 }), null);

  // 审查给了结论（旁路回合把任务恢复成 paused —— 任务根本没进终态，终态清理压根不跑）。
  await db.update(schema.freeReviewRuns).set({ status: "passed" })
    .where(eq(schema.freeReviewRuns.id, "run-paused"));
  assert.equal(await monitorEventSourceState(origin), "stale",
    "来源失效是这条消息自己的资格，不是只有终态任务才要问（F5）");
  const blocked = await monitorWakeGate({ id: taskId, status: "paused" }, { reviewRun: "run-paused", reviewRound: 1 });
  assert.match(blocked ?? "", /审查已经结束/, "非终态任务上同样要拦（F5）");
  assert.equal(
    deliveryVerdict(
      { id: "m", taskId, text: "x", origin, mode: "queued", execution: false, sendAt: now() } as never,
      { status: "paused", archived: false, mode: "single", monitorSource: "stale" } as never,
      new Date(),
    ).action,
    "cancel",
    "投递判定也要无条件作废它",
  );

  // 轮次：run.id 跨轮复用，上一轮遗留的结果不是新一轮的有效输入。
  await db.update(schema.freeReviewRuns).set({ status: "reviewing", currentRound: 2 })
    .where(eq(schema.freeReviewRuns.id, "run-paused"));
  assert.equal(await monitorEventSourceState(origin), "stale",
    "同一个 run 续到第 2 轮：第 1 轮遗留的结果不许被当成新一轮的输入（F5）");
  assert.equal(await monitorEventSourceState("monitor:不存在"), "none",
    "认不出来源的照老规矩走任务状态");
}

// ── ⑥ 取走的续跑交代落在持久账本上，重启/重投都接得住（F4）────────────────────
{
  const taskId = await makeTask({ status: "done" });
  const checkpoint = "套件完成后继续审查并交报告";
  await db.update(tasks).set({ resumePrompt: checkpoint }).where(eq(tasks.id, taskId));
  const monitorId = await insertMonitorRow(taskId, { status: "exited" });
  const msgId = uniq("msg");
  await db.insert(scheduledMessages).values({
    id: msgId, taskId, text: "【哨兵】SUITE_DONE", attachments: "[]",
    origin: `monitor:${monitorId}`, mode: "queued", status: "pending",
    sendAt: now(), createdAt: now(),
  });
  const rowOf = async () => (await db.select().from(scheduledMessages).where(eq(scheduledMessages.id, msgId))).at(0)!;
  const taskOf = async () => (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0)!;

  const taken = await monitorWakeCheckpoint(await rowOf());
  assert.ok(taken, "任务行上有交代就该带上");
  assert.match(taken.text, /SUITE_DONE[\s\S]*套件完成后继续审查并交报告/, "喂回去的是事件 + 交代");
  assert.equal((await taskOf()).resumePrompt, null, "取走了");
  const ledger = await rowOf();
  assert.equal(ledger.text, taken.text,
    "取走的那一刻就要落进这条消息的正文：只留在内存里的话，送达之前进程一换就两边都不在（F4）");
  assert.equal(ledger.checkpointTaken, checkpoint, "账本列记着接走的是哪一段");

  // 「进程在这儿没了」：开机只清投递租约，重投读的是库里这一行。
  const again = await monitorWakeCheckpoint(await rowOf());
  assert.ok(again, "重投照旧带着它走");
  assert.equal(again.text, ledger.text, "不许再追加第二遍（幂等）");
  assert.equal((await taskOf()).resumePrompt, null, "更不许从任务行上再取一次");

  // 一个字都没送出去：两半一起退回去。
  await again.restore();
  assert.equal((await taskOf()).resumePrompt, checkpoint, "任务行上原样填回");
  const reverted = await rowOf();
  assert.equal(reverted.text, "【哨兵】SUITE_DONE", "消息正文退回原话");
  assert.equal(reverted.checkpointTaken, null, "账本清空，下一次投递可以重新取一次");

  // 两条消息同时来取：只能有一个拿到，落空的那个必须把账本那一半退干净。
  const otherId = uniq("msg");
  await db.insert(scheduledMessages).values({
    id: otherId, taskId, text: "【哨兵】ANOTHER", attachments: "[]",
    origin: `monitor:${monitorId}`, mode: "queued", status: "pending",
    sendAt: now(), createdAt: now(),
  });
  const rows = await db.select().from(scheduledMessages)
    .where(and(eq(scheduledMessages.taskId, taskId), eq(scheduledMessages.status, "pending")));
  const both = await Promise.all(rows.map((r) => monitorWakeCheckpoint(r)));
  assert.equal(both.filter(Boolean).length, 1, "同一段交代只能被一条消息接走");
  const after = await db.select().from(scheduledMessages)
    .where(and(eq(scheduledMessages.taskId, taskId), eq(scheduledMessages.status, "pending")));
  assert.equal(after.filter((r) => r.checkpointTaken !== null).length, 1, "账本上也只能有一笔");
  for (const r of after) {
    if (r.checkpointTaken === null) {
      assert.ok(!r.text.includes(checkpoint), "落空的那条不许把交代留在正文里（会喂第二遍）");
    }
  }
}

// ── ⑦ 扫描层也必须**无条件**问来源，不按任务状态短路（F5 的那一半在投递链路上）────
//
// 上一节钉的是判据本身（`monitorEventSourceState` / `deliveryVerdict`）。还剩一道缝：扫描
// 层曾只在「哨兵事件撞上终态任务」时才去查来源 —— 于是 paused/idle 任务上那条属于**已结束
// 审查**的通知照旧被投出去，又启动一轮 reviewer 回合。这一节走真实的 `deliverPendingMessages`。
{
  const taskId = await makeTask({ mode: "team", status: "idle" });
  await db.insert(sessions).values({
    id: `s-scan-${taskId}`, taskId, role: "single", agentType: "claude", executor: "调度台",
    cwd: root, startedAt: now(),
  });
  await db.insert(schema.freeReviewRuns).values({
    id: "run-scan", taskId, reviewerName: "审查者", agentType: "codex", checkMode: "logic",
    status: "passed", currentRound: 1, createdAt: now(), updatedAt: now(),
  });
  const exited = await insertMonitorRow(taskId, { reviewRun: "run-scan", round: 1, status: "exited" });
  const msgId = uniq("msg");
  await db.insert(scheduledMessages).values({
    id: msgId, taskId, text: "【哨兵】LATE_RESULT", attachments: "[]",
    origin: `monitor:${exited}`, mode: "queued", status: "pending", sendAt: now(), createdAt: now(),
  });

  await pending.deliverPendingMessages(taskId);

  const msg = (await db.select().from(scheduledMessages).where(eq(scheduledMessages.id, msgId))).at(0)!;
  assert.equal(msg.status, "canceled", "已结束审查的遗留结果，扫描层就该当场作废（F5）");
  // 任务不是终态、也不是归档，所以作废的理由只能是「来源审查已经结束」—— 盯住这句话，
  // 否则「因为别的原因也取消了」会把这一条伪装成通过（团队任务在调度台不可用时也取消）。
  const timeline = readFileSync(sessionTranscriptPath(taskId, `s-scan-${taskId}`), "utf8");
  assert.match(timeline, /起这个哨兵的那次审查已经结束/,
    "作废的理由要如实说是来源审查结束，而不是碰巧走到别的取消出路（F5）");
}

// ── ⑧ 同一条资格在**扫描这一层**也得独立成立，不能只靠 spawn 前那道守卫兜着 ────────
//
// 三道闸（生产出口 / 扫描 / spawn 前守卫）判的是同一件事，所以漏掉中间那一道时末端那道
// 仍会把它拦下来 —— 上一节于是看不出区别。这一节专门把它们分开：**排队没轮到**的 paused
// 任务上，扫描层的「等让位」排在来源作废**后面**，所以漏查来源的版本会把这条遗留结果一直
// 留在托盘里（pending），轮到它时再去真的续跑；查了的版本当场作废。
{
  const taskId = await makeTask({ status: "paused" });
  const ahead = await makeTask();                      // 同队排在前面、正在跑的那个
  const queueId = uniq("queue");
  await db.insert(schema.queueItems).values([
    { taskId: ahead, queueId, position: 0, createdAt: now() },
    { taskId, queueId, position: 1, createdAt: now() },
  ]);
  await db.insert(schema.freeReviewRuns).values({
    id: "run-queued", taskId, reviewerName: "审查者", agentType: "codex", checkMode: "logic",
    status: "passed", currentRound: 1, createdAt: now(), updatedAt: now(),
  });
  const exited = await insertMonitorRow(taskId, { reviewRun: "run-queued", round: 1, status: "exited" });
  const msgId = uniq("msg");
  await db.insert(scheduledMessages).values({
    id: msgId, taskId, text: "【哨兵】LATE_IN_QUEUE", attachments: "[]",
    origin: `monitor:${exited}`, mode: "queued", status: "pending", sendAt: now(), createdAt: now(),
  });
  assert.ok((await queueBlockers(taskId)).length > 0, "台子前提：它确实排着没轮到");

  await pending.deliverPendingMessages(taskId);

  const msg = (await db.select().from(scheduledMessages).where(eq(scheduledMessages.id, msgId))).at(0)!;
  assert.equal(msg.status, "canceled",
    "扫描层自己就要问来源：留成 pending 等轮次 = 一条属于已结束审查的结果还在排队等着唤醒（F5）");
  assert.equal(msg.deliveringSince, null, "更不该带着租约卡住");
}

await teardown();
console.log("✓ 结果的命不跟命令走：已退出哨兵的结果照旧保留 / 审查收尾一并作废 / 销毁任务没有审查豁免 / 收尾枚举在锁里 / 来源资格无条件核验含轮次 / 续跑交代落持久账本且幂等可退 / 扫描层与末端守卫各自独立问来源");
