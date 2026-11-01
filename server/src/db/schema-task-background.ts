import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { Client } from "./node-sqlite-client.js";

export const taskBackgroundRevisions = sqliteTable("task_background_revisions", {
  taskId: text("task_id").primaryKey(),
  revision: integer("revision").notNull().default(0),
});

export async function ensureTaskBackgroundSchema(client: Client): Promise<void> {
  await client.executeMultiple(`
    CREATE TABLE IF NOT EXISTS task_background_revisions (
      task_id TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0
    );
    CREATE TRIGGER IF NOT EXISTS task_background_delete AFTER DELETE ON tasks BEGIN
      DELETE FROM task_background_revisions WHERE task_id = OLD.id;
    END;
  `);
  // 每张表声明两件事:**哪几列的变化算后台事实**,以及**整行的出现/消失算不算**。
  //
  // `rowLifecycle:false` 是给 `sessions` 的:它每一回合都新增一行、删任务时整批删,
  // 而「新开一条会话」本身不是后台事实(任务行自己的 updated_at 已经动了)。只盯那一列,
  // 把水位留给真正只有这里看得见的那些变化。
  const watched: { table: string; columns: string[]; rowLifecycle: boolean }[] = [
    { table: "monitors", columns: ["status", "task_id"], rowLifecycle: true },
    { table: "accept_gate_runs", columns: ["status", "task_id", "process_pending"], rowLifecycle: true },
    // 「这条会话卡在上游连不上」(回合级停滞看门狗,见 ../turn-stall.ts)。它只住在 sessions
    // 上,改它不会动 tasks.updated_at —— 少了这道水位,前端那套快照合并分不出哪一份的后台
    // 字段更新(web/src/lib/taskSnapshot.ts)。
    { table: "sessions", columns: ["upstream_stalled_since"], rowLifecycle: false },
  ];
  for (const { table, columns, rowLifecycle } of watched) {
    const changed = columns.map((column) => `OLD.${column} IS NOT NEW.${column}`).join(" OR ");
    const bump = (record: string, condition = "1") => `
      INSERT INTO task_background_revisions (task_id, revision)
        SELECT id, 1 FROM tasks WHERE id = ${record}.task_id AND ${condition}
        ON CONFLICT(task_id) DO UPDATE SET revision = revision + 1;
    `;
    if (rowLifecycle) {
      await client.executeMultiple(`
        CREATE TRIGGER IF NOT EXISTS ${table}_background_insert AFTER INSERT ON ${table} BEGIN
          ${bump("NEW")}
        END;
        CREATE TRIGGER IF NOT EXISTS ${table}_background_delete AFTER DELETE ON ${table} BEGIN
          ${bump("OLD")}
        END;
      `);
    }
    await client.executeMultiple(`
      CREATE TRIGGER IF NOT EXISTS ${table}_background_update AFTER UPDATE OF ${columns.join(", ")} ON ${table}
        WHEN ${changed} BEGIN
        ${bump("NEW")}
        ${bump("OLD", "OLD.task_id IS NOT NEW.task_id")}
      END;
    `);
  }
}
