// **未决调用表的键**：`(task_id, session_key, source_run, tool_use_id)`。
//
// 这张表存的是一条 Monitor 调用**入参的唯一出处**（命令、说明），不是可以重算的缓存。所以
// 它的键和销账条件比别处更要紧：少一维来源，两个 run 文件里的同号调用就争同一个键（第二条
// 被 `onConflictDoNothing` 吞掉），或者一轮的销账把另一轮那条也删了 —— 两种都让那张卡永久
// 消失，而读取位置照常被确认成「读完了」（新一轮第 1 轮审查 F1）。
//
// 这份测试盯**升级路径**：两种旧形状的表都要被重建成当代键，而且重建之后同号不同来源的两条
// 存得下、销账只带走指名那一条。判据本体在 `server/src/claude-monitor-pending.ts`，新库那条
// 路（bootstrap DDL）由 `test-claude-monitor-identity.ts` 的 ⑥(b) 盯着。
//
// **失败路径占了后半截**（新一轮第 2 轮审查 F1）：换表撞上别的写者、上一次中断在「原表已删、
// 改名还没成」那一瞬、接回搬运表这一批自己也失败 —— 三种都不许留下半成品，更不许让上层按
// 当代语义确认读取位置（`db/schema-readiness.ts` + `claude-monitor-cursors.ts` 的
// `saveScanCursors`）。夹具用的是真的第二个 SQLite 写者，不伪造异常、不替换迁移实现。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { eq } from "drizzle-orm";
import type { InStatement } from "../src/db/node-sqlite-client.js";
import { requireTmpDb, releaseTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "ash-pending-key-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
requireTmpDb("monitor-pending-key");

const [{ db, ensureSchema, dbClient }, schema, readiness, cursors] = await Promise.all([
  import("../src/db/index.js"),
  import("../src/db/schema.js"),
  import("../src/db/schema-readiness.js"),
  import("../src/claude-monitor-cursors.js"),
]);
const { projects, tasks } = schema;
const { pendingCallKeyLive, pendingCallKeyBlocker } = readiness;
const { saveScanCursors, MONITOR_CHECKPOINT_SEMANTICS: CURRENT } = cursors;
await ensureSchema();

let failures = 0;
const check = (ok: boolean, label: string, detail = "") => {
  if (ok) return;
  failures += 1;
  console.error(`✗ ${label}${detail ? ` —— ${detail}` : ""}`);
};
const now = () => new Date().toISOString();

/** 当代形状（跟 bootstrap DDL / 迁移里那份一致）。 */
const currentShape = (table: string) => `CREATE TABLE ${table} (
  task_id TEXT NOT NULL, session_key TEXT NOT NULL, tool_use_id TEXT NOT NULL,
  command TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  at TEXT, source_run TEXT NOT NULL DEFAULT '', cli_session_id TEXT,
  PRIMARY KEY (task_id, session_key, source_run, tool_use_id))`;

/** 这张表**现在**的主键（运行期事实，判据只认它）。 */
const keyOf = async (table: string): Promise<string> => {
  const info = await dbClient.execute(`PRAGMA table_info(${table})`);
  return info.rows.filter((r: any) => Number(r.pk) > 0)
    .sort((a: any, b: any) => Number(a.pk) - Number(b.pk))
    .map((r: any) => String(r.name)).join(",");
};

const tableExists = async (table: string): Promise<boolean> => (await dbClient.execute({
  sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", args: [table],
})).rows.length > 0;

// ── ⑮ 换表撞上别的写者：原表原样留着，当代语义一个字都不许发布 ───────────────────
//
// 上一版把换表拆成五条独立 `execute`，中间任何一条失败都留下半成品库，而启动照常成功：
// 旧三列键继续承接当代写入（同号不同来源的第二条被冲突吞掉），读取位置却照常被确认成
// 「读完了」—— 下一次启动真的迁成功也不会重放，因为那个前缀已经带着当代戳（新一轮第 2 轮
// 审查 F1 实测 A：全新进程、升级成功，那张卡仍然是 0）。
//
// 这里用**真的第二个 SQLite 写者**撞那一批（不伪造异常、不替换迁移实现），钉三件事：
// 整批回滚（原表和它的行原样在、不留半成品搬运表）、当代键没发布、**位置不落盘**。
async function rekeyFailureKeepsOldTable(): Promise<void> {
  const taskKey = "t-rekey-locked";
  await db.insert(tasks).values({ id: taskKey, projectId: "p", title: "换表撞锁", body: "",
    status: "running", agentType: "claude", mode: "single", createdAt: now(), updatedAt: now() });
  await dbClient.execute("DROP TABLE IF EXISTS monitor_pending_calls");
  await dbClient.execute("DROP TABLE IF EXISTS monitor_pending_calls_rekey");
  await dbClient.execute(`CREATE TABLE monitor_pending_calls (
    task_id TEXT NOT NULL, session_key TEXT NOT NULL, tool_use_id TEXT NOT NULL,
    command TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', at TEXT, source_run TEXT,
    PRIMARY KEY (task_id, session_key, tool_use_id))`);
  await dbClient.execute({ sql: "INSERT INTO monitor_pending_calls VALUES (?,?,?,?,?,?,?)",
    args: [taskKey, "s-old", "tu-locked", "tail -F build.log", "入参的唯一出处", null, "/runs/a.jsonl"] });
  // 等锁等到超时不是这条测试要观察的东西（生产默认等得更久）：缩到 25ms 只为让它快点失败。
  await dbClient.execute("PRAGMA busy_timeout = 25");

  const locker = new DatabaseSync(String(process.env.ASH_DB));
  const realBatch = dbClient.batch.bind(dbClient);
  let locked = false;
  (dbClient as { batch: unknown }).batch = async (stmts: InStatement[], mode?: unknown) => {
    const sql = [...stmts].map((s) => (typeof s === "string" ? s : s.sql)).join(";");
    if (locked || !sql.includes("monitor_pending_calls_rekey")) return realBatch(stmts, mode as never);
    locked = true;
    locker.exec("BEGIN IMMEDIATE");   // 真的第二个写者：BEGIN IMMEDIATE 当场拿走写锁
    try { return await realBatch(stmts, mode as never); } finally { locker.exec("ROLLBACK"); }
  };
  try { await ensureSchema(); } finally {
    (dbClient as { batch: unknown }).batch = realBatch;
    locker.close();
  }

  // 这一条同时钉住**换表是一个原子批**：夹具挂在 `batch` 上，拆成多条 `execute` 就撞不到锁。
  check(locked, "⑮ 换表作为一个原子批交出去（夹具在那一批上撞到了写锁）");
  check(await keyOf("monitor_pending_calls") === "task_id,session_key,tool_use_id",
    "⑮ 换表失败 ⇒ 整批回滚,原表原样留着", await keyOf("monitor_pending_calls"));
  const kept = await dbClient.execute("SELECT COUNT(*) AS n FROM monitor_pending_calls");
  check(Number((kept.rows[0] as any).n) === 1, "⑮ 原表里那条入参还在");
  check(!(await tableExists("monitor_pending_calls_rekey")), "⑮ 没留下半成品搬运表");
  check(!pendingCallKeyLive(), "⑮ 迁移没成 ⇒ 当代持久键没发布出去");

  // **这才是「永久少一张卡」的那个出口**：旧键的库上盖不出当代戳。
  const spot = new Map([[join(root, "a.jsonl"),
    { size: 10, offset: 10, probe: 0, gaps: [], source: null }]]);
  check(await saveScanCursors(taskKey, spot) === false, "⑮ 读取位置这一轮不落盘（返回 false）");
  check((await db.select().from(schema.monitorScanCursors)
    .where(eq(schema.monitorScanCursors.taskId, taskKey))).length === 0,
    "⑮ 库里一条位置也没有（没给旧键的库盖上当代戳）");

  // 下一次启动没人占锁 ⇒ 当场迁成功、当代语义发布、位置也盖得起戳了。
  await ensureSchema();
  check(pendingCallKeyLive(), "⑮ 下次启动迁成功 ⇒ 当代键发布出去了");
  check(await keyOf("monitor_pending_calls") === "task_id,session_key,source_run,tool_use_id",
    "⑮ 键重建成了当代四列", await keyOf("monitor_pending_calls"));
  check(await saveScanCursors(taskKey, spot) === true, "⑮ 这一轮位置落盘了");
  const stamped = await db.select().from(schema.monitorScanCursors)
    .where(eq(schema.monitorScanCursors.taskId, taskKey));
  check(stamped.length === 1 && stamped[0]?.semantics === CURRENT,
    "⑮ 盖的是当代戳", JSON.stringify(stamped.map((r) => r.semantics)));
}

// ── ⑯ 上一次换表中断在「原表已删、改名还没成」：搬运表里的事实必须接回来 ──────────
//
// 那一瞬之后正式表不存在；下一次 bootstrap 的 `CREATE TABLE IF NOT EXISTS` 会建出一张**空的
// 当代键表**，于是只看「键已经是当代」就返回的迁移把带着事实的搬运表永远留在一边（新一轮
// 第 2 轮审查 F1 实测 B：`strandedPending=1`、`visiblePending=0`）。两种落点各跑一遍。
async function interruptedRekeyIsAdopted(): Promise<void> {
  // 两种落点：bootstrap 已经把空的当代表建回来了（真实升级入口 `ensureSchema`），以及
  // **连 bootstrap 都没兜住**、正式表压根不存在（直接跑 `runDataMigrations` —— 接回搬运表
  // 这件事不许依赖「先有人把表建出来」，那一步自己也可能失败）。
  const { runDataMigrations } = await import("../src/db/migrations.js");
  const phases = [
    { label: "正式表还没建回来", seedMain: false, upgrade: () => runDataMigrations(dbClient) },
    { label: "bootstrap 建出了空的当代表", seedMain: true, upgrade: () => ensureSchema() },
  ];
  for (const { label, seedMain, upgrade } of phases) {
    await dbClient.execute("DROP TABLE IF EXISTS monitor_pending_calls");
    await dbClient.execute("DROP TABLE IF EXISTS monitor_pending_calls_rekey");
    await dbClient.execute(currentShape("monitor_pending_calls_rekey"));
    await dbClient.execute({ sql: `INSERT INTO monitor_pending_calls_rekey
      (task_id, session_key, tool_use_id, command, description, at, source_run, cli_session_id)
      VALUES (?,?,?,?,?,?,?,?)`,
      args: ["t-rekey-locked", "s-mid", "tu-stranded", "sleep 900", "搬到一半", null, "/runs/b.jsonl", null] });
    if (seedMain) await dbClient.execute(currentShape("monitor_pending_calls"));

    await upgrade();

    check(pendingCallKeyLive(), `⑯ ${label}：接回来之后当代键才算发布`, pendingCallKeyBlocker());
    check(!(await tableExists("monitor_pending_calls_rekey")),
      `⑯ ${label}：搬运表没留在一边`);
    const adopted = (await db.select().from(schema.monitorPendingCalls))
      .filter((r) => r.toolUseId === "tu-stranded");
    check(adopted.length === 1 && adopted[0]?.command === "sleep 900",
      `⑯ ${label}：搬运表里那条入参在正式表里查得到`, JSON.stringify(adopted));
  }

  // 另一边：正式表还在、还是旧键 ⇒ 搬运表只是上一次没搬完的**残缺拷贝**，原表才是事实的
  // 出处。丢掉拷贝、按原表重建，别把拷贝当成要接回来的事实。
  await dbClient.execute("DROP TABLE IF EXISTS monitor_pending_calls");
  await dbClient.execute("DROP TABLE IF EXISTS monitor_pending_calls_rekey");
  await dbClient.execute(`CREATE TABLE monitor_pending_calls (
    task_id TEXT NOT NULL, session_key TEXT NOT NULL, tool_use_id TEXT NOT NULL,
    command TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', at TEXT, source_run TEXT,
    PRIMARY KEY (task_id, session_key, tool_use_id))`);
  await dbClient.execute({ sql: "INSERT INTO monitor_pending_calls VALUES (?,?,?,?,?,?,?)",
    args: ["t-rekey-locked", "s-live", "tu-live", "sleep 1", "原表才是出处", null, "/runs/c.jsonl"] });
  await dbClient.execute(currentShape("monitor_pending_calls_rekey"));
  await ensureSchema();
  check(pendingCallKeyLive(), "⑯ 残缺拷贝丢掉、按原表重建之后当代键发布", pendingCallKeyBlocker());
  const live = (await db.select().from(schema.monitorPendingCalls))
    .filter((r) => r.toolUseId === "tu-live");
  check(live.length === 1, "⑯ 原表那条入参跟着重建活下来了", JSON.stringify(live));
}

// ── ⑰ 接不回来的那一次：事实留在搬运表里，当代语义照样不许发布 ─────────────────────
//
// 「正式表的键已经是当代」证明不了「上次搬到临时表的事实已经入正式表」。这一组让接回去那一批
// 也撞上写锁：两边都不许丢（搬运表原样在），而当代键不许发布（否则位置一确认，那批事实就
// 再也没有入口了）。
async function strandedStagingWithholdsSemantics(): Promise<void> {
  await dbClient.execute("DROP TABLE IF EXISTS monitor_pending_calls");
  await dbClient.execute("DROP TABLE IF EXISTS monitor_pending_calls_rekey");
  await dbClient.execute(currentShape("monitor_pending_calls"));
  await dbClient.execute(currentShape("monitor_pending_calls_rekey"));
  await dbClient.execute({ sql: `INSERT INTO monitor_pending_calls_rekey
    (task_id, session_key, tool_use_id, command, description, at, source_run, cli_session_id)
    VALUES (?,?,?,?,?,?,?,?)`,
    args: ["t-rekey-locked", "s-mid", "tu-stuck", "sleep 42", "接不回来", null, "/runs/d.jsonl", null] });
  await dbClient.execute("PRAGMA busy_timeout = 25");

  const locker = new DatabaseSync(String(process.env.ASH_DB));
  const realBatch = dbClient.batch.bind(dbClient);
  let locked = false;
  (dbClient as { batch: unknown }).batch = async (stmts: InStatement[], mode?: unknown) => {
    const sql = [...stmts].map((s) => (typeof s === "string" ? s : s.sql)).join(";");
    if (locked || !sql.includes("monitor_pending_calls_rekey")) return realBatch(stmts, mode as never);
    locked = true;
    locker.exec("BEGIN IMMEDIATE");
    try { return await realBatch(stmts, mode as never); } finally { locker.exec("ROLLBACK"); }
  };
  try { await ensureSchema(); } finally {
    (dbClient as { batch: unknown }).batch = realBatch;
    locker.close();
  }

  check(locked, "⑰ 接回搬运表也是一个原子批（夹具在那一批上撞到了写锁）");
  check(!pendingCallKeyLive(), "⑰ 搬运表还在 ⇒ 当代键不许发布（键已是当代也不算）");
  const stranded = await dbClient.execute("SELECT COUNT(*) AS n FROM monitor_pending_calls_rekey");
  check(Number((stranded.rows[0] as any).n) === 1, "⑰ 那条事实原样留在搬运表里（没被丢掉）");
  await ensureSchema();   // 下一次启动没人占锁
  check(pendingCallKeyLive() && !(await tableExists("monitor_pending_calls_rekey")),
    "⑰ 下次启动把它接回去了,当代键随后发布", pendingCallKeyBlocker());
  const rescued = (await db.select().from(schema.monitorPendingCalls))
    .filter((r) => r.toolUseId === "tu-stuck");
  check(rescued.length === 1 && rescued[0]?.command === "sleep 42",
    "⑰ 那条入参最终在正式表里查得到", JSON.stringify(rescued));
}

async function main(): Promise<void> {
  await db.insert(projects).values({ id: "p", name: "p", repoPath: root, createdAt: now() });
  // ── 旧库升级：**重建成当代键**，别让它一直重复插、也别把来源挤掉 ──────────────
  //
  // 两种旧形状各自的坏法：没有任何唯一约束那张（声明式 `db:push` 在加上 Drizzle 侧
  // `primaryKey()` 之前建的）`onConflictDoNothing` 没有冲突目标可撞，每轮同步都能再插一条
  // 一模一样的（第 13 轮审查 N4，用构建产物实测重复 2 条）；三列粗键那张（上一代 bootstrap
  // DDL）则是同号不同来源只存得下一条。SQLite 改不了主键，所以升级路径上是**重建整张表**
  // （`repairPendingCallKey`）：去重 + 换键 + 补上归属那一列。
  // **两种旧形状各跑一遍**：声明式路径建的那张（没有任何唯一约束）和上一代 bootstrap DDL
  // 建的那张（主键是更粗的三列）。前者防重复插，后者防「同号不同来源只存得下一条」。
  for (const legacy of ["no-key", "coarse-key"] as const) {
    const { syncPendingCalls } = await import("../src/claude-monitor-pending.js");
    const taskKey = `t-legacy-pending-${legacy}`;
    await dbClient.execute("DROP TABLE IF EXISTS monitor_pending_calls");
    await dbClient.execute(`CREATE TABLE monitor_pending_calls (
      task_id TEXT NOT NULL, session_key TEXT NOT NULL, tool_use_id TEXT NOT NULL,
      command TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', at TEXT, source_run TEXT
      ${legacy === "coarse-key" ? ", PRIMARY KEY (task_id, session_key, tool_use_id)" : ""})`);
    // 任务行要真的有：落库资格现在跟写同一个批（claude-monitor-write.ts），任务不在 =
    // 这些行是孤儿、当场被收走。以前这个夹具省掉了它，靠的是「没人验证归属」。
    await db.insert(tasks).values({ id: taskKey, projectId: "p", title: "旧未决表", body: "",
      status: "running", agentType: "claude", mode: "single", createdAt: now(), updatedAt: now() });
    const dup = [taskKey, "s-legacy", "tu-dup", "sleep 600", "重复了两条", null, null];
    // 粗键那张表自己就拦得住第二条（`OR IGNORE` 让两种形状共用同一段夹具）。
    await dbClient.execute({ sql: "INSERT OR IGNORE INTO monitor_pending_calls VALUES (?,?,?,?,?,?,?)", args: dup });
    await dbClient.execute({ sql: "INSERT OR IGNORE INTO monitor_pending_calls VALUES (?,?,?,?,?,?,?)", args: dup });
    await dbClient.execute({ sql: "INSERT OR IGNORE INTO monitor_pending_calls VALUES (?,?,?,?,?,?,?)",
      args: [taskKey, "s-legacy", "tu-other", "sleep 1", "另一条,不许被去重带走", null, null] });

    await ensureSchema();   // ← 升级就发生在这里

    const left = await db.select().from(schema.monitorPendingCalls);
    check(left.filter((r) => r.toolUseId === "tu-dup").length === 1,
      `${legacy}：升级时把重复的那条去掉了,只留一条`, JSON.stringify(left.map((r) => r.toolUseId)));
    check(left.filter((r) => r.toolUseId === "tu-other").length === 1,
      `${legacy}：不同 tool_use_id 的那条没被去重带走`);
    const idx = await dbClient.execute("PRAGMA index_list(monitor_pending_calls)");
    check(idx.rows.some((r: any) => Number(r.unique) === 1),
      `${legacy}：唯一约束补上了（旧库从此也撞得到冲突）`, JSON.stringify(idx.rows.map((r: any) => r.name)));
    const info = await dbClient.execute("PRAGMA table_info(monitor_pending_calls)");
    const keyCols = info.rows.filter((r: any) => Number(r.pk) > 0)
      .sort((a: any, b: any) => Number(a.pk) - Number(b.pk)).map((r: any) => String(r.name));
    check(keyCols.join(",") === "task_id,session_key,source_run,tool_use_id",
      `${legacy}：键重建成了当代的四列（来源在键里）`, keyCols.join(","));
    check(info.rows.some((r: any) => String(r.name) === "cli_session_id"),
      `${legacy}：归属那一列也补上了（销账判据要用它）`);

    // 真正要防住的后果:再同步一次不会又多一条。
    const again = {
      sessionKey: "s-legacy", toolUseId: "tu-dup", at: null, cliSessionId: null, sourceRun: "",
      call: { command: "sleep 600", description: "重复了两条" },
    };
    await syncPendingCalls(taskKey, [again], []);
    await syncPendingCalls(taskKey, [again], []);
    const after = await db.select().from(schema.monitorPendingCalls);
    check(after.filter((r) => r.toolUseId === "tu-dup").length === 1,
      `${legacy}：补齐之后再同步两轮也只有一条`, String(after.filter((r) => r.toolUseId === "tu-dup").length));

    // **另一半:同号不同来源的两条都要存得下。** 旧键下第二条会被冲突吞掉,而它入参的唯一
    // 出处就是这一行。
    const twoRuns = ["/runs/legacy-a.jsonl", "/runs/legacy-b.jsonl"].map((sourceRun) => ({
      sessionKey: "s-legacy", toolUseId: "tu-twin", at: null, cliSessionId: null, sourceRun,
      call: { command: `tail -f ${sourceRun}`, description: `来自 ${sourceRun}` },
    }));
    await syncPendingCalls(taskKey, twoRuns, []);
    const twins = (await db.select().from(schema.monitorPendingCalls))
      .filter((r) => r.toolUseId === "tu-twin");
    check(twins.length === 2, `${legacy}：同一个 tool_use 号、两个 run 文件 ⇒ 各占一行`,
      JSON.stringify(twins.map((r) => r.sourceRun)));
    // 销账也只许带走指名那一条。
    await syncPendingCalls(taskKey, [], [
      { sessionKey: "s-legacy", sourceRun: "/runs/legacy-a.jsonl", toolUseId: "tu-twin" },
    ]);
    const leftTwin = (await db.select().from(schema.monitorPendingCalls))
      .filter((r) => r.toolUseId === "tu-twin");
    check(leftTwin.length === 1 && leftTwin[0]?.sourceRun === "/runs/legacy-b.jsonl",
      `${legacy}：销账按 (会话, 来源, 号) 删,没把另一个 run 的同号调用带走`,
      JSON.stringify(leftTwin.map((r) => r.sourceRun)));
  }


  await rekeyFailureKeepsOldTable();
  await interruptedRekeyIsAdopted();
  await strandedStagingWithholdsSemantics();

  if (failures === 0) {
    console.log("✓ 内置 Monitor 未决调用表的键：两种旧形状（没有键、更粗的三列键）升级时都"
      + "重建成当代四列键并去重 / 同号不同来源的两条存得下 / 销账只带走指名那一条 /"
      + "换表撞锁时整批回滚且当代语义与读取位置都不发布 / 中断在半路的搬运表两种落点都接得"
      + "回来、接不回来就继续不发布 均受回归保护");
  }
  process.exit(failures ? 1 : 0);
}

try {
  await main();
} finally {
  releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
}
