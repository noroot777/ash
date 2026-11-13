// 「最后一批输出 + 结束」并成一次唤醒(monitor-events.ts 的合并窗口),外加哨兵时间线记录带上 monitorId。
// 回合内交付那一半在 test-monitor-turn-handoff.ts。
//
//  ⑦ 空闲任务上 `echo A; exit 0` / 命中 stopWhen:一条消息、两类事件、一次唤醒
//  ⑧ F4 合并窗口落在行上:巡检、按任务扫描、回合里的交付都领不走
//  ⑨-3 积压过的老行窗口已过 ⇒ 最新一批另起一行,跟「结束」并在一起
//  ⑩-3a 最新一批到在前一行窗口的末尾 ⇒ 它有自己完整的窗口;⑩-3b 持续输出时最多两行
//  ⑫-1 收尾慢(进程退了、ash 还在记账)⇒ 哪个出口都领不走最后一批(第 4 轮审查 3)
//  ⑫-2 「结束」落进去了、解除窗口那一笔失败 ⇒ 「结束」不会跑到积压的进展前面;重投补做解除(第 4 轮审查 4)
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import {
  db, dbClient, makeTask, monitors, pending, root, runs, scheduledMessages, sessions, startMonitor, tasks, teardown, until,
} from "./monitors-fixture.js";
import { liveTurn, log, notices, sleep } from "./monitor-turn-handoff-fixture.js";
import { handMonitorResultsOnPause, settleTurnHandoffs } from "../src/monitor-turn-handoff.js";
import { confirmHandoffs } from "../src/monitor-turn-ack.js";
import { deliverResultHandoff } from "../src/monitor-events.js";
import { id } from "../src/util.js";

/** 底层客户端那一条**真实语句**上挂一层(产品代码一个都不替换);返回撤掉这层的函数。 */
function onStatement(act: (sql: string, args: unknown[]) => Promise<void>): () => void {
  const target = dbClient as unknown as { execute: (stmt: unknown) => Promise<unknown> };
  const real = target.execute.bind(dbClient);
  target.execute = async (stmt: unknown) => {
    const text = typeof stmt === "string" ? stmt : String((stmt as { sql?: unknown })?.sql ?? "");
    await act(text, ((stmt as { args?: unknown[] })?.args) ?? []);
    return real(stmt);
  };
  return () => { target.execute = real; };
}

try {
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

  // ── ⑨-3 忙着时积压过一条进展、窗口早过了;最后一行紧跟着退出 ⇒ 最后一批跟「结束」并在一起 ─────
  {
    const { taskId, owner } = await liveTurn();
    const started = await startMonitor({
      taskId, command: "echo FIRST_PROGRESS; sleep 3; echo FINAL_OUTPUT; sleep 0.9; exit 0", description: "backlog-then-final",
    });
    assert.ok(started.ok);
    const origin = `monitor:${started.ok ? started.monitor.id : ""}`;
    const ofMonitor = async () => (await db.select().from(scheduledMessages).where(eq(scheduledMessages.origin, origin)))
      .sort((x, y) => x.createdAt.localeCompare(y.createdAt));
    await until("最后一行进了托盘", async () => (await ofMonitor()).some((m) => m.text.includes("FINAL_OUTPUT")), 10_000);
    const before = await ofMonitor();
    assert.equal(before.length, 2, "窗口过了的老行不收新的那一批:另起一行");
    assert.doesNotMatch(before[0]!.text, /FINAL_OUTPUT/);
    // 回合收口、任务空了,巡检随即来领:积压的那一行可以走,最新那一批不行。
    runs.releaseTurn(taskId, owner);
    await db.update(tasks).set({ status: "paused" }).where(eq(tasks.id, taskId));
    await pending.deliverPendingMessages();
    const final = (await ofMonitor()).find((m) => m.text.includes("FINAL_OUTPUT"))!;
    assert.equal(final.status, "pending", "最新那一批在窗口里,谁来领都领不走");
    // 同一个任务两次唤醒之间有 5 秒冷却(pending-messages.ts `cooling`),第二条要等下一趟巡检
    // (生产上是 30 秒那一趟);这里过了冷却手动扫一次。
    await until("结束并进最新那一行", async () => (await ofMonitor()).some((m) => /哨兵结束/.test(m.text)));
    await sleep(5_500);
    await pending.deliverPendingMessages();
    await until("两行都送出", async () => {
      const rows = await ofMonitor();
      return rows.every((m) => m.status === "sent") && rows.some((m) => /哨兵结束/.test(m.text));
    });
    const rows = await ofMonitor();
    assert.equal(rows.length, 2, "积压一行 + 最后一批与结束一行");
    assert.deepEqual((rows[1]!.monitorWake?.events ?? []).map((e) => e.kind), ["output", "ended"]);
    assert.match(rows[1]!.text, /FINAL_OUTPUT[\s\S]*哨兵结束/);
    await until("回合都跑完", async () => !runs.isTurnClaimed(taskId));
  }

  // ── ⑩-3a 最新一批到在前一行窗口的末尾 ⇒ 它有自己完整的窗口,不被前一行的期限带走 ──────────
  // 第 3 轮审查的现场:第一批 t0 进来、窗口到 t0+2;第二批 t0+1.2 到,并进那一行就只剩 0.8 秒,
  // t0+2 那一刻被(这里是回合里的交付)单独领走,紧跟着的「结束」另起一行。
  {
    const { taskId, token, owner } = await liveTurn();
    const started = await startMonitor({
      taskId, command: "echo FIRST_PROGRESS; sleep 1.2; echo FINAL_OUTPUT; sleep 1.6; exit 0", description: "near-window-edge",
    });
    assert.ok(started.ok);
    const origin = `monitor:${started.ok ? started.monitor.id : ""}`;
    const ofMonitor = async () => (await db.select().from(scheduledMessages).where(eq(scheduledMessages.origin, origin)))
      .sort((x, y) => x.createdAt.localeCompare(y.createdAt));
    await until("最后一批进了托盘", async () => (await ofMonitor()).some((m) => m.text.includes("FINAL_OUTPUT")), 10_000);
    const first = (await ofMonitor())[0]!;
    assert.doesNotMatch(first.text, /FINAL_OUTPUT/, "最新一批不并进还在窗口里的前一行");
    await sleep(Math.max(0, Date.parse(first.mergeHoldUntil!) - Date.now()) + 50);
    const handed = await handMonitorResultsOnPause(taskId, token, []);
    assert.match(handed?.text ?? "", /FIRST_PROGRESS/, "前一行窗口过了,照常交");
    assert.doesNotMatch(handed?.text ?? "", /FINAL_OUTPUT/, "最新一批还在它自己的窗口里");
    assert.equal(await confirmHandoffs(taskId, token, [handed!.hand]), 1);
    await until("结束并进最新那一批", async () => (await ofMonitor()).some((m) => /哨兵结束/.test(m.text)), 10_000);
    const final = (await ofMonitor()).find((m) => m.text.includes("FINAL_OUTPUT"))!;
    assert.deepEqual((final.monitorWake?.events ?? []).map((e) => e.kind), ["output", "ended"], "最后一批跟「结束」一起");
    assert.equal(final.mergeHoldUntil, null, "「结束」到了就解除窗口");
    await settleTurnHandoffs(taskId, token, true);
    runs.releaseTurn(taskId, owner);
    await db.update(scheduledMessages).set({ status: "canceled" }).where(eq(scheduledMessages.id, final.id));
  }

  // ── ⑩-3b 持续输出:同一条哨兵最多两行(积压 + 最新一批),最新那一批单独一行、带自己的窗口 ──────
  {
    const { taskId, owner } = await liveTurn();
    const started = await startMonitor({
      taskId, command: "echo P1; sleep 2.5; echo P2; sleep 0.5; echo P3; sleep 0.5; echo P4; sleep 0.5; exit 0",
      description: "steady-output",
    });
    assert.ok(started.ok);
    const origin = `monitor:${started.ok ? started.monitor.id : ""}`;
    const ofMonitor = async () => (await db.select().from(scheduledMessages).where(eq(scheduledMessages.origin, origin)))
      .sort((x, y) => x.createdAt.localeCompare(y.createdAt));
    let most = 0;
    await until("结束入队", async () => {
      const rows = await ofMonitor();
      most = Math.max(most, rows.length);
      return rows.some((m) => /哨兵结束/.test(m.text));
    }, 15_000);
    const rows = await ofMonitor();
    assert.ok(most <= 2 && rows.length === 2, `最多两行(见过 ${most} 行)`);
    assert.match(rows[0]!.text, /P1[\s\S]*P2[\s\S]*P3/, "更早的那几批并成积压那一行");
    assert.doesNotMatch(rows[0]!.text, /P4/);
    assert.deepEqual((rows[1]!.monitorWake?.events ?? []).map((e) => e.kind), ["output", "ended"],
      "最新那一批单独一行,跟「结束」并在一起");
    assert.match(rows[1]!.text, /P4[\s\S]*哨兵结束/);
    assert.deepEqual(rows.map((m) => m.mergeHoldUntil), [null, null], "「结束」到了两行一起解除");
    runs.releaseTurn(taskId, owner);
    await db.update(scheduledMessages).set({ status: "canceled" }).where(eq(scheduledMessages.origin, origin));
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

  // ── ⑫-1 收尾慢:进程退了、ash 还在写终态 ⇒ 窗口过了也谁都领不走最后一批(第 4 轮审查 3) ─────────
  // 审查的现场:只有窗口那个定时器会等收尾做完,巡检 / 按任务扫描两秒一到就把只有输出的那一行送走,
  // 「结束」另起一行再叫一次。收尾写终态那一笔在这里被压住(挂在真实语句上,不替换产品代码)。
  {
    const taskId = await makeTask({ status: "paused" });
    await db.insert(sessions).values({
      id: `s-${id()}`, taskId, role: "single", agentType: "claude", executor: "claude", cwd: root,
      startedAt: new Date(Date.now() - 60_000).toISOString(), endedAt: new Date(Date.now() - 30_000).toISOString(),
    });
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    let held = 0;
    const restore = onStatement(async (text) => {
      if (/update "monitors" set/i.test(text) && /"ended_reason"/.test(text) && held++ === 0) await gate;
    });
    const started = await startMonitor({ taskId, command: "echo FINAL_BEFORE_SLOW_FINISH; exit 0", description: "slow-finish" });
    assert.ok(started.ok);
    const origin = `monitor:${started.ok ? started.monitor.id : ""}`;
    const ofMonitor = () => db.select().from(scheduledMessages).where(eq(scheduledMessages.origin, origin));
    try {
      await until("收尾停在写终态那一笔", async () => held > 0 && (await ofMonitor()).length > 0, 10_000);
      const first = (await ofMonitor())[0]!;
      await sleep(2_300);   // 原来那两秒的窗口早过了
      await pending.deliverPendingMessages();
      await pending.deliverPendingMessages(taskId);
      const rows = await ofMonitor();
      assert.deepEqual(rows.map((m) => m.status), ["pending"], "收尾没做完,谁来领都领不走");
      assert.ok(Date.parse(rows[0]!.mergeHoldUntil ?? "") > Date.now(), "期限落在行上,跟着收尾推后了");
      assert.equal(rows[0]!.id, first.id);
    } finally {
      open();
      restore();
    }
    await until("结束并进来、一起送出", async () => (await ofMonitor()).every((m) => m.status === "sent")
      && (await ofMonitor()).some((m) => /哨兵结束/.test(m.text)));
    const rows = await ofMonitor();
    assert.equal(rows.length, 1, "只有一条消息");
    assert.deepEqual((rows[0]!.monitorWake?.events ?? []).map((e) => e.kind), ["output", "ended"]);
    await until("那一回合跑完", async () => !runs.isTurnClaimed(taskId));
  }

  // ── ⑫-2 「结束」落进最新那一行、解除窗口那一笔失败 ⇒ 「结束」照样压着,不跑到进展前面 ─────────────
  {
    const { taskId, owner } = await liveTurn();
    // 解除窗口那一笔(把期限清空的那一条 UPDATE;收尾开头压期限那一条带着时间戳,不碰它)一直失败。
    let failing = true;
    let failures = 0;
    const restore = onStatement(async (text, args) => {
      const release = /update "scheduled_messages" set "merge_hold_until" = /i.test(text)
        && !args.some((v) => typeof v === "string" && /^\d{4}-\d\d-\d\dT/.test(v));
      if (failing && release) {
        failures += 1;
        throw new Error("INJECTED_RELEASE_FAILURE");
      }
    });
    const started = await startMonitor({
      taskId, command: "echo P1; sleep 2.5; echo P2; sleep 0.3; exit 0", description: "release-fails",
    });
    assert.ok(started.ok);
    const monitorId = started.ok ? started.monitor.id : "";
    const ofMonitor = async () => (await db.select().from(scheduledMessages)
      .where(eq(scheduledMessages.origin, `monitor:${monitorId}`)))
      .sort((x, y) => x.createdAt.localeCompare(y.createdAt));
    try {
      await until("「结束」落进去了、解除失败过", async () => failures > 0
        && (await ofMonitor()).some((m) => /哨兵结束/.test(m.text)), 15_000);
      const rows = await ofMonitor();
      assert.equal(rows.length, 2, "积压 + 最新那一批(带着「结束」)");
      assert.doesNotMatch(rows[0]!.text, /哨兵结束/);
      assert.ok(rows.every((m) => m.mergeHoldUntil && Date.parse(m.mergeHoldUntil) > Date.now()),
        "带着「结束」的那一行跟积压一起压着:谁也不会先把「结束」送到进展前面");
      const credential = (await db.select({ at: monitors.resultHandoffAt }).from(monitors)
        .where(eq(monitors.id, monitorId))).at(0)?.at;
      assert.ok(credential, "交接没做完 ⇒ 凭证还在,有人接着负责");
    } finally {
      failing = false;
      restore();
    }
    // 重投那一路:认出「已经入过队」也要先补做解除,才销凭证。
    await deliverResultHandoff(monitorId);
    await until("重投补做了解除、销了凭证", async () => {
      const rows = await ofMonitor();
      const left = (await db.select({ at: monitors.resultHandoffAt }).from(monitors)
        .where(eq(monitors.id, monitorId))).at(0)?.at;
      return rows.every((m) => m.mergeHoldUntil === null) && !left;
    });
    runs.releaseTurn(taskId, owner);
    await db.update(scheduledMessages).set({ status: "canceled" })
      .where(and(eq(scheduledMessages.taskId, taskId), eq(scheduledMessages.status, "pending")));
  }

  console.log("monitor merge window ok");
} finally {
  await teardown();
}
