// **升级没成那一轮的收尾**（第 3 轮审查 F1）。
//
// 判据只有一句：**检查点被拒也是「这一轮没完成」**，跟「读到上限」「末尾半行」同一类。
// 漏掉它的后果不是少一行日志 —— 这一轮末尾的 `clearMonitorRecovery` 会把刚登记的
// `schema-unready` 当场销掉，而登记和销账各发一条 `task.monitors`；前端只订阅这条总线，
// 收到就再 GET 一次，于是「登记 → 销账 → 通知 → GET」自激成热循环（审查用真实页面实测
// 1.3 秒 402 次 GET，面板上还什么提示都没有）。
//
// 所以这份测试走的是**完整的一轮回填**（不是直接断言 `saveScanCursors(false)`），并且盯住
// 前端唯一的触发器 `task.monitors`：失败状态下第一轮该说一次，之后必须安静；修好之后销一次
// 账，再之后继续安静。
import { writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { eq } from "drizzle-orm";
import {
  LIMIT, root, db, dbClient, schema, projects, now, check, failureCount, releaseTmpDb,
  fixture, call, started, notice, padLines,
  backfillClaudeMonitors, monitorScanTracked, listMonitors, monitorRecoveryOf, stopAllMonitorRecovery,
} from "./monitor-checkpoint-harness.js";

const { bus } = await import("../src/bus.js");
const { ensureSchema } = await import("../src/db/index.js");
const { pendingCallKeyLive } = await import("../src/db/schema-readiness.js");

/** 前端唯一的重读触发器。数它就是数「页面会被叫起来几次」。 */
let events = 0;
bus.subscribe((ev) => { if (ev.type === "task.monitors") events += 1; });
const counting = async (run: () => Promise<unknown>): Promise<number> => {
  events = 0;
  await run();
  return events;
};

const cursorsOf = (taskId: string) => db.select().from(schema.monitorScanCursors)
  .where(eq(schema.monitorScanCursors.taskId, taskId));
const reasonsOf = (taskId: string) => (monitorRecoveryOf(taskId)?.reasons ?? []).slice().sort();

/**
 * 把未决调用表退回上一代三列键，并让换表那一批撞上**真的第二个 SQLite 写者** ⇒ 核验失败。
 *
 * 不伪造异常、不手工 `markPendingCallKey(false)`：这一步要的就是生产 `ensureSchema` 自己
 * 得出「当代键没发布」。
 */
async function breakUpgrade(): Promise<void> {
  await dbClient.execute("DROP TABLE IF EXISTS monitor_pending_calls");
  await dbClient.execute("DROP TABLE IF EXISTS monitor_pending_calls_rekey");
  await dbClient.execute(`CREATE TABLE monitor_pending_calls (
    task_id TEXT NOT NULL, session_key TEXT NOT NULL, tool_use_id TEXT NOT NULL,
    command TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', at TEXT, source_run TEXT,
    PRIMARY KEY (task_id, session_key, tool_use_id))`);
  await dbClient.execute("PRAGMA busy_timeout = 25");
  const locker = new DatabaseSync(String(process.env.ASH_DB));
  const realBatch = dbClient.batch.bind(dbClient);
  let locked = false;
  (dbClient as { batch: unknown }).batch = async (stmts: { sql?: string }[], mode?: unknown) => {
    const sql = [...stmts].map((s) => (typeof s === "string" ? s : s.sql)).join(";");
    if (locked || !sql.includes("monitor_pending_calls_rekey")) return realBatch(stmts as never, mode as never);
    locked = true;
    locker.exec("BEGIN IMMEDIATE");
    try { return await realBatch(stmts as never, mode as never); } finally { locker.exec("ROLLBACK"); }
  };
  try { await ensureSchema(); } finally {
    (dbClient as { batch: unknown }).batch = realBatch;
    locker.close();
  }
  check(locked && !pendingCallKeyLive(), "夹具真的把升级撞失败了（当代键没发布）");
}

async function main(): Promise<void> {
  await db.insert(projects).values({ id: "p", name: "p", repoPath: root, createdAt: now() });

  // ① 短文件（这一轮已经读到 EOF）+ 升级失败 ⇒ 责任留着、位置不落盘、通知只发一次。
  const short = await fixture("unready-short");
  writeFileSync(short.file,
    call(short.cli, "tu-short", "短文件上的哨兵", now()) + started(short.cli, "tu-short", "nat-short")
    + notice(short.cli, "nat-short"));
  await breakUpgrade();

  const firstRound = await counting(() => backfillClaudeMonitors(short.taskId));
  check(firstRound >= 1, "① 第一轮真的变了状态 ⇒ 通知过一次", String(firstRound));
  check((await listMonitors(short.taskId)).length === 1,
    "① 这一轮读到的卡照常显示（面板不空着）");
  check(reasonsOf(short.taskId).includes("schema-unready"),
    "① EOF 收尾没有把 schema-unready 销掉", JSON.stringify(monitorRecoveryOf(short.taskId)));
  check(monitorRecoveryOf(short.taskId)?.pending === true, "① 对外说得出「还有没确认的事实」");
  check((await cursorsOf(short.taskId)).length === 0, "① 一条位置都没落盘（没盖当代戳）");
  check(!monitorScanTracked(short.taskId), "① 内存快照丢掉了（下一轮从库里那个位置重读）");

  // **这才是热循环的判据**：状态没变就不许再叫醒页面。两个读取端点合流、重复打开都算。
  const quiet = await counting(async () => {
    await backfillClaudeMonitors(short.taskId);
    await backfillClaudeMonitors(short.taskId);
    await Promise.all([backfillClaudeMonitors(short.taskId), backfillClaudeMonitors(short.taskId)]);
    monitorRecoveryOf(short.taskId);
    await listMonitors(short.taskId);
  });
  check(quiet === 0, "① 后面几轮（含并发合流）一条通知都不发 —— 页面不会被自己叫起来", String(quiet));
  check(reasonsOf(short.taskId).includes("schema-unready"), "① 责任一直留着（不是一轮一清）");
  check((await cursorsOf(short.taskId)).length === 0, "① 仍然没有位置落盘");

  // ② 长文件（这一轮没读完）：两类未完成叠在一起，照样不许销账。
  const long = await fixture("unready-long");
  writeFileSync(long.file, padLines(
    call(long.cli, "tu-long", "长文件上的哨兵", now()) + started(long.cli, "tu-long", "nat-long"),
    LIMIT * 2) + notice(long.cli, "nat-long"));
  await backfillClaudeMonitors(long.taskId);
  check(reasonsOf(long.taskId).join(",") === "scan-unfinished,schema-unready",
    "② 读到上限 + 核验没过 两条原因都在", JSON.stringify(reasonsOf(long.taskId)));
  const longQuiet = await counting(() => backfillClaudeMonitors(long.taskId));
  check(longQuiet === 0, "② 没读完的那一轮也不抖（原因没变就不通知）", String(longQuiet));

  // ③ schema 修好 ⇒ 这一轮才算完成：位置盖当代戳、责任销账（一次通知），之后安静。
  await ensureSchema();
  check(pendingCallKeyLive(), "③ 下一次启动迁成功 ⇒ 当代键发布出去了");
  const healed = await counting(() => backfillClaudeMonitors(short.taskId));
  check(healed >= 1, "③ 销账要推出去（页面上那句「还没读完」得撤）", String(healed));
  check(monitorRecoveryOf(short.taskId) === null, "③ 这一轮真的完成了 ⇒ 账销了");
  const saved = await cursorsOf(short.taskId);
  const { MONITOR_CHECKPOINT_SEMANTICS } = await import("../src/claude-monitor-cursors.js");
  check(saved.length === 1 && saved[0]?.semantics === MONITOR_CHECKPOINT_SEMANTICS
    && saved[0]?.readOffset === saved[0]?.fileSize,
    "③ 位置落盘并盖上当代戳（读到了末尾）", JSON.stringify(saved));
  const settled = await counting(async () => {
    await backfillClaudeMonitors(short.taskId);
    await backfillClaudeMonitors(short.taskId);
  });
  check(settled === 0, "③ 修好之后彻底安静（没有多余通知）", String(settled));
  check((await listMonitors(short.taskId)).length === 1, "③ 卡还在，没有被重放弄出第二张");

  // 长文件那边：原因里不该再留着 schema-unready（它已经不成立了）。
  await backfillClaudeMonitors(long.taskId);
  check(!reasonsOf(long.taskId).includes("schema-unready"),
    "③ 修好之后这条原因自己退场（只剩真的没读完那条）", JSON.stringify(reasonsOf(long.taskId)));

  if (failureCount() === 0) {
    console.log("✓ 内置 Monitor 升级没成那一轮的收尾：检查点被拒并进完成判据（EOF 也不销账）/"
      + "责任稳定留着且位置不落盘 / 失败期间不再自激通知（含两个读取出口合流与重复打开）/"
      + "修好之后销一次账、盖当代戳、随后安静 均受回归保护");
  }
  process.exit(failureCount() ? 1 : 0);
}

try {
  await main();
} finally {
  stopAllMonitorRecovery();
  releaseTmpDb();
}
