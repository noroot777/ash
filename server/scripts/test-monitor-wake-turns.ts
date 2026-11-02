// 「N 轮,其中哨兵唤醒 M 轮」那个 M 的来源:`session_turns.monitor_wake`。
//
// 覆盖:
//   ① 开回合时写下这一位,普通回合是 0;
//   ② 只升不降 —— 收尾先补插出来的行(不知道这件事)由迟到的开始信息补上,之后不带它的重放
//      不许把它抹回 0;
//   ③ 会话出口按会话汇总(`sessionsForTask` 的 `monitorWakeTurns`);
//   ④ 历史回填按转录里的唤醒回合精确对身份,对不上的不记,做完只做一次。
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

const { db, dbClient, ensureSchema } = await import("../src/db/index.js");
const { projects, sessions, tasks } = await import("../src/db/schema.js");
const turns = await import("../src/session-turns.js");
const { sessionsForTask } = await import("../src/task-session-routes.js");
const { backfillMonitorWakeTurns } = await import("../src/monitor-wake-turns-backfill.js");
const { TURN_SENTINEL } = await import("../src/transcript.js");

const base = Date.now() - 60 * 60 * 1000;
const at = (seconds: number) => new Date(base + seconds * 1000).toISOString();

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
      cwd: stage, startedAt: at(0), activeMs: 0, exitStatus: 0, usageTurns: 3,
      ...turns.freshTurnFields(at(0)),
    });
    return `${taskId}-s`;
  };
  const wakeOf = async (sid: string, startedAt: string) => Number((await dbClient.execute({
    sql: "SELECT monitor_wake FROM session_turns WHERE session_id = :sid AND started_at = :at",
    args: { sid, at: startedAt },
  })).rows[0]?.monitor_wake);

  // ── ① 开回合时写下 ──────────────────────────────────────────────────────────
  {
    const sid = await seed("Open");
    await turns.openTurn({ sessionId: sid, taskId: "Open", cwd: stage, startedAt: at(1) });
    await turns.openTurn({ sessionId: sid, taskId: "Open", cwd: stage, startedAt: at(2), monitorWake: true });
    await turns.openTurn({ sessionId: sid, taskId: "Open", cwd: stage, startedAt: at(3), monitorWake: true });
    assert.equal(await wakeOf(sid, at(1)), 0, "普通回合被记成了哨兵唤醒");
    assert.equal(await wakeOf(sid, at(2)), 1, "哨兵唤醒的回合没记下来");
    assert.deepEqual([...await turns.monitorWakeTurnsForTask("Open")], [[sid, 2]]);
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

  // ── ③ 会话出口 ──────────────────────────────────────────────────────────────
  {
    const [open] = await sessionsForTask("Open");
    assert.equal(open.monitorWakeTurns, 2, "会话出口没带出唤醒轮数");
    const sid = await seed("None");
    await turns.openTurn({ sessionId: sid, taskId: "None", cwd: stage, startedAt: at(1) });
    const [none] = await sessionsForTask("None");
    assert.equal(none.monitorWakeTurns, 0, "没有唤醒的会话该是 0,不是缺省");
  }

  // ── ④ 历史回填 ──────────────────────────────────────────────────────────────
  {
    const sid = await seed("Past");
    for (const second of [1, 2, 3]) {
      await turns.recordTurnSpan({ sessionId: sid, taskId: "Past", cwd: stage, startedAt: at(second), endedAt: at(second + 0.5), outcome: "completed" });
    }
    const line = (turn: Record<string, unknown>) => `\n${TURN_SENTINEL}${JSON.stringify(turn)}\n`;
    mkdirSync(join(stage, "runs", "Past"), { recursive: true });
    writeFileSync(join(stage, "runs", "Past", `${sid}.md`), [
      line({ t: "user", agent: "claude", text: "开工", at: at(1) }),
      "正文\n",
      // 对得上身份的唤醒 → 记
      line({ t: "user", agent: "claude", text: "【哨兵事件】", by: "system", monitorWake: { events: [] }, at: at(2) }),
      // 系统代写但不是唤醒(验证打回之类) → 不记
      line({ t: "user", agent: "claude", text: "打回", by: "system", at: at(3) }),
      // 唤醒,但库里没有这个身份的回合行 → 不猜
      line({ t: "user", agent: "claude", text: "【哨兵事件】", by: "system", monitorWake: { events: [] }, at: at(9) }),
      `${TURN_SENTINEL}{"t":"user","monitorWake":`, // 写到一半的行
    ].join(""));

    const first = await backfillMonitorWakeTurns();
    assert.equal(first.alreadyApplied, false);
    assert.equal(await wakeOf(sid, at(2)), 1, "对得上身份的唤醒回合没回填上");
    assert.equal(await wakeOf(sid, at(1)), 0);
    assert.equal(await wakeOf(sid, at(3)), 0, "系统代写的非唤醒回合被当成了唤醒");
    assert.deepEqual(first, { alreadyApplied: false, sessions: 1, turns: 1 },
      "回填的计数不对 —— 已经是 1 的行不该再算,对不上的身份不该猜");
    const second = await backfillMonitorWakeTurns();
    assert.equal(second.alreadyApplied, true, "回填做完没留标记,每次启动都会再扫一遍");
  }

  console.log("✓ monitor wake turns: 开回合记下、只升不降、会话出口按会话汇总、历史按转录精确回填且只做一次");
} finally {
  await dbClient.close();
  await releaseTmpDb();
  rmSync(stage, { recursive: true, force: true });
}
