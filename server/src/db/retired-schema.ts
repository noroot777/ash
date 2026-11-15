import type { Client } from "./node-sqlite-client.js";

export async function dropRetiredTables(
  client: Client,
  retiredTables: ReadonlyArray<{ table: string; why: string }>,
): Promise<void> {
  for (const { table, why } of retiredTables) {
    try {
      const found = await client.execute({
        sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        args: [table],
      });
      if (!found.rows.length) continue;
      await client.execute(`DROP TABLE IF EXISTS ${table}`);
      console.log(`[ash] 清理退役表 ${table}(${why})`);
    } catch (e) {
      console.warn(`[ash] 退役表 ${table} 没能清掉,忽略:`, e);
    }
  }
}

/**
 * 退役的触发器。触发器挂在它监听的那张表上（不是它写进去的那张），所以不会跟着退役表一起没：
 * 写进去的那张表要是先被删了，留下的触发器会让那张被监听的表每一次更新都报错。
 */
export async function dropRetiredTriggers(
  client: Client,
  retiredTriggers: ReadonlyArray<{ trigger: string; why: string }>,
): Promise<void> {
  for (const { trigger, why } of retiredTriggers) {
    try {
      const found = await client.execute({
        sql: "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = ?",
        args: [trigger],
      });
      if (!found.rows.length) continue;
      await client.execute(`DROP TRIGGER IF EXISTS ${trigger}`);
      console.log(`[ash] 清理退役触发器 ${trigger}(${why})`);
    } catch (e) {
      console.warn(`[ash] 退役触发器 ${trigger} 没能清掉,忽略:`, e);
    }
  }
}
