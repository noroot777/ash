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
      cwd TEXT, started_at TEXT NOT NULL, ended_at TEXT, turn_started_at TEXT, active_ms INTEGER);
    CREATE TABLE session_turns (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, task_id TEXT NOT NULL,
      cwd TEXT, started_at TEXT NOT NULL, ended_at TEXT NOT NULL);
    INSERT INTO sessions (id, task_id, started_at) VALUES ('s1','t1','2026-10-01T00:00:00.000Z');
    INSERT INTO session_turns VALUES ('a','s1','t1','/x','2026-10-01T00:00:00.000Z','2026-10-01T00:10:00.000Z');
    INSERT INTO session_turns VALUES ('b','s1','t1','/x','2026-10-01T01:00:00.000Z','2026-10-01T01:10:00.000Z');
    INSERT INTO session_turns VALUES ('c','s1','t1','/x','2026-10-01T01:00:00.000Z','2026-10-01T01:20:00.000Z');
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

  const rows = (await dbClient.execute("SELECT id, started_at, ended_at FROM session_turns ORDER BY started_at, id")).rows;
  assert.equal(rows.length, 2, `同一回合的重复行要去掉（否则它能冒充「多跑了一轮」抵掉真缺口）。实际 ${JSON.stringify(rows)}`);
  assert.equal(String(rows[1].ended_at), "2026-10-01T01:10:00.000Z", "留下的是收过口、且收尾最早的那条");

  const session = (await dbClient.execute("SELECT turns_base, turns_started FROM sessions WHERE id='s1'")).rows[0];
  assert.equal(Number(session.turns_base), 2, "升级前的历史回合数变成基数（下界），读端据它披露「那之前缺没缺不知道」");
  assert.equal(session.turns_started, null, "迁移不伪造「升级后开过几轮」——那会把真缺口抵扣掉");

  // 幂等：ensureSchema 每次启动都跑。
  await ensureSchema();
  assert.equal(Number((await dbClient.execute("SELECT COUNT(*) c FROM session_turns")).rows[0].c), 2, "再跑一次仍是两行");
  assert.equal(
    Number((await dbClient.execute("SELECT turns_base FROM sessions WHERE id='s1'")).rows[0].turns_base), 2,
    "基数不被二次回填改写（判据是「两列都还是 NULL」，所以只会做一次）",
  );

  console.log("✓ turn migration: ended_at 放开、重复回合去重、唯一索引建上、升级前历史变成可披露的基数、幂等");
} finally {
  await dbClient.close();
  await releaseTmpDb();
  rmSync(stage, { recursive: true, force: true });
}
