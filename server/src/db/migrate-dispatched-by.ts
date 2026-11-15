// 存量任务认出「派它的那条任务」（tasks.dispatched_by，语义与判据见 task-dispatch.ts）。
//
// 升级前派出去的任务只在 creation_origin 里记着来源；上线后它们就该收在派它的那条下面
// （例如一条分析任务名下那十几条），所以按同一份判据回填。
//
// **只回填升级那一刻已经在的行**：升级之后建的任务由 createTasks 当场判定，dispatched_by 为空
// 可能就是建它的人明确选了「不归到来源名下」—— 列值本身分不出「还没推导」和「明确不要」。所以
// 第一次跑时先把边界（那一刻的时间）记进 app_settings，回填只碰 created_at 不晚于它的行；中途
// 失败下次启动重试，用的还是记下的那条边界，碰不到之后建的任何一行。跑完再记「已完成」，之后
// 每次启动只读一次那条记录。
import type { Client } from "./node-sqlite-client.js";

export const DISPATCHED_BY_BACKFILL_KEY = "dispatchedByBackfill";

type BackfillMark = { cutoff: string; done?: boolean };

async function readMark(client: Client): Promise<BackfillMark | null> {
  const row = (await client.execute({ sql: "SELECT value FROM app_settings WHERE key = ?", args: [DISPATCHED_BY_BACKFILL_KEY] })).rows.at(0);
  if (!row) return null;
  try {
    const parsed = JSON.parse(String(row.value)) as Partial<BackfillMark>;
    return typeof parsed.cutoff === "string" ? { cutoff: parsed.cutoff, done: parsed.done === true } : null;
  } catch {
    return null;
  }
}

async function writeMark(client: Client, mark: BackfillMark): Promise<void> {
  await client.execute({
    sql: "INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)",
    args: [DISPATCHED_BY_BACKFILL_KEY, JSON.stringify(mark)],
  });
}

export async function backfillDispatchedBy(client: Client): Promise<void> {
  try {
    await client.execute("CREATE INDEX IF NOT EXISTS tasks_dispatched_by_idx ON tasks (dispatched_by)");
    let mark = await readMark(client);
    if (mark?.done) return;
    if (!mark) {
      mark = { cutoff: new Date().toISOString() };
      await writeMark(client, mark);
    }
    await client.execute({
      sql: `UPDATE tasks SET dispatched_by = json_extract(creation_origin, '$.taskId')
       WHERE dispatched_by IS NULL AND parent_id IS NULL AND mode = 'single'
         AND created_at <= ?
         AND json_valid(creation_origin)
         AND json_extract(creation_origin, '$.kind') = 'agent'
         AND json_extract(creation_origin, '$.taskId') IS NOT NULL
         AND json_extract(creation_origin, '$.taskId') <> id
         AND EXISTS (SELECT 1 FROM tasks AS source
           WHERE source.id = json_extract(tasks.creation_origin, '$.taskId')
             AND source.mode = 'single' AND source.parent_id IS NULL)`,
      args: [mark.cutoff],
    });
    await writeMark(client, { ...mark, done: true });
  } catch (e) {
    console.warn("[ash] 回填「派它的那条任务」失败，忽略(下次启动按同一条边界再补):", e);
  }
}
