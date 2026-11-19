// 存量任务认出「派它的那条任务」（tasks.dispatched_by，语义与判据见 task-dispatch.ts）。
//
// 升级前派出去的任务只在 creation_origin 里记着来源；上线后它们就该收在派它的那条下面
// （例如一条分析任务名下那十几条），所以按同一份判据回填。
//
// **只回填升级那一刻之前建的行**：升级之后建的任务由 createTasks 当场判定，dispatched_by 为空
// 可能就是建它的人明确选了「不归到来源名下」—— 列值本身分不出「还没推导」和「明确不要」。所以
// 第一次跑时把边界（那一刻的时间）记进 app_settings，之后只认这一条边界：回填只碰 created_at
// 不晚于它的行。「明确不要」只有新代码建得出来，必然晚于边界，怎么重跑都碰不到它。
//
// **切出来的那两种另有一条边界**（裁定「转成独立任务」建的、合并结果审查建的修复任务）：它们是
// 后来才收进树里的，头一条边界到那一刻之间建的那些也得补，所以这条规则上线后第一次启动另记一个
// 时刻（mark.carved），只补不晚于它的。认「是这两条路建的」只凭审查记录里的记载 —— 那一轮上记着
// 承接任务（dispute_deferred_task_id）、那条审查链上记着修复任务（repair_task_id），而且它回链的
// 来源正是那条审查所在的任务。**不拿「有 origin_task_id」当判据**：用户手动从一段话派生的任务、
// 讨论交出去落实的任务也带着它，那些不收。
//
// 每次启动都按这条边界跑一遍，**不记「已完成」就收手**：有些行不经 createTasks 直接写进库
// （预览测试库开局从主库拷一份、旧备份恢复），它们是边界之前的老行，下次启动照样认得出来；
// 中途失败也一样，下次接着补。谓词里的每一条建完就定了（来源、parent_id、mode），所以幂等。
import type { Client } from "./node-sqlite-client.js";

export const DISPATCHED_BY_BACKFILL_KEY = "dispatchedByBackfill";

type BackfillMark = { cutoff: string; carved?: string };

async function readMark(client: Client): Promise<BackfillMark | null> {
  const row = (await client.execute({ sql: "SELECT value FROM app_settings WHERE key = ?", args: [DISPATCHED_BY_BACKFILL_KEY] })).rows.at(0);
  if (!row) return null;
  try {
    const parsed = JSON.parse(String(row.value)) as Partial<BackfillMark>;
    if (typeof parsed.cutoff !== "string") return null;
    return { cutoff: parsed.cutoff, ...(typeof parsed.carved === "string" ? { carved: parsed.carved } : {}) };
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
    const at = new Date().toISOString();
    const known = await readMark(client);
    const mark = { cutoff: known?.cutoff ?? at, carved: known?.carved ?? at };
    if (!known?.carved) await writeMark(client, mark);
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
    await client.execute({
      sql: `UPDATE tasks SET dispatched_by = origin_task_id
       WHERE dispatched_by IS NULL AND parent_id IS NULL AND mode = 'single'
         AND created_at <= ?
         AND origin_task_id IS NOT NULL AND origin_task_id <> id
         AND (EXISTS (SELECT 1 FROM free_review_rounds AS ruling
             JOIN free_review_runs AS run ON run.id = ruling.run_id
             WHERE ruling.dispute_deferred_task_id = tasks.id AND run.task_id = tasks.origin_task_id)
           OR EXISTS (SELECT 1 FROM free_review_runs AS run
             WHERE run.repair_task_id = tasks.id AND run.task_id = tasks.origin_task_id))
         AND EXISTS (SELECT 1 FROM tasks AS source
           WHERE source.id = tasks.origin_task_id
             AND source.mode = 'single' AND source.parent_id IS NULL)`,
      args: [mark.carved],
    });
  } catch (e) {
    console.warn("[navi] 回填「派它的那条任务」失败，忽略(下次启动按同一条边界再补):", e);
  }
}

/**
 * 预览测试库开局从主库拷了一份任务过来之后跑：拷来的是主库的行，边界也得用主库的 —— 不然主库
 * 升级之后「明确不归属」的那几条，落在主库边界之后、预览库自己的边界（开局那一刻）之前，会被
 * 这里错挂回去。主库还没升级（没有边界）就沿用预览库自己的。
 */
export async function backfillDispatchedByAfterCopy(dest: Client, source: Client): Promise<void> {
  try {
    const sourceMark = await readMark(source);
    if (sourceMark) await writeMark(dest, sourceMark);
  } catch (e) {
    console.warn("[navi] 读主库的派活归属边界失败，沿用预览库自己的:", e);
  }
  await backfillDispatchedBy(dest);
}
