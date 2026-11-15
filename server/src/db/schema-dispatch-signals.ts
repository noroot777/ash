// 派出的任务「失败了」那一刻的记录，画在派它的那条任务的会话里（右边一颗气泡）。
//
// 为什么要一张自己的表：失败在派出的那条任务上只是**此刻的状态**（status=failed），重试一下就没了；
// 而派它的那条任务的会话要的是**那一刻的事** —— 刷新以后气泡还在原来的位置，失败的原因还读得出来。
// 也不能写进派它的那条任务的会话正文：那份正文会进它的上下文（用户定的：这些不自动进它的上下文、
// 不叫醒它、不算它的回合）。
//
// 失败只认执行回合落成的失败：续聊回合（follow_up_from 非空）收尾时回到原来那个「失败」不是又失败了一次
// —— 用户在抽屉里跟一条失败的任务说一句话，派它的那条不该多出一颗气泡。重试是执行回合，照记。
// 触发器每次启动先删再建：定义改了，存量库也跟着换（IF NOT EXISTS 只认名字）。
//
// 写入用触发器，不在各条路上逐个记：失败有结算、启动对账、手改状态……漏一条就少一颗气泡。触发器跟
// 那一笔状态改动在同一条语句里落库，状态变了就一定有这一行。失败原因由落位那一笔在同一个事务里写进
// 刚插入的这一行（status.ts 的 failedBecause）—— 跟它说的那一笔改动同生共死，不在事后按「最新一行」
// 去猜是哪一次。
//
// 派出的任务来问不记：答题卡只在提问的那条任务自己的页面上（用户 2026-11-15 定的），派它的那条任务
// 看任务列表里那一条此刻的样子就够了。早一版记提问的触发器在这里拆掉；它留下的提问行和那几列
// （question*、answered_at、answer）在存量库里原样留着，没人再读。
//
// 只往上冒一层：记的是这条任务**自己的** dispatched_by，再往上那一层看不见它。
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { Client } from "./node-sqlite-client.js";

export const dispatchSignals = sqliteTable(
  "dispatch_signals",
  {
    // 自增序号：同一毫秒里两条一起来是常态（一批派出的任务同时失败），同一刻靠它分先后。
    seq: integer("seq").primaryKey({ autoIncrement: true }),
    /** 派它的那条任务（那一刻的 dispatched_by）。 */
    dispatcherId: text("dispatcher_id").notNull(),
    /** 失败的那条派出的任务。 */
    taskId: text("task_id").notNull(),
    /** `failed`（早一版还记过 `question`，读的时候不给）。 */
    kind: text("kind").notNull(),
    occurredAt: text("occurred_at").notNull(),
    /** 失败的原因（一句人话），落位那一笔同一个事务里补。 */
    reason: text("reason"),
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
      dispatcher_id TEXT NOT NULL, task_id TEXT NOT NULL, kind TEXT NOT NULL, occurred_at TEXT NOT NULL, reason TEXT
    );
    CREATE INDEX IF NOT EXISTS dispatch_signals_dispatcher_idx ON dispatch_signals (dispatcher_id, seq);
    CREATE INDEX IF NOT EXISTS dispatch_signals_task_idx ON dispatch_signals (task_id, seq);
    DROP TRIGGER IF EXISTS dispatch_signals_question;
    DROP TRIGGER IF EXISTS dispatch_signals_failed;
    CREATE TRIGGER dispatch_signals_failed AFTER UPDATE OF status ON tasks
      WHEN NEW.status = 'failed' AND OLD.status IS NOT 'failed' AND NEW.dispatched_by IS NOT NULL AND NEW.parent_id IS NULL
        AND OLD.follow_up_from IS NULL
    BEGIN
      INSERT INTO dispatch_signals (dispatcher_id, task_id, kind, occurred_at)
        VALUES (NEW.dispatched_by, NEW.id, 'failed', ${AT});
    END;
    CREATE TRIGGER IF NOT EXISTS dispatch_signals_task_deleted AFTER DELETE ON tasks BEGIN
      DELETE FROM dispatch_signals WHERE task_id = OLD.id OR dispatcher_id = OLD.id;
    END;
  `);
}
