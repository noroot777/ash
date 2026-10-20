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
// 第 2 轮审查又加了四列，失败形态同样安静，而且更难归因（第 3 轮又在账本口令上加了一条唯一
// 索引，一并在这里验：它引用 ALTER 补的列，建早了老库就没有；第 4 轮再补一条 —— 升级前就已经
// 有重复的库也必须拿到那条唯一性，而不是打一行警告退回先查后写）：
//  · `scheduled_messages.handoff_token` 缺 ⇒ 「这条结果送过了吗」没有原子答案。重试一旦启用
//    （F3），同一条结束通知每重试一次就多叫醒一轮 —— 而本轮正是靠它去重的（N1）。
//  · `scheduled_messages.checkpoint_auto/-_generation` 缺 ⇒ 账本只记得那段文字、记不住它是谁
//    写的、占的是哪一次槽；退回时就会继承到不属于它的来源（F2）。**缺列必须退化成「只认空槽」
//    而不是报错**，所以这里要验的是读出 `null` 而不是抛异常。
//  · `tasks.resume_prompt_generation` 缺 ⇒ 凭证里的代次无从取得，F2 那道闸整条失效。
//    存量行必须是 `0`（不是 NULL）：它要参与 `=` 比较，NULL 比出来谁也不等于谁，
//    于是所有退回都会被判成过期、一段真实的等待就此丢掉。
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
    -- 老账本：只记得那段文字(checkpoint_taken),记不住来源和占用代次,也没有转手口令。
    CREATE TABLE scheduled_messages (id TEXT PRIMARY KEY, task_id TEXT NOT NULL,
      text TEXT NOT NULL DEFAULT '', attachments TEXT NOT NULL DEFAULT '[]',
      send_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL,
      sent_at TEXT, checkpoint_taken TEXT);
    INSERT INTO tasks (id, status, resume_prompt)
      VALUES ('t-old', 'paused', '继续：这是旧库里 agent 自己写下的那段');
    -- ended_by 这一列也是本任务(第 1 轮 N1)加的,所以也不在老形状里,一起验它补得上。
    INSERT INTO monitors (id, task_id, status, ended_at, ended_reason)
      VALUES ('m-old', 't-old', 'exited', '2026-10-01T00:00:00.000Z', '命令自己跑完了');
    INSERT INTO scheduled_messages (id, task_id, text, send_at, created_at, checkpoint_taken)
      VALUES ('s-old', 't-old', '【哨兵结束】旧库入队的那条', '2026-10-01T00:00:00.000Z',
              '2026-10-01T00:00:00.000Z', '继续：这是旧库里 agent 自己写下的那段');
  `);

  await ensureSchema();
  const { tasks, monitors, scheduledMessages } = await import("../src/db/schema.js");

  // 逐列点名而不是 `select()`：老形状只造了本测试要看的那几列，`select *` 会去读
  // `group_id` 之类「一直都在、本轮没碰」的列而报 no such column —— 那是老形状写得窄，
  // 不是迁移的毛病，混进来只会把真失败淹掉。
  const task = (await db
    .select({
      resumePrompt: tasks.resumePrompt,
      resumePromptAuto: tasks.resumePromptAuto,
      resumePromptGeneration: tasks.resumePromptGeneration,
    })
    .from(tasks)
    .where(eq(tasks.id, "t-old"))).at(0)!;
  assert.equal(
    task.resumePromptAuto, false,
    "存量那段续跑指令必须算「agent 自己写的」——缺省 1 的话，升级后第一次重新交卷就把它抹了",
  );
  assert.equal(task.resumePrompt, "继续：这是旧库里 agent 自己写下的那段", "原文一个字都不许动");
  assert.equal(
    task.resumePromptGeneration, 0,
    "存量行的占用代次必须是 0 而不是 NULL：它要参与 `=` 比较，NULL 谁也不等于谁，"
      + "那样所有退回都会被判成过期、一段真实的等待就此丢掉（第 2 轮审查 F2）",
  );

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

  const readMessage = async () =>
    (await db
      .select({
        token: scheduledMessages.handoffToken,
        taken: scheduledMessages.checkpointTaken,
        auto: scheduledMessages.checkpointAuto,
        generation: scheduledMessages.checkpointGeneration,
      })
      .from(scheduledMessages)
      .where(eq(scheduledMessages.id, "s-old"))).at(0)!;
  const message = await readMessage();
  assert.equal(message.taken, "继续：这是旧库里 agent 自己写下的那段", "老账记下的那段文字原样留着");
  assert.equal(message.token, null, "老账没有转手口令：不许凭空给它一个,否则去重会把别的结果判成「送过了」");
  // **缺列要退化成 `null`,不是抛异常**：账本里这两列为空时,退回只认「槽是空的」这一条
  // （monitor-checkpoint-handoff.ts 的 `slotFor`）。这里验的是读得出来且是空,不是读得报错。
  assert.equal(message.auto, null, "老账记不住来源 ⇒ 读出 null，由退回那一侧退化处理");
  assert.equal(message.generation, null, "老账记不住占用代次 ⇒ 同上");

  // 补上的列真的能写（ALTER 过的列类型/默认值对不上时，第一次写才会炸）。
  await db.update(tasks).set({ resumePromptAuto: true, resumePromptGeneration: 7 }).where(eq(tasks.id, "t-old"));
  await db.update(scheduledMessages)
    .set({ handoffToken: "m-old:2026-10-02T00:00:01.000Z", checkpointAuto: true, checkpointGeneration: 7 })
    .where(eq(scheduledMessages.id, "s-old"));
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
  const written = await readMessage();
  assert.equal(written.token, "m-old:2026-10-02T00:00:01.000Z");
  assert.deepEqual([written.auto, written.generation], [true, 7], "布尔列走的是 INTEGER，写回来还得是布尔");

  // **存量库也要拿到那条唯一索引**（第 3 轮审查 N1）：它引用的是 ALTER 补上的那一列，所以建
  // 索引必须排在那串 ALTER 之后 —— 顺序写反的话新库有、老库没有，而「一笔交接只对应一条消息」
  // 恰恰是在老库上升级的人最需要的保证。
  // 走裸 SQL 而不是 drizzle：老形状故意只建了本测试要看的那几列，而 drizzle 的 insert 会把带
  // 缺省值的列一并写进语句，撞的是「老形状写得窄」而不是这条索引。
  const insertDup = (id: string) => dbClient.execute(
    "INSERT INTO scheduled_messages (id, task_id, text, send_at, created_at, handoff_token)"
    + ` VALUES ('${id}', 't-old', '【哨兵结束】重复的那一条', '2026-10-02T00:00:02.000Z',`
    + " '2026-10-02T00:00:02.000Z', 'm-old:2026-10-02T00:00:03.000Z')",
  );
  await insertDup("dup-a");
  await assert.rejects(() => insertDup("dup-b"), /unique/i, "升级后的老库上，同一笔交接也不许排出两条消息");

  // ── **升级之前就已经有重复**：索引照样要装上去（第 4 轮审查 N1）───────────────────────
  //
  // 这条索引建不起来只有一种原因 —— 上一版那个竞态真的发生过，库里已经有两条消息认着同一笔
  // 交接。上一版在这里只打一行警告就继续启动，于是去重退回「先查后写」，重复叫醒照旧（实测
  // `N1_OLD_DUPLICATES_DISABLE_NEW_DEDUP`：旧重复在场时索引数为 0，两次并发投递又排出两条）。
  // 而那恰恰是最需要这条保证的库。现在装之前先把重复那几条的**身份**收归最早那一条，**正文
  // 一个字都不动**（那是用户看得见的待发内容，不替他删）。
  //
  // 现场就按真实形状造：`handoff_token` 这一列是上一版 ALTER 补的（所以老库有列），索引是这一
  // 版才加的（所以老库没有）—— 把索引撤掉再写两条已 sent 的重复行，就是那种库。
  await dbClient.execute("DROP INDEX scheduled_messages_handoff_token");
  const dupToken = "m-old:2026-10-03T00:00:00.000Z";
  const insertSent = (id: string, text: string, token: string) => dbClient.execute(
    "INSERT INTO scheduled_messages (id, task_id, text, send_at, created_at, status, sent_at, handoff_token)"
    + ` VALUES ('${id}', 't-old', '${text}', '2026-10-03T00:00:00.000Z', '2026-10-03T00:00:00.000Z',`
    + ` 'sent', '2026-10-03T00:00:01.000Z', '${token}')`,
  );
  await insertSent("s-dup-1", "【哨兵结束】旧库里重复的那一条（甲）", dupToken);
  await insertSent("s-dup-2", "【哨兵结束】旧库里重复的那一条（乙）", dupToken);
  await ensureSchema();

  const indexCount = (await dbClient.execute(
    "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='index' AND name='scheduled_messages_handoff_token'",
  )).rows[0]!.n;
  assert.equal(
    Number(indexCount), 1,
    "升级前就有重复的库，升级后也必须拿到这条唯一索引 —— 只打一行警告不算修（第 4 轮审查 N1）",
  );
  const dupRows = (await dbClient.execute(
    "SELECT id, text, handoff_token FROM scheduled_messages WHERE id IN ('s-dup-1','s-dup-2') ORDER BY id",
  )).rows;
  assert.deepEqual(
    dupRows.map((r) => [r.id, r.text, r.handoff_token]),
    [
      ["s-dup-1", "【哨兵结束】旧库里重复的那一条（甲）", dupToken],
      ["s-dup-2", "【哨兵结束】旧库里重复的那一条（乙）", null],
    ],
    "两条正文一个字都不许动；这笔交接的身份只留给最早那一条（它就是真正送达的那一次）",
  );
  const kept = (await dbClient.execute(
    "SELECT id, handoff_token FROM scheduled_messages WHERE id IN ('s-old','dup-a') ORDER BY id",
  )).rows;
  assert.deepEqual(
    kept.map((r) => [r.id, r.handoff_token]),
    [["dup-a", "m-old:2026-10-02T00:00:03.000Z"], ["s-old", "m-old:2026-10-02T00:00:01.000Z"]],
    "归并只碰真的撞在一起的那几条，本来不重复的身份一个都不许动",
  );
  await assert.rejects(
    () => insertSent("s-dup-3", "【哨兵结束】升级之后再来一条", dupToken), /unique/i,
    "装上之后，同一笔交接在这台老库上也只能有一条消息（并发入队由库拦，不靠先查后写）",
  );

  // 幂等：再跑一遍 ensureSchema 不许把刚写进去的值重置掉（宽容 ALTER 失败后不许退回重建）。
  await ensureSchema();
  assert.equal(await readAuto(), true, "第二次 ensureSchema 不许把已经写上的值冲掉");
  assert.equal((await readMessage()).generation, 7, "账本那几列同上");
} finally {
  await releaseTmpDb();
  rmSync(stage, { recursive: true, force: true });
}
console.log(
  "✓ 存量库升级：完成闸这几列（来源、占用代次、放弃凭证、交接凭证、转手口令、账本来源）补得上、"
    + "缺省值不改写既有事实（代次是 0 不是 NULL、账本缺列退化成空而不是报错）、补上之后写得进去且幂等；"
    + "升级前就有重复交接的库也拿到唯一索引（身份归给最早那一条、正文一个字不动）",
);
