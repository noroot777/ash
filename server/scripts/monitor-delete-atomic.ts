// 删除的**原子性**那一组(㉑㉒),以及它的另一半:落库资格。
//
// 第 6 轮审查的 F1：删一个用过监听的旧任务时,只要中途任何一条 DELETE 失败,任务还在、它的
// 卡却没了 —— 审查的失败矩阵在 10 个失败点里测出 6 个让留下来的任务永久丢卡(monitors 删完
// 之后失败 ⇒ ash 那张历史卡没有任何重建路径;sessions 也删完之后失败 ⇒ 连按会话找 run 文件
// 这条重建路都断了)。不变量被收成两句:
//
//   ㉑ 失败退出时,现存任务的卡和它的全部重建依据**一行不少**(删除的库操作是一个原子批);
//   ㉒ 成功删除之后,**没有哪个旧 writer 还能把行写回去**(落库资格跟写同一个批里)。
//
// 单独成文件是 700 行上限(同 monitor-checkpoint-edges.ts 的理由)。
import { writeFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import {
  db, dbClient, schema, sessions, monitors, tasks,
  backfillClaudeMonitors, listMonitors, check, now,
  line, fixture, call, started, receipt, notice,
} from "./monitor-checkpoint-harness.js";

/** 这一批是「删任务」那一批吗（它一定以删任务行收尾）。 */
const isDeleteBatch = (stmts: readonly unknown[]): boolean =>
  stmts.some((stmt) => /delete from "tasks"/i.test(sqlOf(stmt)));

const sqlOf = (stmt: unknown): string =>
  typeof stmt === "string" ? stmt : String((stmt as { sql?: unknown } | null)?.sql ?? "");

/** 一条必然在 prepare 阶段就失败的语句：拿它当「第 k 条删除失败了」。 */
const BOOM = { sql: "SELECT INJECTED_DELETE_FAILURE_NO_SUCH_COLUMN" };

export async function deleteAtomicGroups(): Promise<void> {
  // ── ㉑ 失败矩阵:批里**哪一条**失败都一样,整批回滚 ─────────────────────────────
  //
  // 做法是把真批截到前 k 条、再接一条注定失败的语句交给真的 `batch` 去跑:前 k 条在同一个
  // 事务里真的执行过,然后抛错 —— 这就是「第 k 条删除失败」在生产里的样子,而不是在测试里
  // 绕开事务假装失败。
  const realBatch = dbClient.batch.bind(dbClient);
  let cut: number | null = null;
  (dbClient as any).batch = async (stmts: any[], mode?: any) => {
    if (cut === null || !isDeleteBatch(stmts)) return realBatch(stmts, mode);
    return realBatch([...stmts.slice(0, cut), BOOM], mode);
  };
  const { deleteTaskCompletely } = await import("../src/task-delete-routes.js");

  // 批有多少条先量出来：失败点要逐条走一遍，不是挑一个代表。
  let total = 0;
  (dbClient as any).batch = async (stmts: any[], mode?: any) => {
    if (isDeleteBatch(stmts)) {
      total = stmts.length;
      if (cut !== null) return realBatch([...stmts.slice(0, cut), BOOM], mode);
    }
    return realBatch(stmts, mode);
  };

  try {
    const probe = await deleteFixture("delete-matrix-probe");
    cut = 0;                                  // 第 0 条就失败 = 一条都没执行
    await expectFailedDelete(probe, deleteTaskCompletely);
    check(total > 10, "㉑删除批里确实是十几条语句（矩阵才有意义）", `${total} 条`);

    for (let k = 0; k <= total; k += 1) {
      const f = await deleteFixture(`delete-matrix-${k}`);
      cut = k;
      await expectFailedDelete(f, deleteTaskCompletely, `第 ${k} 条失败`);
    }
  } finally {
    cut = null;
    (dbClient as any).batch = realBatch;
  }

  // ── ㉒ 成功删除之后,旧 writer 写不回去 ────────────────────────────────────────
  //
  // 内存门闸挡不住这个窗口:writer 问门闸时任务还在,问完到真的插入之间隔着 await,删除就
  // 在那中间提交了。这里直接把门闸**开着**（模拟「问的时候还开着」）再让三个 writer 各写
  // 一次已经不存在的任务 —— 一行都不许留下（claude-monitor-write.ts）。
  {
    const { commitRound } = await import("../src/claude-monitor-commit.js");
    const { syncPendingCalls } = await import("../src/claude-monitor-pending.js");
    const { saveScanCursors } = await import("../src/claude-monitor-cursors.js");
    const { releaseTaskRevocation } = await import("../src/claude-monitor-revoked.js");
    const f = await deleteFixture("writer-after-delete");
    const taskId = f.taskId;
    await deleteTaskCompletely(taskId);
    releaseTaskRevocation(taskId);            // 门闸这一道当作已经失效（TTL 到了 / 问早了）
    check((await db.select().from(tasks).where(eq(tasks.id, taskId))).length === 0,
      "㉒前提:任务确实已经删干净了");

    const out = await commitRound(taskId, [{
      nativeId: "bzombie", toolUseId: "tu-zombie",
      call: { command: "tail -f zombie.log", description: "删除之后才落地的那一条" },
      cliSessionId: f.cli, startedAtLow: now(), startedAtHigh: null, fileStartedAt: now(),
      endedAt: now(), lifetime: "unknown", expiresMs: null,
      status: "completed", endedReason: null, filePath: f.file, staleRun: false,
    }], [], () => {});
    await syncPendingCalls(taskId, [{
      sessionKey: `s-${taskId}`, toolUseId: "tu-zombie2",
      call: { command: "sleep 1", description: "悬着的调用" }, at: now(), sourceRun: f.file,
    }], []);
    await saveScanCursors(taskId, new Map([[f.file, { size: 10, offset: 10, probe: 0, gaps: [] }]]));

    const leftover = (await db.select().from(monitors).where(eq(monitors.taskId, taskId))).length
      + (await db.select().from(schema.monitorPendingCalls)
        .where(eq(schema.monitorPendingCalls.taskId, taskId))).length
      + (await db.select().from(schema.monitorScanCursors)
        .where(eq(schema.monitorScanCursors.taskId, taskId))).length;
    check(leftover === 0, "㉒三个 writer 谁都没把行写回已经删掉的任务上",
      `${leftover} 行（commitRound 报了 added=${out.added}）`);
  }
}

/** 一个「用过两种监听」的任务：一张内置 Monitor 的卡（从真文件回填）+ 一张 ash 自管的历史卡。 */
async function deleteFixture(name: string) {
  const f = await fixture(name);
  let body = line({ type: "system", subtype: "init", session_id: f.cli });
  body += call(f.cli, `tu-${name}`, "内置的那张卡", "2026-10-15T23:00:00.000Z");
  body += started(f.cli, `tu-${name}`, `b-${name}`);
  body += receipt(`tu-${name}`, `b-${name}`, "2026-10-15T23:00:00.040Z");
  body += notice(f.cli, `b-${name}`);
  writeFileSync(f.file, body);
  await backfillClaudeMonitors(f.taskId);
  await db.insert(monitors).values({
    id: `m-ash-${name}`, taskId: f.taskId, command: "tail -f ash.log", description: "ash 自管的历史卡",
    cwd: "", status: "exited", pid: null, pidStartedAt: null, logPath: `${f.file}.ash`, offset: 0,
    events: 3, exitCode: 0, startedAt: now(), expiresAt: now(), endedAt: now(), endedReason: null,
    ownerUserId: null, kind: "ash", nativeId: null, cliSessionId: null, sourceLifetime: "bounded",
  });
  return f;
}

/** 删一次、它必须失败,然后**什么都没少**。 */
async function expectFailedDelete(
  f: { taskId: string }, del: (taskId: string) => Promise<void>, tag = "",
): Promise<void> {
  const label = tag ? `（${tag}）` : "";
  let threw = false;
  try { await del(f.taskId); } catch { threw = true; }
  check(threw, `㉑删除失败了${label}`);
  const rows = await listMonitors(f.taskId);
  check((await db.select().from(tasks).where(eq(tasks.id, f.taskId))).length === 1,
    `㉑任务还在${label}`);
  check(rows.filter((r) => r.kind === "claude").length === 1,
    `㉑内置 Monitor 那张卡还在${label}`, `${rows.length} 张`);
  check(rows.filter((r) => r.kind === "ash").length === 1,
    `㉑ash 自管那张历史卡也还在${label}`, `${rows.length} 张`);
  check((await db.select().from(sessions).where(eq(sessions.taskId, f.taskId))).length === 1,
    `㉑会话行还在（内置 Monitor 的重建依据）${label}`);
}
