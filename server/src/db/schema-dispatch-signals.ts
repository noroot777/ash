// 派出的任务「来问了」「失败了」那一刻的记录，画在派它的那条任务的会话里（右边一颗气泡）。
//
// 为什么要一张自己的表：那两件事在派出的那条任务上只是**此刻的状态**（question 非空、status=failed），
// 答完、重试一下就没了；而派它的那条任务的会话要的是**那一刻的事** —— 刷新以后气泡还在原来的位置，
// 题目的头一句、失败的原因都还读得出来。也不能写进派它的那条任务的会话正文：那份正文会进它的
// 上下文（用户定的：这些问答不自动进它的上下文、不叫醒它、不算它的回合）。
//
// 写入用触发器，不在各条路上逐个记：提问有 ask_question、工作流「问我一句」、续聊回合里提的问；
// 失败有结算、启动对账、手改状态……漏一条就少一颗气泡。触发器跟那一笔状态改动在同一条语句里落库，
// 状态变了就一定有这一行。失败原因要等结算说得出来才知道，由结算之后补上（../dispatch-signals.ts）。
//
// 只往上冒一层：记的是这条任务**自己的** dispatched_by，再往上那一层看不见它。
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { Client } from "./node-sqlite-client.js";

export const dispatchSignals = sqliteTable(
  "dispatch_signals",
  {
    // 自增序号就是先后：同一毫秒里两条一起来是常态（一批派出的任务同时失败）。
    seq: integer("seq").primaryKey({ autoIncrement: true }),
    /** 派它的那条任务（那一刻的 dispatched_by）。 */
    dispatcherId: text("dispatcher_id").notNull(),
    /** 来问 / 失败的那条派出的任务。 */
    taskId: text("task_id").notNull(),
    /** `question` | `failed`。 */
    kind: text("kind").notNull(),
    occurredAt: text("occurred_at").notNull(),
    /** 提问那一刻的原话（question / question_options / question_items 原样抄下）。 */
    question: text("question"),
    questionOptions: text("question_options"),
    questionItems: text("question_items"),
    /** 失败的原因（一句人话），结算之后补。 */
    reason: text("reason"),
    /** 在派它的那条任务里答的：那条问答记录（json QuestionRecord）。在别处答的不记 —— 气泡只说「答过了」。 */
    answer: text("answer"),
  },
  (t) => ({ dispatcherIdx: index("dispatch_signals_dispatcher_idx").on(t.dispatcherId, t.seq) }),
);

// 触发器里的时刻：那一笔改动自己写的 updated_at；万一没写，就用库里的此刻。
const AT = "COALESCE(NEW.updated_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))";

/** 建表 + 装触发器（幂等，每次启动都跑；tasks.dispatched_by 那一列由 column-migrations 先补上）。 */
export async function ensureDispatchSignalSchema(client: Client): Promise<void> {
  await client.executeMultiple(`
    CREATE TABLE IF NOT EXISTS dispatch_signals (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      dispatcher_id TEXT NOT NULL, task_id TEXT NOT NULL, kind TEXT NOT NULL, occurred_at TEXT NOT NULL,
      question TEXT, question_options TEXT, question_items TEXT, reason TEXT, answer TEXT
    );
    CREATE INDEX IF NOT EXISTS dispatch_signals_dispatcher_idx ON dispatch_signals (dispatcher_id, seq);
    CREATE INDEX IF NOT EXISTS dispatch_signals_task_idx ON dispatch_signals (task_id, seq);
    CREATE TRIGGER IF NOT EXISTS dispatch_signals_question AFTER UPDATE OF question, question_options, question_items ON tasks
      WHEN NEW.question IS NOT NULL AND NEW.dispatched_by IS NOT NULL AND NEW.parent_id IS NULL
        AND (OLD.question IS NULL OR OLD.question IS NOT NEW.question
          OR OLD.question_options IS NOT NEW.question_options OR OLD.question_items IS NOT NEW.question_items)
    BEGIN
      INSERT INTO dispatch_signals (dispatcher_id, task_id, kind, occurred_at, question, question_options, question_items)
        VALUES (NEW.dispatched_by, NEW.id, 'question', ${AT}, NEW.question, NEW.question_options, NEW.question_items);
    END;
    CREATE TRIGGER IF NOT EXISTS dispatch_signals_failed AFTER UPDATE OF status ON tasks
      WHEN NEW.status = 'failed' AND OLD.status IS NOT 'failed' AND NEW.dispatched_by IS NOT NULL AND NEW.parent_id IS NULL
    BEGIN
      INSERT INTO dispatch_signals (dispatcher_id, task_id, kind, occurred_at)
        VALUES (NEW.dispatched_by, NEW.id, 'failed', ${AT});
    END;
    CREATE TRIGGER IF NOT EXISTS dispatch_signals_task_deleted AFTER DELETE ON tasks BEGIN
      DELETE FROM dispatch_signals WHERE task_id = OLD.id OR dispatcher_id = OLD.id;
    END;
  `);
}

/**
 * 升级那一刻已经在问的派出的任务：触发器装上之前问的，没有那一行，派它的那条任务里就看不到这一问
 * 是什么时候来的。按它最后一次改动的时刻补一行。只补「从来没记过一次提问」的，每次启动跑也不重复。
 * 排在 dispatched_by 回填之后（migrations.ts）：老任务的归属是那一步才认出来的。
 */
export async function backfillOpenDispatchQuestions(client: Client): Promise<void> {
  try {
    await client.execute(`INSERT INTO dispatch_signals (dispatcher_id, task_id, kind, occurred_at, question, question_options, question_items)
      SELECT dispatched_by, id, 'question', updated_at, question, question_options, question_items FROM tasks
      WHERE question IS NOT NULL AND dispatched_by IS NOT NULL AND parent_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM dispatch_signals AS s WHERE s.task_id = tasks.id AND s.kind = 'question')`);
  } catch (e) {
    console.warn("[ash] 补记升级前就在问的派出的任务失败，忽略(下次启动再补):", e);
  }
}
