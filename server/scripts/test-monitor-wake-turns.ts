// 「N 轮,其中哨兵唤醒 M 轮」:M 必须是 N 所数那批回合里带哨兵来源的子集。
//
// N 是报账时加的(`usage_turns`),所以 M 也只能在**同一笔报账**里按回合身份加
// (`usage_monitor_wake_turns`)。覆盖:
//   ① 报账按回合身份判唤醒;开了却没报账的唤醒回合(失败/被停)不占 N 里的位置;
//   ② 回合行上那一位只升不降 —— 收尾先补插的行由迟到的开始信息补上,不带它的重放不抹回 0;
//   ③ 开始行写失败时那一位绑在身份上:报账照样认得出,收尾补插把它落进库,之后才解绑;
//   ⑥ 团队调度台投递口一收下就放开消费:用量先于开始行到,也按身份认得出是唤醒(第 2 轮审查 F1);
//   ④ 历史回填按转录(哪几轮是唤醒)× trace(哪几轮报过账)精确对身份,只做一次;
//   ⑤ 回填遇到读不动的证据不写完成标记,恢复后下次补上;确实不存在的文件算处理完。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireTmpDb, releaseTmpDb } from "./tmp-db.js";

requireTmpDb("monitor-wake-turns");
const stage = realpathSync(mkdtempSync(join(tmpdir(), "ash-wake-turns-")));
process.env.ASH_DB = join(stage, "wake.db");
process.env.ASH_RUNS_DIR = join(stage, "runs");
process.env.ASH_UPLOADS_DIR = join(stage, "uploads");

const { eq } = await import("drizzle-orm");
const { db, dbClient, ensureSchema } = await import("../src/db/index.js");
const { appSettings, projects, sessions, tasks } = await import("../src/db/schema.js");
const turns = await import("../src/session-turns.js");
const { addSessionUsage, recordSessionUsageEvent } = await import("../src/usage.js");
const { sendToLead } = await import("../src/team/lead-delivery.js");
const { createLeadTurnStart } = await import("../src/team/lead-turn-begin.js");
const { sessionsForTask } = await import("../src/task-session-routes.js");
const { backfillMonitorWakeTurns } = await import("../src/monitor-wake-turns-backfill.js");
const { TURN_SENTINEL } = await import("../src/transcript.js");

const base = Date.now() - 60 * 60 * 1000;
const at = (seconds: number) => new Date(base + seconds * 1000).toISOString();
const USAGE = { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: null, turns: 1 };

try {
  await ensureSchema();
  await db.insert(projects).values({ id: "p", name: "wake", repoPath: stage, createdAt: at(0) });
  const seed = async (taskId: string) => {
    await db.insert(tasks).values({
      id: taskId, projectId: "p", title: taskId, body: "-", mode: "single", status: "done",
      agentType: "claude", useWorktree: false, createdAt: at(0), updatedAt: at(0),
    });
    await db.insert(sessions).values({
      id: `${taskId}-s`, taskId, role: "single", agentType: "claude", executor: "claude",
      cwd: stage, startedAt: at(0), activeMs: 0, exitStatus: 0,
      ...turns.freshTurnFields(at(0)),
    });
    return `${taskId}-s`;
  };
  const wakeOf = async (sid: string, startedAt: string) => Number((await dbClient.execute({
    sql: "SELECT monitor_wake FROM session_turns WHERE session_id = :sid AND started_at = :at",
    args: { sid, at: startedAt },
  })).rows[0]?.monitor_wake);
  const split = async (taskId: string) => {
    const [session] = await sessionsForTask(taskId);
    return { turns: session.usage?.turns ?? 0, wakes: session.monitorWakeTurns };
  };

  // ── ① 报账按回合身份判唤醒 ──────────────────────────────────────────────────
  {
    const sid = await seed("Book");
    await turns.openTurn({ sessionId: sid, taskId: "Book", cwd: stage, startedAt: at(1) });
    await addSessionUsage(sid, USAGE, { kind: "incremental" }, at(1));
    await turns.openTurn({ sessionId: sid, taskId: "Book", cwd: stage, startedAt: at(2), monitorWake: true });
    await addSessionUsage(sid, USAGE, { kind: "incremental" }, at(2));
    assert.equal(await wakeOf(sid, at(1)), 0, "普通回合被记成了哨兵唤醒");
    assert.equal(await wakeOf(sid, at(2)), 1, "哨兵唤醒的回合没记下来");
    assert.deepEqual(await split("Book"), { turns: 2, wakes: 1 });
    // 唤醒回合开了、没报账就失败了:它不在 N 里,也就不许出现在 M 里(第 1 轮审查 F1)。
    await turns.openTurn({ sessionId: sid, taskId: "Book", cwd: stage, startedAt: at(3), monitorWake: true });
    await turns.recordTurnSpan({ sessionId: sid, taskId: "Book", cwd: stage, startedAt: at(3), endedAt: at(4), outcome: "failed" });
    assert.deepEqual(await split("Book"), { turns: 2, wakes: 1 }, "没报账的唤醒回合被算进了哨兵轮数");
  }

  // ── ② 只升不降 ──────────────────────────────────────────────────────────────
  {
    const sid = await seed("Late");
    await turns.recordTurnSpan({ sessionId: sid, taskId: "Late", cwd: stage, startedAt: at(1), endedAt: at(5), outcome: "completed" });
    assert.equal(await wakeOf(sid, at(1)), 0);
    await turns.openTurn({ sessionId: sid, taskId: "Late", cwd: stage, startedAt: at(1), monitorWake: true }, { register: false });
    assert.equal(await wakeOf(sid, at(1)), 1, "收尾先补插的行,迟到的开始信息没把「哨兵唤醒」补上");
    await turns.openTurn({ sessionId: sid, taskId: "Late", cwd: stage, startedAt: at(1) }, { register: false });
    await turns.recordTurnSpan({ sessionId: sid, taskId: "Late", cwd: stage, startedAt: at(1), endedAt: at(6), outcome: "completed" });
    assert.equal(await wakeOf(sid, at(1)), 1, "不带这一位的重放把它抹回了 0");
  }

  // ── ③ 开始行写失败:来源绑在身份上,收尾补插继承它(第 1 轮审查 F2) ────────────
  {
    const sid = await seed("Owed");
    const realBatch = dbClient.batch;
    let injected = 0;
    dbClient.batch = (async () => { injected += 1; throw new Error("注入:开始写库与立即重试都撞上 SQLITE_BUSY"); }) as typeof dbClient.batch;
    try {
      await turns.openTurn({ sessionId: sid, taskId: "Owed", cwd: stage, startedAt: at(1), monitorWake: true });
    } finally {
      dbClient.batch = realBatch;
    }
    assert.equal(injected, 2, "注入没覆盖到开始写库和立即重试两次");
    assert.equal(turns.unconfirmedTurns(sid), 1);
    assert.equal(turns.boundMonitorWake(sid, at(1)), true, "开始行没落成,身份上没绑着「哨兵唤醒」");
    // 不带这一位的同身份失败重放不许把它覆盖掉:直接再失败一次开始。
    dbClient.batch = (async () => { throw new Error("注入:再失败一次"); }) as typeof dbClient.batch;
    try {
      await turns.openTurn({ sessionId: sid, taskId: "Owed", cwd: stage, startedAt: at(1) }, { register: false });
    } finally {
      dbClient.batch = realBatch;
    }
    assert.equal(turns.boundMonitorWake(sid, at(1)), true, "不带标记的失败重放把身份上的「哨兵唤醒」解掉了");
    await addSessionUsage(sid, USAGE, { kind: "incremental" }, at(1));
    await turns.recordTurnSpan({ sessionId: sid, taskId: "Owed", cwd: stage, startedAt: at(1), endedAt: at(2), outcome: "completed" });
    assert.equal(turns.unconfirmedTurns(sid), 0, "收尾补插之后欠账没消");
    assert.equal(await wakeOf(sid, at(1)), 1, "收尾补插把欠账里的「哨兵唤醒」丢了");
    assert.deepEqual(await split("Owed"), { turns: 1, wakes: 1 }, "开始行没落成时报账认不出这是唤醒回合");
    assert.equal(turns.boundMonitorWake(sid, at(1)), false, "落进库之后身份上的绑定没解,内存只增不减");
  }

  // ── ⑥ 团队调度台:投递口收下就放开消费,用量先于开始行到 ─────────────────────────
  // 生产顺序原样走一遍,不注入延迟:`push` 里 `await sendToLead` → `void beginTurn(...)`,消费循环
  // 同时就可能读到这一轮的用量。两次唤醒都完成了,就该是两次。
  {
    const sid = await seed("Lead");
    await db.update(tasks).set({ mode: "team" }).where(eq(tasks.id, "Lead"));
    const lead = {
      taskId: "Lead", sessId: sid, cwd: stage, retired: false, busy: false, turnStart: null as string | null,
      model: null, reasoningEffort: null, agentType: "claude",
      handle: { send: () => true, interrupt: () => {} },
    } as unknown as Parameters<typeof sendToLead>[0];
    const beginTurn = createLeadTurnStart({ setLeadStatus: async () => {} });
    for (const second of [10, 20]) {
      const delivery = await sendToLead(lead, "【哨兵事件】", { steer: true, monitorWake: true });
      assert.ok(delivery.at);
      const starting = beginTurn(lead, delivery.at);
      await recordSessionUsageEvent(sid, { kind: "usage", usage: USAGE }, "claude", null, delivery.at);
      await starting;
      await turns.recordTurnSpan({ sessionId: sid, taskId: "Lead", cwd: stage, startedAt: delivery.at, endedAt: at(second), outcome: "completed" });
      assert.equal(await wakeOf(sid, delivery.at), 1);
      assert.equal(turns.boundMonitorWake(sid, delivery.at), false, "落库之后身份上的绑定没解");
    }
    assert.deepEqual(await split("Lead"), { turns: 2, wakes: 2 }, "用量先于开始行到的那一轮被当成了普通回合");
    // 对照:普通插话不带来源,不许被算成唤醒。
    const plain = await sendToLead(lead, "普通插话", { steer: true });
    await recordSessionUsageEvent(sid, { kind: "usage", usage: USAGE }, "claude", null, plain.at);
    assert.deepEqual(await split("Lead"), { turns: 3, wakes: 2 }, "普通插话被算成了哨兵唤醒");
  }

  const line = (turn: Record<string, unknown>) => `\n${TURN_SENTINEL}${JSON.stringify(turn)}\n`;
  const wakeLine = (second: number) => line({ t: "user", agent: "claude", text: "【哨兵事件】", by: "system", monitorWake: { events: [] }, at: at(second) });
  const usageLine = (second: number) => `${JSON.stringify({ at: at(second + 0.2), turnStartedAt: at(second), event: { kind: "usage", usage: USAGE } })}\n`;

  // ── ④ 历史回填 ──────────────────────────────────────────────────────────────
  {
    const sid = await seed("Past");
    for (const second of [1, 2, 3, 4]) {
      await turns.recordTurnSpan({ sessionId: sid, taskId: "Past", cwd: stage, startedAt: at(second), endedAt: at(second + 0.5), outcome: "completed" });
    }
    await db.update(sessions).set({ usageTurns: 3 }).where(eq(sessions.id, sid));
    mkdirSync(join(stage, "runs", "Past"), { recursive: true });
    writeFileSync(join(stage, "runs", "Past", `${sid}.md`), [
      line({ t: "user", agent: "claude", text: "开工", at: at(1) }),
      "正文\n",
      wakeLine(2), // 唤醒且报过账 → 记,计数 +1
      line({ t: "user", agent: "claude", text: "打回", by: "system", at: at(3) }), // 系统代写但不是唤醒 → 不记
      wakeLine(4), // 唤醒但没报账(失败) → 标记照记,计数不加
      wakeLine(9), // 唤醒,但库里没有这个身份的回合行 → 不猜
      `${TURN_SENTINEL}{"t":"user","monitorWake":`, // 写到一半的行
    ].join(""));
    writeFileSync(join(stage, "runs", "Past", `${sid}.trace.jsonl`), [usageLine(1), usageLine(2), usageLine(3)].join(""));

    const first = await backfillMonitorWakeTurns();
    assert.equal(await wakeOf(sid, at(2)), 1, "对得上身份的唤醒回合没回填上");
    assert.equal(await wakeOf(sid, at(4)), 1, "没报账的唤醒回合也是唤醒,标记该记");
    assert.equal(await wakeOf(sid, at(1)), 0);
    assert.equal(await wakeOf(sid, at(3)), 0, "系统代写的非唤醒回合被当成了唤醒");
    assert.deepEqual(first, { alreadyApplied: false, sessions: 1, turns: 1, retry: 0 },
      "回填计数不对 —— 只该数「是唤醒、且 trace 里报过账」的那一笔");
    assert.deepEqual(await split("Past"), { turns: 3, wakes: 1 });
    assert.equal((await backfillMonitorWakeTurns()).alreadyApplied, true, "回填做完没留标记,每次启动都会再扫一遍");
  }

  // ── ⑤ 读不动的证据不封存完成标记(第 1 轮审查 F3) ───────────────────────────
  {
    await db.delete(appSettings);
    const sid = await seed("Flaky");
    await turns.recordTurnSpan({ sessionId: sid, taskId: "Flaky", cwd: stage, startedAt: at(2), endedAt: at(3), outcome: "completed" });
    await db.update(sessions).set({ usageTurns: 1 }).where(eq(sessions.id, sid));
    const transcript = join(stage, "runs", "Flaky", `${sid}.md`);
    mkdirSync(transcript, { recursive: true }); // 读它 = EISDIR:不是「没有」,是「这次没读到」
    const blocked = await backfillMonitorWakeTurns();
    assert.equal(blocked.retry, 1, "读不动的转录被当成了「没有证据」");
    assert.equal(await db.select().from(appSettings).get(), undefined, "有会话没读到证据,却写了完成标记");
    rmSync(transcript, { recursive: true });
    writeFileSync(transcript, wakeLine(2));
    writeFileSync(join(stage, "runs", "Flaky", `${sid}.trace.jsonl`), usageLine(2));
    const recovered = await backfillMonitorWakeTurns();
    assert.deepEqual(recovered, { alreadyApplied: false, sessions: 1, turns: 1, retry: 0 },
      "证据恢复后没补上,或者把已经补过的会话又算了一遍");
    assert.deepEqual(await split("Flaky"), { turns: 1, wakes: 1 });
    assert.deepEqual(await split("Past"), { turns: 3, wakes: 1 }, "重跑把补过的会话又加了一遍");
    assert.ok(await db.select().from(appSettings).get(), "全部处理完仍没写完成标记");
  }

  console.log("✓ monitor wake turns: 报账按回合身份判唤醒且是总轮数的子集、只升不降、来源绑在身份上直到落库(含团队用量先到)、历史按转录×trace 精确回填、读不动不封存");
} finally {
  await dbClient.close();
  await releaseTmpDb();
  rmSync(stage, { recursive: true, force: true });
}
