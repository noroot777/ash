// 这一版新加的三列，在**存量库**上补得上吗 —— 而且补上之后不改写任何既有事实。
//
// 为什么单独一条：这三列是「挂着哨兵不许收工」那条不变量的凭证，而它们都走 `ensureSchema()`
// 里那串宽容 `ALTER`（已经有了就 catch 掉）。那条路上一旦抛异常，整台 ash 起不来，所以它
// 只能宽容；代价是**补不上会很安静** —— 列不在，闸读到的永远是 undefined，于是：
//  · `tasks.resume_prompt_auto` 缺 ⇒ 分不出「系统写的等待」和「agent 自己 pause 的」；
//  · `monitors.results_abandoned_at/-_reason` 缺 ⇒ 「这个结果我不要了」永远落不下来，
//    `complete_task` 对一条已经结束的哨兵会永久 409（第 2 轮审查 R2-3 的那个死循环）；
//  · `monitors.result_handoff_at/-_text` 缺 ⇒ 「结局已写定、结束通知还没入队」那一瞬没有任何
//    凭证，闸看不见它，任务照旧落 done 把唯一的结果通知吃掉（第 1 轮审查 F1）。
//
// 缺省值同样是契约：存量那段续跑指令必须被当成**agent 自己写的**（`0`）。反过来默认成 `1`
// 的话，升级之后第一次重新交卷就会把用户/agent 自己留的检查点抹掉。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { requireTmpDb, releaseTmpDb } from "./tmp-db.js";

// **先把库指到自己的临时目录,再过安全检查**（第 1 轮审查 N1）：反过来的话,没有预设
// `ASH_DB` 的人直接跑 `npm -w server run test:monitors` 会在这一条上 exit 1,而它自己
// 本来就要造一个临时库 —— 那道检查是拦「别写到真实任务库上」,不是要求调用方代劳。
const stage = mkdtempSync(join(tmpdir(), "ash-monitor-columns-"));
process.env.ASH_DB = join(stage, "legacy.db");
process.env.ASH_RUNS_DIR = join(stage, "runs");
requireTmpDb("monitor-complete-columns");

const { db, dbClient, ensureSchema } = await import("../src/db/index.js");
try {
  // 上一版的形状：两张表都在，但本轮这三列压根不存在。
  await dbClient.executeMultiple(`
    CREATE TABLE tasks (id TEXT PRIMARY KEY, project_id TEXT, group_id TEXT, parent_id TEXT,
      title TEXT, body TEXT, status TEXT, agent_type TEXT, mode TEXT,
      created_at TEXT, updated_at TEXT, resume_prompt TEXT);
    CREATE TABLE monitors (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, command TEXT, description TEXT,
      cwd TEXT, status TEXT, log_path TEXT, read_offset INTEGER, events INTEGER,
      started_at TEXT, expires_at TEXT, ended_at TEXT, ended_reason TEXT);
    INSERT INTO tasks (id, status, resume_prompt)
      VALUES ('t-old', 'paused', '继续：这是旧库里 agent 自己写下的那段');
    -- ended_by 这一列也是本任务(第 1 轮 N1)加的,所以也不在老形状里,一起验它补得上。
    INSERT INTO monitors (id, task_id, status, ended_at, ended_reason)
      VALUES ('m-old', 't-old', 'exited', '2026-10-01T00:00:00.000Z', '命令自己跑完了');
  `);

  await ensureSchema();
  const { tasks, monitors } = await import("../src/db/schema.js");

  // 逐列点名而不是 `select()`：老形状只造了本测试要看的那几列，`select *` 会去读
  // `group_id` 之类「一直都在、本轮没碰」的列而报 no such column —— 那是老形状写得窄，
  // 不是迁移的毛病，混进来只会把真失败淹掉。
  const task = (await db
    .select({ resumePrompt: tasks.resumePrompt, resumePromptAuto: tasks.resumePromptAuto })
    .from(tasks)
    .where(eq(tasks.id, "t-old"))).at(0)!;
  assert.equal(
    task.resumePromptAuto, false,
    "存量那段续跑指令必须算「agent 自己写的」——缺省 1 的话，升级后第一次重新交卷就把它抹了",
  );
  assert.equal(task.resumePrompt, "继续：这是旧库里 agent 自己写下的那段", "原文一个字都不许动");

  const readMonitor = async () =>
    (await db
      .select({
        abandonedAt: monitors.resultsAbandonedAt,
        abandonedReason: monitors.resultsAbandonedReason,
        handoffAt: monitors.resultHandoffAt,
        handoffText: monitors.resultHandoffText,
        endedBy: monitors.endedBy,
        endedReason: monitors.endedReason,
      })
      .from(monitors)
      .where(eq(monitors.id, "m-old"))).at(0)!;
  const monitor = await readMonitor();
  assert.equal(monitor.abandonedAt, null, "没有放弃凭证 = 它的结果还没被放弃过（不是「已放弃」）");
  assert.equal(monitor.abandonedReason, null);
  assert.equal(monitor.handoffAt, null, "存量那条早就结束的哨兵不在交接中（否则它会永久拦着完成）");
  assert.equal(monitor.handoffText, null);
  assert.equal(monitor.endedBy, null, "「谁让它结束的」存量为空：不许把自己跑完的说成主动停的");
  assert.equal(monitor.endedReason, "命令自己跑完了", "既有的结束事实原样留着");

  // 补上的列真的能写（ALTER 过的列类型/默认值对不上时，第一次写才会炸）。
  await db.update(tasks).set({ resumePromptAuto: true }).where(eq(tasks.id, "t-old"));
  await db.update(monitors)
    .set({
      resultsAbandonedAt: "2026-10-02T00:00:00.000Z", resultsAbandonedReason: "不要了",
      resultHandoffAt: "2026-10-02T00:00:01.000Z", resultHandoffText: "【哨兵结束】旧库那条",
    })
    .where(eq(monitors.id, "m-old"));
  const readAuto = async () =>
    (await db.select({ auto: tasks.resumePromptAuto }).from(tasks).where(eq(tasks.id, "t-old"))).at(0)!.auto;
  assert.equal(await readAuto(), true);
  assert.equal((await readMonitor()).abandonedReason, "不要了");
  assert.equal((await readMonitor()).handoffText, "【哨兵结束】旧库那条");

  // 幂等：再跑一遍 ensureSchema 不许把刚写进去的值重置掉（宽容 ALTER 失败后不许退回重建）。
  await ensureSchema();
  assert.equal(await readAuto(), true, "第二次 ensureSchema 不许把已经写上的值冲掉");
} finally {
  await releaseTmpDb();
  rmSync(stage, { recursive: true, force: true });
}
console.log("✓ 存量库升级：完成闸这几列（来源、放弃凭证、交接凭证）补得上、缺省值不改写既有事实、补上之后写得进去且幂等");
