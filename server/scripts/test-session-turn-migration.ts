// 老库升到「回合一行」这套形状时的契约：`ended_at` 得能为空、同一回合不能有两行、升级前
// 的历史要变成一个**说得出来的基数**而不是悄悄当成完整。
//
// 为什么单独一条：这几步跑在 `ensureSchema()` 里，而那条路上抛异常 = 整台 ash 起不来
// （db/index.ts 里 2026-10-14 那条实测教训）。所以迁移自己 catch 掉一切只 warn——代价是
// **失败会很安静**，只能靠这条测试盯着它真跑成了没有。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireTmpDb, releaseTmpDb } from "./tmp-db.js";

requireTmpDb("session-turn-migration");
const stage = mkdtempSync(join(tmpdir(), "ash-turn-migration-"));
process.env.ASH_DB = join(stage, "legacy.db");
process.env.ASH_RUNS_DIR = join(stage, "runs");

const { dbClient, ensureSchema } = await import("../src/db/index.js");
try {
  // 老形状：`ended_at NOT NULL`、有两轮历史、外加一对「同一回合两行」（没有唯一索引时才可能）。
  await dbClient.executeMultiple(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, role TEXT, agent_type TEXT, executor TEXT,
      cwd TEXT, started_at TEXT NOT NULL, ended_at TEXT, turn_started_at TEXT, active_ms INTEGER,
      -- 上一版（0f89b2b8）已经有 turns_started 和 turns_base 两列,但还没有 turns_base_approx。
      -- 这就是「中间版本跑过真实任务」之后库里的样子,回填必须认得出它不可信。
      turns_started INTEGER, turns_base INTEGER);
    CREATE TABLE session_turns (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, task_id TEXT NOT NULL,
      cwd TEXT, started_at TEXT NOT NULL, ended_at TEXT NOT NULL);
    INSERT INTO sessions (id, task_id, started_at) VALUES ('s1','t1','2026-10-01T00:00:00.000Z');
    INSERT INTO session_turns VALUES ('a','s1','t1','/x','2026-10-01T00:00:00.000Z','2026-10-01T00:10:00.000Z');
    INSERT INTO session_turns VALUES ('b','s1','t1','/x','2026-10-01T01:00:00.000Z','2026-10-01T01:10:00.000Z');
    INSERT INTO session_turns VALUES ('c','s1','t1','/x','2026-10-01T01:00:00.000Z','2026-10-01T01:20:00.000Z');
    -- **上一版自己写出来的形状**：turns_started 已经有值（而且是上一版那个会漏入口、又会
    -- 重复加数的口径）,但 turns_base 那一列压根还不存在。回填要是附加「turns_started 也得
    -- 是 NULL」这个条件,这条会话就被当成「已经在新口径下记完整了」,一个偏小的旧计数从此
    -- 永久抵掉真缺口（第 5 轮审查必须修 2.2）。
    INSERT INTO sessions (id, task_id, started_at, turns_started)
      VALUES ('s2','t2','2026-10-02T00:00:00.000Z', 2);
    INSERT INTO session_turns VALUES ('d','s2','t2','/y','2026-10-02T00:00:00.000Z','2026-10-02T00:10:00.000Z');
    INSERT INTO session_turns VALUES ('e','s2','t2','/y','2026-10-02T01:00:00.000Z','2026-10-02T01:10:00.000Z');
    -- 上一版 freshTurnFields 写出来的形状：base 已经是 0（非 NULL）、计数是它那个口径,
    -- 但没有「这是下界吗」这一列。拿 base IS NULL 当判据就会把它当成「已经可信升级过了」,
    -- 它那个会漏入口、又会重复加数的计数从此永久参与精确对账（第 6 轮审查必须修 2 的历史边界）。
    INSERT INTO sessions (id, task_id, started_at, turns_started, turns_base)
      VALUES ('s4','t4','2026-10-04T00:00:00.000Z', 2, 0);
    INSERT INTO session_turns VALUES ('f','s4','t4','/z','2026-10-04T00:00:00.000Z','2026-10-04T00:10:00.000Z');
    INSERT INTO session_turns VALUES ('g','s4','t4','/z','2026-10-04T02:00:00.000Z','2026-10-04T02:10:00.000Z');
  `);

  await ensureSchema();

  const columns = async (table: string) =>
    (await dbClient.execute(`SELECT name, "notnull" AS nn FROM pragma_table_info('${table}')`)).rows
      .map((row) => `${row.name}:${row.nn}`);
  const turnColumns = await columns("session_turns");
  assert(
    turnColumns.includes("ended_at:0"),
    `ended_at 必须放开 NOT NULL——老形状存不下「开了还没收口」，整套完整性判据就架在它上面。实际：${turnColumns.join(",")}`,
  );
  assert((await columns("sessions")).some((c) => c.startsWith("turns_base")), "sessions 要有 turns_base");
  const index = (await dbClient.execute(
    "SELECT name FROM sqlite_master WHERE type='index' AND name='session_turns_turn_key'",
  )).rows;
  assert.equal(index.length, 1, "一个回合一行：身份唯一索引要建上");

  const rows = (await dbClient.execute(
    "SELECT id, started_at, ended_at FROM session_turns WHERE session_id='s1' ORDER BY started_at, id",
  )).rows;
  assert.equal(rows.length, 2, `同一回合的重复行要去掉（否则它能冒充「多跑了一轮」抵掉真缺口）。实际 ${JSON.stringify(rows)}`);
  assert.equal(String(rows[1].ended_at), "2026-10-01T01:10:00.000Z", "留下的是收过口、且收尾最早的那条");

  const sessionRow = async (id: string) => (await dbClient.execute(
    `SELECT turns_base, turns_base_approx, turns_started FROM sessions WHERE id='${id}'`,
  )).rows[0];
  const session = await sessionRow("s1");
  assert.equal(Number(session.turns_base), 2, "升级前的历史回合数变成基数（下界），读端据它披露「那之前缺没缺不知道」");
  assert.equal(session.turns_started, null, "迁移不伪造「升级后开过几轮」——那会把真缺口抵扣掉");
  assert.equal(Number(session.turns_base_approx), 1, "基数只是下界：升级前写失败的回合没留下行，谁也数不出来");

  // 上一版写出来的 `turns_started=2`：同样要被收成「下界 + 算不准」,而不是当成已经记完整。
  const legacyCounted = await sessionRow("s2");
  assert.equal(Number(legacyCounted.turns_base), 2, "旧计数也只是下界，取它跟现有行数里大的那个");
  assert.equal(legacyCounted.turns_started, null, "上一版的计数口径不参与本版对账");
  assert.equal(Number(legacyCounted.turns_base_approx), 1, "它的升级前历史照样算不准（必须修 2.2）");

  // 上一版写出来的 base=0 / approx 缺列：判据必须是「approx 还是 NULL」而不是「base 还是 NULL」。
  const midVersion = await sessionRow("s4");
  assert.equal(Number(midVersion.turns_base), 2, "上一版的计数和行数里取大的那个作下界");
  assert.equal(midVersion.turns_started, null, "上一版的计数口径不参与本版对账");
  assert.equal(Number(midVersion.turns_base_approx), 1, "NULL approx 不等于 false：那一版的账不可信（必须修 2 历史边界）");

  // 幂等：`ensureSchema` 每次启动都跑,而回填这次会扫**所有** `turns_base IS NULL` 的行——
  // 升级之后新建的会话（insert 时就写了 base/approx）必须一个字都不被它动到,否则每次重启
  // 都把本版的真实计数清成 NULL,对账这一道从此形同虚设。
  await dbClient.execute(
    `INSERT INTO sessions (id, task_id, started_at, turns_started, turns_base, turns_base_approx)
       VALUES ('s3','t3','2026-10-03T00:00:00.000Z', 3, 0, 0)`,
  );
  await ensureSchema();
  assert.equal(Number((await dbClient.execute("SELECT COUNT(*) c FROM session_turns")).rows[0].c), 6, "再跑一次仍是六行");
  const again = await sessionRow("s1");
  assert.equal(Number(again.turns_base), 2, "基数不被二次回填改写（判据是「turns_base 还是 NULL」，所以只会做一次）");
  assert.equal(Number(again.turns_base_approx), 1, "「算不准」这个标记也不该被改掉");
  const fresh = await sessionRow("s3");
  assert.equal(Number(fresh.turns_started), 3, "升级后新建的会话,它的计数不许被回填清掉");
  assert.equal(Number(fresh.turns_base), 0, "它没有升级前历史");
  assert.equal(Number(fresh.turns_base_approx), 0, "也不该被标成「算不准」");

  console.log("✓ turn migration: ended_at 放开、重复回合去重、唯一索引建上、旧计数（含非 NULL base 的中间版本）收成可披露的下界、本版计数不被回填动到、幂等");
} finally {
  await dbClient.close();
  await releaseTmpDb();
  rmSync(stage, { recursive: true, force: true });
}
