// 「还欠着一声结束的哨兵,名下的行谁都领不走」(monitor-end-owed.ts,第 5 轮审查 1)。
//
// 上一版靠行上的期限撑着(收尾开始推到 30 秒后、收尾函数退出就解除),审查实测两条推断都错:
// 库慢过期限,扫描先把末批单独送走;结束入队失败一次,finally 照样解除。这里每一条都把期限**往前
// 拨到过去**(相当于等了任意久),再从每个领取入口去领 —— 放不放行只许看持久交接状态。
//
//  ⑬-1 收尾慢(终态那一笔压住):扫描、按任务扫描、单条领取、批量领取、回合里的交付都领不走;
//       放开之后一行送走 [output, ended]
//  ⑬-1b 收尾记号写不进库 ⇒ 这一进程里的收尾槽位照样挡着
//  ⑬-2 「结束」入队失败(收尾函数已经退出、凭证还在):照样谁都领不走;重投成功 ⇒ 一行送走
//  ⑬-3 「结束」落进最新那一行、解除窗口那一笔失败:两行都领不走;重投补做解除才放行(原 ⑫-2)
//  ⑬-4 收尾记号落了库、ash 没了(这一进程里没有槽位)⇒ 照样挡着;放弃了结果 / 接回确认进程还在 ⇒ 放行
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import {
  db, dbClient, makeTask, monitors, pending, root, runs, scheduledMessages, sessions, startMonitor, tasks, teardown, until,
} from "./monitors-fixture.js";
import { liveTurn, sleep } from "./monitor-turn-handoff-fixture.js";
import { handMonitorResultsOnPause } from "../src/monitor-turn-handoff.js";
import { deliverResultHandoff } from "../src/monitor-events.js";
import { beginPendingBatch } from "../src/pending-monitor-batch.js";
import { clearFinishing } from "../src/monitor-end-owed.js";
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

const rowsOf = async (monitorId: string) => (await db.select().from(scheduledMessages)
  .where(eq(scheduledMessages.origin, `monitor:${monitorId}`)))
  .sort((x, y) => x.createdAt.localeCompare(y.createdAt));
const monitorOf = async (monitorId: string) => (await db.select().from(monitors).where(eq(monitors.id, monitorId))).at(0)!;

/** 期限拨到一分钟前:不管等了多久,期限这一条都已经放行了。 */
async function expireHolds(monitorId: string): Promise<void> {
  await db.update(scheduledMessages).set({ mergeHoldUntil: new Date(Date.now() - 60_000).toISOString() })
    .where(and(eq(scheduledMessages.origin, `monitor:${monitorId}`), eq(scheduledMessages.status, "pending")));
}

/** 任务空着、上一回合早结束:领得走的话扫描当场就会领。 */
async function idleTask(): Promise<string> {
  const taskId = await makeTask({ status: "paused" });
  await db.insert(sessions).values({
    id: `s-${id()}`, taskId, role: "single", agentType: "claude", executor: "claude", cwd: root,
    startedAt: new Date(Date.now() - 60_000).toISOString(), endedAt: new Date(Date.now() - 30_000).toISOString(),
  });
  return taskId;
}

/** 扫描(全部 / 按任务)、单条领取、批量领取,一个都领不走。 */
async function nobodyTakes(monitorId: string, taskId: string, what: string): Promise<void> {
  await expireHolds(monitorId);
  await pending.deliverPendingMessages();
  await pending.deliverPendingMessages(taskId);
  for (const row of await rowsOf(monitorId)) {
    assert.deepEqual(await beginPendingBatch(row), [], `${what}:批量领取领不走`);
    assert.equal(await pending.beginDelivery(row.id), null, `${what}:单条领取领不走`);
  }
  await sleep(300);
  const rows = await rowsOf(monitorId);
  assert.ok(rows.length > 0 && rows.every((m) => m.status === "pending" && m.deliveringSince === null), `${what}:行原样在等`);
}

try {
  // ── ⑬-1 收尾慢:进程退了、终态那一笔压住 ⇒ 期限过了也谁都领不走 ─────────────────────────
  {
    const { taskId, token, owner } = await liveTurn();
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    let held = 0;
    const restore = onStatement(async (text) => {
      if (/update "monitors" set/i.test(text) && /"ended_reason"/.test(text) && held++ === 0) await gate;
    });
    const started = await startMonitor({ taskId, command: "echo FINAL_SLOW; exit 0", description: "slow-finish" });
    assert.ok(started.ok);
    const monitorId = started.ok ? started.monitor.id : "";
    try {
      await until("收尾停在写终态那一笔", async () => held > 0 && (await rowsOf(monitorId)).length > 0, 10_000);
      assert.ok((await monitorOf(monitorId)).finishingSince, "收尾开始的记号落了库");
      await expireHolds(monitorId);
      assert.equal(await handMonitorResultsOnPause(taskId, token, []), null, "回合里的交付领不走");
      runs.releaseTurn(taskId, owner);
      await db.update(tasks).set({ status: "paused" }).where(eq(tasks.id, taskId));
      await nobodyTakes(monitorId, taskId, "收尾没做完");
      assert.doesNotMatch((await rowsOf(monitorId))[0]!.text, /哨兵结束/);
    } finally {
      open();
      restore();
    }
    await until("结束并进来、一起送出", async () => {
      const rows = await rowsOf(monitorId);
      return rows.every((m) => m.status === "sent") && rows.some((m) => /哨兵结束/.test(m.text));
    });
    const rows = await rowsOf(monitorId);
    assert.equal(rows.length, 1, "只有一条消息");
    assert.deepEqual((rows[0]!.monitorWake?.events ?? []).map((e) => e.kind), ["output", "ended"]);
    await until("那一回合跑完", async () => !runs.isTurnClaimed(taskId));
  }

  // ── ⑬-1b 收尾记号写不进库、终态那一笔又慢 ⇒ 这一进程里的收尾槽位照样挡着 ─────────────────────
  {
    const taskId = await idleTask();
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    let held = 0;
    let markFailures = 0;
    const restore = onStatement(async (text) => {
      if (/update "monitors" set "finishing_since"/i.test(text)) {
        markFailures += 1;
        throw new Error("INJECTED_MARK_FAILURE");
      }
      if (/update "monitors" set/i.test(text) && /"ended_reason"/.test(text) && held++ === 0) await gate;
    });
    const started = await startMonitor({ taskId, command: "echo FINAL_NO_MARK; sleep 0.3; exit 0", description: "mark-fails" });
    assert.ok(started.ok);
    const monitorId = started.ok ? started.monitor.id : "";
    try {
      await until("记号没落上、收尾停在写终态那一笔", async () => markFailures > 0 && held > 0, 10_000);
      assert.equal((await monitorOf(monitorId)).finishingSince, null);
      await nobodyTakes(monitorId, taskId, "记号没落上");
    } finally {
      open();
      restore();
    }
    await until("结束并进来、一起送出", async () => {
      const rows = await rowsOf(monitorId);
      return rows.every((m) => m.status === "sent") && rows.some((m) => /哨兵结束/.test(m.text));
    });
    assert.deepEqual(((await rowsOf(monitorId))[0]!.monitorWake?.events ?? []).map((e) => e.kind), ["output", "ended"]);
    await until("那一回合跑完", async () => !runs.isTurnClaimed(taskId));
  }

  // ── ⑬-2 「结束」入队失败:收尾函数已经退出、凭证还在 ⇒ 照样谁都领不走;重投成功才放行 ──────
  {
    const taskId = await idleTask();
    let failing = true;
    let failures = 0;
    // 「结束」并进那一行的那条 UPDATE(带着交接身份)一直失败,直到撤掉。
    const restore = onStatement(async (text) => {
      if (failing && /update "scheduled_messages" set "text"/i.test(text) && /"handoff_token"/.test(text)) {
        failures += 1;
        throw new Error("INJECTED_END_ENQUEUE_FAILURE");
      }
    });
    const started = await startMonitor({ taskId, command: "echo OUTPUT_END_FAILS; sleep 0.5; exit 0", description: "end-enqueue-fails" });
    assert.ok(started.ok);
    const monitorId = started.ok ? started.monitor.id : "";
    try {
      await until("终态落了、入队失败过", async () => failures > 0 && (await monitorOf(monitorId)).status === "exited", 10_000);
      await sleep(200);   // 收尾函数的 finally 跑完
      const m = await monitorOf(monitorId);
      assert.ok(m.resultHandoffAt, "凭证还在:这一笔交接没做完");
      await nobodyTakes(monitorId, taskId, "结束没入队");
      const rows = await rowsOf(monitorId);
      assert.equal(rows.length, 1);
      assert.doesNotMatch(rows[0]!.text, /哨兵结束/, "托盘里只有输出,它一个人走不了");
    } finally {
      failing = false;
      restore();
    }
    assert.equal(await deliverResultHandoff(monitorId), "delivered");
    await until("重投成功、一行送走", async () => {
      const rows = await rowsOf(monitorId);
      return rows.every((r) => r.status === "sent") && rows.some((r) => /哨兵结束/.test(r.text));
    });
    const rows = await rowsOf(monitorId);
    assert.equal(rows.length, 1, "只有一条消息");
    assert.deepEqual((rows[0]!.monitorWake?.events ?? []).map((e) => e.kind), ["output", "ended"]);
    assert.equal((await monitorOf(monitorId)).resultHandoffAt, null);
    await until("那一回合跑完", async () => !runs.isTurnClaimed(taskId));
  }

  // ── ⑬-3 「结束」落进最新那一行、解除窗口那一笔失败 ⇒ 两行都领不走;重投补做解除才放行 ──────────
  {
    const { taskId, owner } = await liveTurn();
    let failing = true;
    let failures = 0;
    // 解除窗口那一笔(把期限清空的那一条 UPDATE;拨期限的那一条带着时间戳,不碰它)一直失败。
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
    try {
      await until("「结束」落进去了、解除失败过", async () => failures > 0
        && (await rowsOf(monitorId)).some((m) => /哨兵结束/.test(m.text)), 15_000);
      const rows = await rowsOf(monitorId);
      assert.equal(rows.length, 2, "积压 + 最新那一批(带着「结束」)");
      assert.doesNotMatch(rows[0]!.text, /哨兵结束/);
      assert.ok((await monitorOf(monitorId)).resultHandoffAt, "交接没做完 ⇒ 凭证还在,有人接着负责");
      runs.releaseTurn(taskId, owner);
      await db.update(tasks).set({ status: "paused" }).where(eq(tasks.id, taskId));
      await nobodyTakes(monitorId, taskId, "解除没做成");
    } finally {
      failing = false;
      restore();
    }
    await deliverResultHandoff(monitorId);
    await until("重投补做了解除、销了凭证、送出去", async () => {
      const rows = await rowsOf(monitorId);
      return rows.every((m) => m.status === "sent") && !(await monitorOf(monitorId)).resultHandoffAt;
    });
    const rows = await rowsOf(monitorId);
    assert.match(rows.at(-1)!.text, /P2[\s\S]*哨兵结束/, "「结束」跟最后一批在一起");
    await until("回合都跑完", async () => !runs.isTurnClaimed(taskId));
  }

  // ── ⑬-4 收尾记号落了库、这一进程里没有槽位(ash 死在收尾中间)⇒ 照样挡着 ────────────────────
  {
    const { taskId, owner } = await liveTurn();
    const started = await startMonitor({ taskId, command: "echo BEFORE_CRASH; sleep 30", description: "crashed-mid-finish" });
    assert.ok(started.ok);
    const monitorId = started.ok ? started.monitor.id : "";
    await until("输出进了托盘", async () => (await rowsOf(monitorId)).some((m) => m.text.includes("BEFORE_CRASH")), 10_000);
    // 上一辈子的 ash 开始收尾、落下记号就没了:库里是这个样子,内存里什么都没有。
    await db.update(monitors).set({ finishingSince: new Date().toISOString() }).where(eq(monitors.id, monitorId));
    runs.releaseTurn(taskId, owner);
    await db.update(tasks).set({ status: "paused" }).where(eq(tasks.id, taskId));
    await nobodyTakes(monitorId, taskId, "记号在、终态没落");
    // 接回确认当初那个进程还活着 ⇒ 它回到在盯,不再欠结束,这一批照常送。
    await clearFinishing(monitorId);
    await expireHolds(monitorId);
    await pending.deliverPendingMessages(taskId);
    await until("放行之后照常送", async () => (await rowsOf(monitorId)).every((m) => m.status === "sent"));
    await until("那一回合跑完", async () => !runs.isTurnClaimed(taskId));
  }

  // ── ⑬-4b 放弃了结果的不算欠:记号在也照送 ───────────────────────────────────────────────
  {
    const { taskId, owner } = await liveTurn();
    const started = await startMonitor({ taskId, command: "echo ABANDONED_OUTPUT; sleep 30", description: "abandoned" });
    assert.ok(started.ok);
    const monitorId = started.ok ? started.monitor.id : "";
    await until("输出进了托盘", async () => (await rowsOf(monitorId)).some((m) => m.text.includes("ABANDONED_OUTPUT")), 10_000);
    await db.update(monitors).set({ finishingSince: new Date().toISOString(), resultsAbandonedAt: new Date().toISOString() })
      .where(eq(monitors.id, monitorId));
    runs.releaseTurn(taskId, owner);
    await db.update(tasks).set({ status: "paused" }).where(eq(tasks.id, taskId));
    await expireHolds(monitorId);
    await pending.deliverPendingMessages(taskId);
    await until("放弃了的照常送", async () => (await rowsOf(monitorId)).every((m) => m.status === "sent"));
    await until("那一回合跑完", async () => !runs.isTurnClaimed(taskId));
  }

  console.log("monitor end owed ok");
} finally {
  await teardown();
}
