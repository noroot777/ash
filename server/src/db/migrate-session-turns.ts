// `session_turns` 的形状迁移：把「只在收尾时插一行」的老表改造成「一个回合一行、开始就
// 落、收尾补 ended_at」。
//
// 为什么要单独一个文件：`migrations.ts` 那份已经到了 640 行,再塞一套建表/去重/回填进去
// 就得每次连带读完全部历史迁移(单文件上限见根 CLAUDE.md)。这一套自成一件事,入口也只有
// 一个 `migrateSessionTurnIdentity(client)`,由 `runDataMigrations` 调。
//
// 三件事按顺序做,顺序不能换：
//   ① `ended_at` 放开 NOT NULL —— 老形状存不下「开始了还没收口」这个事实,而整套完整性
//      判据就架在它上面。SQLite 改不了列约束,只能重建表。
//   ② 同一 (session_id, started_at) 的重复行去掉,然后才建得上唯一索引 —— 先建索引会在
//      有重复数据的库上直接抛,而这里抛出去等于整台 ash 起不来。
//   ③ `turns_base` 回填成「迁移那一刻已知的历史回合数」。只认两列都还是 NULL 的行(= 真
//      正的升级前老行),所以天然只做一次：升级后新建的会话在 insert 时就写了值。
import type { Client } from "./node-sqlite-client.js";

const TABLE_DDL = `CREATE TABLE session_turns_rebuilt (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  cwd TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT
)`;

async function hasTable(client: Client, table: string): Promise<boolean> {
  const rows = await client.execute({
    sql: `SELECT 1 FROM sqlite_master WHERE type='table' AND name=:table`,
    args: { table },
  });
  return rows.rows.length > 0;
}

/** `ended_at` 还带着 NOT NULL 吗（老形状）。表不在、列不在都算「不用重建」。 */
async function endedAtIsRequired(client: Client): Promise<boolean> {
  const rows = await client.execute(
    `SELECT "notnull" AS nn FROM pragma_table_info('session_turns') WHERE name='ended_at'`,
  );
  return rows.rows.some((row) => Number(row.nn) === 1);
}

async function rebuildWithNullableEnd(client: Client): Promise<void> {
  // 标准四步,走 `client.batch`——**一个原子批**。
  //
  // 别自己写 `BEGIN IMMEDIATE`/`COMMIT`：这个 client 自己管事务（`node-sqlite-client.ts`
  // 顶部那段），裸 BEGIN 会撞上它的长事务账目、等 5 秒然后报「数据库正在提交其它操作」,
  // 于是整条迁移被 catch 成一句 warn、表还是老形状。`repairPendingCallKey` 那个重建就是
  // 这么做的,照它来。
  await client.batch([
    "DROP TABLE IF EXISTS session_turns_rebuilt",
    TABLE_DDL,
    `INSERT INTO session_turns_rebuilt (id, session_id, task_id, cwd, started_at, ended_at)
       SELECT id, session_id, task_id, cwd, started_at, ended_at FROM session_turns`,
    "DROP TABLE session_turns",
    "ALTER TABLE session_turns_rebuilt RENAME TO session_turns",
    // 重建表会把它自己的索引一起带走,普通索引在这里补回来；唯一索引留给下一步(得先去重)。
    "CREATE INDEX IF NOT EXISTS session_turns_task_idx ON session_turns(task_id, started_at)",
    "CREATE INDEX IF NOT EXISTS session_turns_session_idx ON session_turns(session_id, started_at)",
  ]);
}

async function dedupeTurnRows(client: Client): Promise<void> {
  // 一个回合只留一行：优先留**收过口的**那条(ended_at 非空),同样收过口的留收尾最早的那条。
  // 留着没收口的那条会让一个正常跑完的回合看起来「开始了没收口」,凭空多报一个缺口。
  await client.execute(
    `DELETE FROM session_turns WHERE id IN (
       SELECT id FROM (
         SELECT id, ROW_NUMBER() OVER (
           PARTITION BY session_id, started_at
           ORDER BY (ended_at IS NULL), ended_at, id
         ) AS rn FROM session_turns
       ) WHERE rn > 1
     )`,
  );
}

/** 升级前已知的历史回合数。**只认两列都还是 NULL 的行**,所以只会做一次。 */
async function backfillTurnsBase(client: Client): Promise<void> {
  await client.execute(
    `UPDATE sessions SET turns_base = (
       SELECT COUNT(*) FROM session_turns t WHERE t.session_id = sessions.id
     ) WHERE turns_base IS NULL AND turns_started IS NULL`,
  );
}

export async function migrateSessionTurnIdentity(client: Client): Promise<void> {
  try {
    if (!(await hasTable(client, "session_turns"))) return; // 新库：DDL 已经按新形状建好
    if (await endedAtIsRequired(client)) await rebuildWithNullableEnd(client);
    await dedupeTurnRows(client);
    await client.execute(
      "CREATE UNIQUE INDEX IF NOT EXISTS session_turns_turn_key ON session_turns(session_id, started_at)",
    );
    await backfillTurnsBase(client);
  } catch (e) {
    // **绝不往外抛**：这条迁移没跑成的代价是「唯一索引没建上 / 基数没回填」,读端照保守档
    // 披露就是了；抛出去的代价是 ensureSchema 崩掉 = 整台 ash 起不来（db/index.ts 里那条
    // 2026-10-14 实测过的教训）。下次启动还会再试一遍。
    console.warn(`[ash] session_turns 身份迁移没跑完（产物归属按保守档披露）: ${String(e)}`);
  }
}
