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
