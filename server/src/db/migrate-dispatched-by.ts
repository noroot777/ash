// 存量任务认出「派它的那条任务」（tasks.dispatched_by，语义与判据见 task-dispatch.ts）。
//
// 升级前派出去的任务只在 creation_origin 里记着来源；上线后它们就该收在派它的那条下面
// （例如一条分析任务名下那十几条），所以按同一份判据回填一次。幂等：只碰 dispatched_by 还空着的行，
// 谓词里的每一条在回填之后都不会再变（来源、parent_id、mode 建完就定了）。
import type { Client } from "./node-sqlite-client.js";

export async function backfillDispatchedBy(client: Client): Promise<void> {
  try {
    await client.execute("CREATE INDEX IF NOT EXISTS tasks_dispatched_by_idx ON tasks (dispatched_by)");
    await client.execute(
      `UPDATE tasks SET dispatched_by = json_extract(creation_origin, '$.taskId')
       WHERE dispatched_by IS NULL AND parent_id IS NULL AND mode = 'single'
         AND json_valid(creation_origin)
         AND json_extract(creation_origin, '$.kind') = 'agent'
         AND json_extract(creation_origin, '$.taskId') IS NOT NULL
         AND json_extract(creation_origin, '$.taskId') <> id
         AND EXISTS (SELECT 1 FROM tasks AS source
           WHERE source.id = json_extract(tasks.creation_origin, '$.taskId') AND source.mode = 'single')`,
    );
  } catch (e) {
    console.warn("[ash] 回填「派它的那条任务」失败，忽略(下次启动再补):", e);
  }
}
