// 回合记录的**持久化契约**：同一个身份在库里只能往前走——「无行 → 开了 → 收了」。开始和
// 结束哪个先到、重放几次、并发撞在一起,都不许丢掉已经拿到的结束事实。
//
// 为什么跟 `test-session-turn-identity.ts` 分成两条：那条盯的是**身份**（计数、欠账、活动
// 登记、起点唯一),这条盯的是**那一行本身**（原子合并、撞号降级)。两条合一个文件会顶破
// 单文件上限,而且夹具也不是一套:这条刻意不起真 CLI,直接并发调两个生产写入函数。
//
// 覆盖（都来自第 1 轮审查）：
//   F1 空行竞争 / 已有空行 / 已有结束行 / 反序重放 四个分支 + 用户看得见的那条清单；
//   F2 重启后墙钟回拨到历史同一毫秒:接回水位就不撞;真撞上了照实降级成未知,绝不静默;
//   N3 任务真被删了,内存里那几笔欠账跟着收。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireTmpDb, releaseTmpDb } from "./tmp-db.js";

requireTmpDb("session-turn-persist");
const stage = realpathSync(mkdtempSync(join(tmpdir(), "ash-turn-persist-")));
process.env.ASH_DB = join(stage, "persist.db");
process.env.ASH_RUNS_DIR = join(stage, "runs");
process.env.ASH_UPLOADS_DIR = join(stage, "uploads");

const { db, dbClient, ensureSchema } = await import("../src/db/index.js");
const { projects, sessions, tasks } = await import("../src/db/schema.js");
const { readTaskArtifacts } = await import("../src/task-artifacts.js");
const turns = await import("../src/session-turns.js");

// 12 小时前起算：产物扫描对「未来的 mtime」没有意义,而区间判据全是绝对时刻。
const base = Date.now() - 12 * 60 * 60 * 1000;
const at = (seconds: number) => new Date(base + seconds * 1000).toISOString();
const roots = new Map<string, string>();

try {
  await ensureSchema();
  await db.insert(projects).values({ id: "p", name: "persist", repoPath: stage, createdAt: at(0) });

  /** 一个任务 + 它自己的非 Git 目录（刻意不进仓库:这条测的是时间证据,不是提交证据）。 */
  const seed = async (taskId: string) => {
    const root = join(stage, taskId);
    mkdirSync(join(root, "output"), { recursive: true });
    roots.set(taskId, root);
    await db.insert(tasks).values({
      id: taskId, projectId: "p", title: taskId, body: "-", mode: "single", status: "done",
      agentType: "codex", useWorktree: false, createdAt: at(0), updatedAt: at(0),
    });
    return root;
  };
  /** 会话行。`freshTurnFields` = 本版写端建出来的形状（迁移确认过、没有未知历史）。 */
  const addSession = async (taskId: string, root: string, extra: Record<string, unknown> = {}) => {
    await db.insert(sessions).values({
      id: `${taskId}-s`, taskId, role: "single", agentType: "codex", executor: "codex",
      cwd: root, startedAt: at(0), activeMs: 0, exitStatus: 0,
      ...turns.freshTurnFields(at(0)), ...extra,
    });
    return `${taskId}-s`;
  };
  const svg = (root: string, file: string, seconds: number) => {
    const path = join(root, "output", file);
    writeFileSync(path, `<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"></svg>`);
    utimesSync(path, new Date(base + seconds * 1000), new Date(base + seconds * 1000));
  };
  const turnRows = async (sessionId: string) => (await dbClient.execute({
    sql: "SELECT started_at, ended_at, cwd FROM session_turns WHERE session_id = :sid ORDER BY started_at",
    args: { sid: sessionId },
  })).rows;
  const counters = async (sessionId: string) => (await dbClient.execute({
    sql: "SELECT turns_started, turns_lost FROM sessions WHERE id = :sid",
    args: { sid: sessionId },
  })).rows[0];
  const listing = async (taskId: string) => {
    const root = roots.get(taskId)!;
    const got = await readTaskArtifacts(taskId, {
      path: root, repo: root, gitRepo: false, branch: null, source: "session", projectId: "p",
    });
    assert.equal(got.error, null, `${taskId}: 清单该读得通`);
    return got;
  };
  const names = (got: { artifacts: { path: string }[] }) =>
    got.artifacts.map((a) => a.path.split("/").at(-1)).sort();

  // ── ① 空行竞争：收尾和迟到的开始并发撞在一起,已知的收尾时刻不许蒸发 ──────────────
  // 先查一眼再决定插还是改的那一版,在查与写之间让出执行权,`openTurn` 插进去的空行会把补插
  // 挡掉（INSERT OR IGNORE),函数照样正常返回、照样确认欠账,但 `ended_at` 从此是空的
  // ——读端于是把那一轮估到下一轮起点,停工期间别人做的图被收进来,面板还反过来说
  // 「这次运行没有正常结束」（第 1 轮审查 F1,实测只要 Promise.all,不需要任何写库故障）。
  {
    const root = await seed("RaceTask001");
    const sid = await addSession("RaceTask001", root, { endedAt: at(10) });
    const close = { sessionId: sid, taskId: "RaceTask001", cwd: root, startedAt: at(0), endedAt: at(10) };
    turns.markTurnActive(close);
    await Promise.all([turns.recordTurnSpan(close), turns.openTurn(close)]);
    const rows = await turnRows(sid);
    assert.equal(rows.length, 1, "一个身份一行");
    assert.equal(String(rows[0].ended_at), at(10), "并发的开始写入不许吞掉已经拿到的收尾时刻（F1）");
    const nums = await counters(sid);
    assert.equal(Number(nums.turns_started), 1, "同一个身份并发开两次只能计一轮");
    assert.equal(nums.turns_lost ?? 0, 0, "这是同一轮的正常交错,不是撞号,不许凭空记一笔缺口");

    // 用户看得见的那一面：第二轮跑完之后,中间那段停工期里别人做的图不许混进来。
    await dbClient.execute({
      sql: "UPDATE sessions SET turn_started_at = :start, ended_at = :end WHERE id = :sid",
      args: { start: at(3600), end: at(3610), sid },
    });
    await turns.openTurn({ ...close, startedAt: at(3600) });
    await turns.recordTurnSpan({ ...close, startedAt: at(3600), endedAt: at(3610) });
    svg(root, "own-first.svg", 5);
    svg(root, "other-task-in-break.svg", 1800);
    svg(root, "own-second.svg", 3605);
    const got = await listing("RaceTask001");
    assert.deepEqual(names(got), ["own-first.svg", "own-second.svg"], "两轮之间别人做的东西不是它的");
    assert.deepEqual(got.incomplete, [], "正常写入全成功,不许凭空报一句「异常收尾」");
  }

  // ── ①' 反过来的并发顺序（先 openTurn 再 recordTurnSpan）同样成立 ────────────────
  // 这一序才真正考撞号判据的时机：`openTurn` 拿到「这是新的一轮」之后还要 await 一次,
  // 期间 `recordTurnSpan` 已经把这个身份收口了。判据要是在那之前就定死,库里这条刚被自己
  // 收口的行会被当成「撞上历史记录」,凭空多一笔持久缺口。
  {
    const root = await seed("RaceTask002");
    const sid = await addSession("RaceTask002", root, { endedAt: at(10) });
    const close = { sessionId: sid, taskId: "RaceTask002", cwd: root, startedAt: at(0), endedAt: at(10) };
    turns.markTurnActive(close);
    await Promise.all([turns.openTurn(close), turns.recordTurnSpan(close)]);
    const rows = await turnRows(sid);
    assert.equal(rows.length, 1);
    assert.equal(String(rows[0].ended_at), at(10), "反序并发也不许丢掉收尾时刻");
    const nums = await counters(sid);
    assert.equal(Number(nums.turns_started), 1);
    assert.equal(nums.turns_lost ?? 0, 0, "自己刚收口的那一行不是撞号（判据要在落批那一刻才定）");
  }

  // ── ② 已有空行：正常的「先开后收」── ───────────────────────────────────────────
  {
    const root = await seed("OpenThenEnd");
    const sid = await addSession("OpenThenEnd", root, { endedAt: at(10) });
    await turns.openTurn({ sessionId: sid, taskId: "OpenThenEnd", cwd: root, startedAt: at(0) });
    assert.equal((await turnRows(sid))[0].ended_at, null, "开的时候就该是「还没收口」");
    await turns.recordTurnSpan({ sessionId: sid, taskId: "OpenThenEnd", cwd: null, startedAt: at(0), endedAt: at(10) });
    const rows = await turnRows(sid);
    assert.equal(rows.length, 1);
    assert.equal(String(rows[0].ended_at), at(10), "收尾合并到现存那一行上");
    assert.equal(String(rows[0].cwd), root, "收尾那下没带目录,不该把开始时记下的那个抹掉");
    assert.equal(Number((await counters(sid)).turns_started), 1, "合并不是新一轮,不许再加一次数");
  }

  // ── ③ 已有结束行：认第一次,不许被改晚 ──────────────────────────────────────────
  // 团队那边旧调度台也可能来收一次同一轮（`closeLead`）。改晚了就是个假区间:那一轮结束
  // 之后别人在同一个目录里做的东西会被算进来。
  {
    const root = await seed("EndTwice001");
    const sid = await addSession("EndTwice001", root, { endedAt: at(10) });
    const who = { sessionId: sid, taskId: "EndTwice001", cwd: root, startedAt: at(0) };
    await turns.recordTurnSpan({ ...who, endedAt: at(10) });
    await turns.recordTurnSpan({ ...who, endedAt: at(600) });
    const rows = await turnRows(sid);
    assert.equal(rows.length, 1);
    assert.equal(String(rows[0].ended_at), at(10), "结束时刻认第一次写进去的那个");
    assert.equal(Number((await counters(sid)).turns_started), 1, "补插出来的完整行也要记一次账,但只记一次");
  }

  // ── ④ 反序重放：先补插完整行,迟到的开始不许把它重新开起来 ───────────────────────
  {
    const root = await seed("ReplayOpen1");
    const sid = await addSession("ReplayOpen1", root, { endedAt: at(10) });
    const who = { sessionId: sid, taskId: "ReplayOpen1", cwd: root, startedAt: at(0) };
    await turns.recordTurnSpan({ ...who, endedAt: at(10) });
    await turns.openTurn(who);
    const rows = await turnRows(sid);
    assert.equal(rows.length, 1);
    assert.equal(String(rows[0].ended_at), at(10), "迟到的开始信息不许把一条收过口的记录重新开起来");
    const nums = await counters(sid);
    assert.equal(Number(nums.turns_started), 1);
    assert.equal(nums.turns_lost ?? 0, 0, "本进程自己刚收口的身份不算撞号");
    assert.equal(turns.unconfirmedTurns(sid), 0, "库里明摆着有一行完整记录,不许再欠着账");
  }

  // ── ⑤ F2 真撞上历史身份：绝不静默,照实降级成未知 ───────────────────────────────
  // 怎么模拟重启:**用裸 SQL 插历史行**。写端的水位只活在进程内存里,所以「库里有这条会话的
  // 历史、而内存一无所知」正是重启之后的样子。再把墙钟回拨到上一轮开工的同一毫秒。
  {
    const root = await seed("Rollback001");
    const sid = await addSession("Rollback001", root, {
      endedAt: at(1), turnStartedAt: at(0), turnsStarted: 1,
    });
    await dbClient.execute({
      sql: `INSERT INTO session_turns (id, session_id, task_id, cwd, started_at, ended_at)
              VALUES ('legacy-roll', :sid, 'Rollback001', :cwd, :start, :end)`,
      args: { sid, cwd: root, start: at(0), end: at(1) },
    });
    const allocated = turns.nextTurnStart(sid, at(0)); // 回拨:preferred 就是那个历史起点
    assert.equal(allocated, at(0), "水位是空的（重启）+ 墙钟回拨 = 分配器只能给出历史那个身份");
    await turns.openTurn({ sessionId: sid, taskId: "Rollback001", cwd: root, startedAt: allocated });
    await dbClient.execute({
      sql: "UPDATE sessions SET turn_started_at = :at, ended_at = NULL WHERE id = :sid",
      args: { at: allocated, sid },
    });
    await turns.recordTurnSpan({ sessionId: sid, taskId: "Rollback001", cwd: root, startedAt: allocated, endedAt: at(180) });
    await dbClient.execute({ sql: "UPDATE sessions SET ended_at = :at WHERE id = :sid", args: { at: at(180), sid } });

    const rows = await turnRows(sid);
    assert.equal(rows.length, 1, "身份撞了,库里只可能还是那一行");
    assert.equal(String(rows[0].ended_at), at(1), "旧行是旧那一轮的,不许被这一轮改写");
    assert.equal(Number((await counters(sid)).turns_lost), 1,
      "这一轮没能留下属于自己的记录,得记一笔**持久**的缺口（内存记的话重启就没了）");

    svg(root, "after-rollback.svg", 120);
    const got = await listing("Rollback001");
    assert.deepEqual(names(got), ["after-rollback.svg"], "新图不许静默消失:没有可信区间就按候选列出来");
    assert.ok(
      got.incomplete.some((line) => line.includes("连开始都没在库里留下记录")),
      `这一段是未知,面板上必须说出来。实际：${JSON.stringify(got.incomplete)}`,
    );
  }

  // ── ⑥ F2 的正面：复用历史会话之前把水位接回来,根本不会撞 ─────────────────────────
  {
    const root = await seed("Primed00001");
    const sid = await addSession("Primed00001", root, {
      endedAt: at(1), turnStartedAt: at(0), turnsStarted: 1,
    });
    await dbClient.execute({
      sql: `INSERT INTO session_turns (id, session_id, task_id, cwd, started_at, ended_at)
              VALUES ('legacy-primed', :sid, 'Primed00001', :cwd, :start, :end)`,
      args: { sid, cwd: root, start: at(0), end: at(1) },
    });
    await turns.primeTurnStarts(sid); // ← 续聊/开台/讨论复用那一行之前都要走这一步
    const allocated = turns.nextTurnStart(sid, at(0));
    assert.ok(allocated > at(0), `接回水位之后必须另发一个身份,实际 ${allocated}`);
    await turns.openTurn({ sessionId: sid, taskId: "Primed00001", cwd: root, startedAt: allocated });
    await dbClient.execute({
      sql: "UPDATE sessions SET turn_started_at = :at, ended_at = :end WHERE id = :sid",
      args: { at: allocated, end: at(180), sid },
    });
    await turns.recordTurnSpan({ sessionId: sid, taskId: "Primed00001", cwd: root, startedAt: allocated, endedAt: at(180) });

    const rows = await turnRows(sid);
    assert.equal(rows.length, 2, "新一轮有属于自己的那一行");
    assert.equal(String(rows[1].ended_at), at(180), "它自己的区间,不是旧行那个几秒的");
    const nums = await counters(sid);
    assert.equal(Number(nums.turns_started), 2);
    assert.equal(nums.turns_lost ?? 0, 0, "没撞号就不该有缺口");
    svg(root, "after-resume.svg", 120);
    const got = await listing("Primed00001");
    assert.deepEqual(names(got), ["after-resume.svg"], "落在这一轮自己的精确区间里");
    assert.deepEqual(got.incomplete, [], "记录齐全,一句废话都不该说");
  }

  // ── ⑦ N3：任务真被删了,内存里那几笔欠账跟着收 ─────────────────────────────────
  {
    const root = await seed("DeleteDebt1");
    const sid = await addSession("DeleteDebt1", root);
    await dbClient.executeMultiple(
      `CREATE TRIGGER block_debt BEFORE INSERT ON session_turns
         WHEN NEW.task_id = 'DeleteDebt1' BEGIN SELECT RAISE(ABORT, 'disk full'); END;`,
    );
    await turns.openTurn({ sessionId: sid, taskId: "DeleteDebt1", cwd: root, startedAt: at(0) });
    await dbClient.executeMultiple("DROP TRIGGER block_debt;");
    assert.equal(turns.unconfirmedTurns(sid), 1, "整批写失败要按身份欠一笔账");
    turns.forgetTaskUnconfirmed("DeleteDebt1");
    assert.equal(turns.unconfirmedTurns(sid), 0, "任务删了就没人再去补这一笔,留着就是无主条目（N3）");
    turns.forgetTaskUnconfirmed("DeleteDebt1"); // 幂等
  }

  console.log("✓ turn persist: 并发/顺序/重放四分支都不丢收尾事实、结束时刻认第一次、撞上历史身份照实降级成未知、接回水位后另发身份、删任务收欠账");
} finally {
  await dbClient.close();
  await releaseTmpDb();
  rmSync(stage, { recursive: true, force: true });
}
