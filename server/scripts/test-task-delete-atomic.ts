// 删任务的**原子性**,以及它收口时那道删除门闸(`settleTaskRevocation`)。
//
// 第 6 轮审查的 F1:一条一条删的话,中间任何一条 DELETE 失败都留下「任务还在、它的行已经没了」
// —— 失败矩阵在 10 个失败点里测出 6 个让留下来的任务永久丢卡。所以这里逐条走一遍:
//
//   ① 批里**哪一条**失败都一样,整批回滚:任务、两种出身的监听卡、会话行一行不少;
//   ② 删除没删成、任务还在 ⇒ 门闸必须打开(否则它从此再也写不进任何监听,第 5 轮审查 F1);
//   ③ 删成了 ⇒ 门闸关着,迟到的写一律挡住。
//
// 做法是把真批截到前 k 条、再接一条注定失败的语句交给真的 `batch` 去跑:前 k 条在同一个
// 事务里真的执行过,然后抛错 —— 这就是「第 k 条删除失败」在生产里的样子。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { requireTmpDb, releaseTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "ash-task-delete-atomic-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
requireTmpDb("task-delete-atomic");

const [{ db, dbClient, ensureSchema }, { monitors, projects, sessions, tasks }, { isTaskRevoked }] =
  await Promise.all([
    import("../src/db/index.js"),
    import("../src/db/schema.js"),
    import("../src/claude-monitor-revoked.js"),
  ]);
await ensureSchema();
const { deleteTaskCompletely } = await import("../src/task-delete-routes.js");

const now = () => new Date().toISOString();
const sqlOf = (stmt: unknown): string =>
  typeof stmt === "string" ? stmt : String((stmt as { sql?: unknown } | null)?.sql ?? "");
/** 这一批是「删任务」那一批吗(它一定以删任务行收尾)。 */
const isDeleteBatch = (stmts: readonly unknown[]): boolean =>
  stmts.some((stmt) => /delete from "tasks"/i.test(sqlOf(stmt)));
/** 一条必然在 prepare 阶段就失败的语句:拿它当「第 k 条删除失败了」。 */
const BOOM = { sql: "SELECT INJECTED_DELETE_FAILURE_NO_SUCH_COLUMN" };

const monitorRow = (taskId: string, kind: "ash" | "claude") => ({
  id: `m-${kind}-${taskId}`, taskId, command: "tail -F build.log", description: `${kind} 那张历史卡`,
  cwd: root, status: "exited", pid: null, pidStartedAt: null, logPath: kind === "ash" ? join(root, `${taskId}.log`) : "",
  offset: 0, events: 0, exitCode: 0, startedAt: now(), expiresAt: now(), endedAt: now(), endedReason: null,
  ownerUserId: null, kind, nativeId: kind === "claude" ? `b-${taskId}` : null,
  cliSessionId: kind === "claude" ? `cli-${taskId}` : null, sourceLifetime: "bounded",
});

let seq = 0;
/** 一个「用过两种监听」的任务:一张 ash 自管的历史卡 + 一张内置 Monitor 的只读卡。 */
async function fixture(name: string): Promise<string> {
  const taskId = `t-${name}-${seq += 1}`;
  await db.insert(tasks).values({ id: taskId, projectId: "p", title: name, body: "", status: "done",
    agentType: "claude", mode: "single", createdAt: now(), updatedAt: now() });
  await db.insert(sessions).values({ id: `s-${taskId}`, taskId, role: "single", agentType: "claude",
    executor: "claude@x", cliSessionId: `cli-${taskId}`, cwd: root, startedAt: now() });
  await db.insert(monitors).values([monitorRow(taskId, "ash"), monitorRow(taskId, "claude")]);
  return taskId;
}

const realBatch = dbClient.batch.bind(dbClient);
let cut: number | null = null;
let total = 0;
(dbClient as any).batch = async (stmts: any[], mode?: any) => {
  if (isDeleteBatch(stmts)) {
    total = stmts.length;
    if (cut !== null) return realBatch([...stmts.slice(0, cut), BOOM], mode);
  }
  return realBatch(stmts, mode);
};

try {
  await db.insert(projects).values({ id: "p", name: "p", repoPath: root, createdAt: now() });

  // ── ① + ②:失败矩阵,每个失败点都走一遍 ────────────────────────────────────
  // 先量出批有多少条(第 0 条就失败 = 一条都没执行),之后逐条截断。
  for (let k = 0; ; k += 1) {
    const taskId = await fixture(`matrix-${k}`);
    cut = k;
    await assert.rejects(deleteTaskCompletely(taskId), undefined, `第 ${k} 条失败时删除要如实失败`);
    cut = null;
    const tag = `（第 ${k} 条失败）`;
    assert.equal((await db.select().from(tasks).where(eq(tasks.id, taskId))).length, 1, `①任务还在${tag}`);
    const cards = await db.select().from(monitors).where(eq(monitors.taskId, taskId));
    assert.deepEqual(cards.map((r) => r.kind).sort(), ["ash", "claude"], `①两张历史卡一张不少${tag}`);
    assert.equal((await db.select().from(sessions).where(eq(sessions.taskId, taskId))).length, 1, `①会话行还在${tag}`);
    assert.equal(isTaskRevoked(taskId), false, `②删除没删成,门闸要打开${tag}`);
    if (k === 0) assert.ok(total > 10, `删除批里确实是十几条语句(矩阵才有意义):${total} 条`);
    if (k >= total) break;
  }

  // ── ③:删成了 ⇒ 门闸关着 ─────────────────────────────────────────────────
  const doomed = await fixture("deleted");
  await deleteTaskCompletely(doomed);
  assert.equal((await db.select().from(tasks).where(eq(tasks.id, doomed))).length, 0, "③任务行没了");
  assert.equal((await db.select().from(monitors).where(eq(monitors.taskId, doomed))).length, 0, "③它的卡跟着没了");
  assert.equal(isTaskRevoked(doomed), true, "③删成了门闸就关着,迟到的写一律挡住");

  console.log(`✓ 删任务:批里 ${total} 条哪一条失败都整批回滚(任务、两种监听卡、会话行一行不少)且门闸重新打开 / `
    + "删成了门闸关着 均受回归保护");
} finally {
  (dbClient as any).batch = realBatch;
  dbClient.close();
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
}
