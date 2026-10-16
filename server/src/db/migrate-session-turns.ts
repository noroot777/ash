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
//   ③ `turns_base` 回填成「迁移那一刻已知的历史回合数」,并标明那是下界。只认
//      `turns_base_approx` 还是 NULL 的行(= 没经过本版写端的行),所以天然只做一次：升级后
//      新建的会话在 insert 时把这一列写成 0。详见 `backfillTurnsBase` 的注释。
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

/**
 * 把「升级之前的历史」收进 `turns_base`,并明说那是个**下界**。
 *
 * 判据是 `turns_base_approx IS NULL` 一条——**它才是「这条会话有没有经过本版写端」的标记**。
 * 不能用 `turns_base IS NULL`：上一版（`0f89b2b8`）的 `freshTurnFields` 已经会写 `turns_base: 0`,
 * 却没有这一列,于是那批行既不是 NULL base、也没有本版的原子写语义,照 base 判就被当成「已经
 * 可信了」,它那个会漏入口、又会重复加数的旧计数从此永久参与精确对账（第 6 轮审查必须修 2 的
 * 历史兼容边界：NULL approx 不等于 false）。
 *
 * 也不再附加 `turns_started IS NULL`。原先多那一条的想法是
 * 「`turns_started` 有值就说明它已经在新口径下记账了」,但那个值是**上一版**写出来的,口径
 * 跟现在不是一回事（上一版漏了起跑入口、又会重复加数）。于是 `turns_started=2` 配两行回合
 * 记录这种形状被当成完整,一个偏小的旧计数就能把真缺口整个抵掉,面板上一句话都不说
 * （第 5 轮审查必须修 2.2）。
 *
 * 所以这里对**每一条还没经过本版的会话行**做三件事：
 *   ① `turns_base` 取「现有行数」和「旧计数」里**大的那个**——两边都只是下界,取大的那个
 *      离真相近一点,而且绝不会反过来把真缺口抵成负数（读端那边还有一道 `max(0, …)`）；
 *   ② `turns_base_approx = 1` —— 照实说「升级前缺没缺记录无从得知」。**不能靠「base 大于 0」
 *      代替**：迁移那一刻一行记录都没有的老会话回填出来正好是 0,跟升级后新建的行长得一样；
 *   ③ `turns_started = NULL` —— 旧口径的计数不参与本版对账。读端见 null 就只按逐行事实和
 *      这条「升级前算不准」披露,不拿它去做减法。
 *
 * 幂等：本版新建的会话在 insert 时就把 `turns_base_approx` 写成 0（`freshTurnFields`）,迁移过
 * 的行写成 1,所以「这一列还是 NULL」只对真正没经过本版写端的行成立,每次启动重跑都不会动到
 * 新计数。
 */
async function backfillTurnsBase(client: Client): Promise<void> {
  await client.execute(
    `UPDATE sessions SET
       turns_base = MAX(
         COALESCE(turns_started, 0),
         (SELECT COUNT(*) FROM session_turns t WHERE t.session_id = sessions.id)
       ),
       turns_base_approx = 1,
       turns_started = NULL
     WHERE turns_base_approx IS NULL`,
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
