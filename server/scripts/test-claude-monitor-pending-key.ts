// **未决调用表的键**：`(task_id, session_key, source_run, tool_use_id)`。
//
// 这张表存的是一条 Monitor 调用**入参的唯一出处**（命令、说明），不是可以重算的缓存。所以
// 它的键和销账条件比别处更要紧：少一维来源，两个 run 文件里的同号调用就争同一个键（第二条
// 被 `onConflictDoNothing` 吞掉），或者一轮的销账把另一轮那条也删了 —— 两种都让那张卡永久
// 消失，而读取位置照常被确认成「读完了」（新一轮第 1 轮审查 F1）。
//
// 这份测试盯**升级路径**：两种旧形状的表都要被重建成当代键，而且重建之后同号不同来源的两条
// 存得下、销账只带走指名那一条。判据本体在 `server/src/claude-monitor-pending.ts`，新库那条
// 路（bootstrap DDL）由 `test-claude-monitor-identity.ts` 的 ⑥(b) 盯着。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireTmpDb, releaseTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "ash-pending-key-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
requireTmpDb("monitor-pending-key");

const [{ db, ensureSchema, dbClient }, schema] = await Promise.all([
  import("../src/db/index.js"),
  import("../src/db/schema.js"),
]);
const { projects, tasks } = schema;
await ensureSchema();

let failures = 0;
const check = (ok: boolean, label: string, detail = "") => {
  if (ok) return;
  failures += 1;
  console.error(`✗ ${label}${detail ? ` —— ${detail}` : ""}`);
};
const now = () => new Date().toISOString();

async function main(): Promise<void> {
  await db.insert(projects).values({ id: "p", name: "p", repoPath: root, createdAt: now() });
  // ── 旧库升级：**重建成当代键**，别让它一直重复插、也别把来源挤掉 ──────────────
  //
  // 两种旧形状各自的坏法：没有任何唯一约束那张（声明式 `db:push` 在加上 Drizzle 侧
  // `primaryKey()` 之前建的）`onConflictDoNothing` 没有冲突目标可撞，每轮同步都能再插一条
  // 一模一样的（第 13 轮审查 N4，用构建产物实测重复 2 条）；三列粗键那张（上一代 bootstrap
  // DDL）则是同号不同来源只存得下一条。SQLite 改不了主键，所以升级路径上是**重建整张表**
  // （`repairPendingCallKey`）：去重 + 换键 + 补上归属那一列。
  // **两种旧形状各跑一遍**：声明式路径建的那张（没有任何唯一约束）和上一代 bootstrap DDL
  // 建的那张（主键是更粗的三列）。前者防重复插，后者防「同号不同来源只存得下一条」。
  for (const legacy of ["no-key", "coarse-key"] as const) {
    const { syncPendingCalls } = await import("../src/claude-monitor-pending.js");
    const taskKey = `t-legacy-pending-${legacy}`;
    await dbClient.execute("DROP TABLE IF EXISTS monitor_pending_calls");
    await dbClient.execute(`CREATE TABLE monitor_pending_calls (
      task_id TEXT NOT NULL, session_key TEXT NOT NULL, tool_use_id TEXT NOT NULL,
      command TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', at TEXT, source_run TEXT
      ${legacy === "coarse-key" ? ", PRIMARY KEY (task_id, session_key, tool_use_id)" : ""})`);
    // 任务行要真的有：落库资格现在跟写同一个批（claude-monitor-write.ts），任务不在 =
    // 这些行是孤儿、当场被收走。以前这个夹具省掉了它，靠的是「没人验证归属」。
    await db.insert(tasks).values({ id: taskKey, projectId: "p", title: "旧未决表", body: "",
      status: "running", agentType: "claude", mode: "single", createdAt: now(), updatedAt: now() });
    const dup = [taskKey, "s-legacy", "tu-dup", "sleep 600", "重复了两条", null, null];
    // 粗键那张表自己就拦得住第二条（`OR IGNORE` 让两种形状共用同一段夹具）。
    await dbClient.execute({ sql: "INSERT OR IGNORE INTO monitor_pending_calls VALUES (?,?,?,?,?,?,?)", args: dup });
    await dbClient.execute({ sql: "INSERT OR IGNORE INTO monitor_pending_calls VALUES (?,?,?,?,?,?,?)", args: dup });
    await dbClient.execute({ sql: "INSERT OR IGNORE INTO monitor_pending_calls VALUES (?,?,?,?,?,?,?)",
      args: [taskKey, "s-legacy", "tu-other", "sleep 1", "另一条,不许被去重带走", null, null] });

    await ensureSchema();   // ← 升级就发生在这里

    const left = await db.select().from(schema.monitorPendingCalls);
    check(left.filter((r) => r.toolUseId === "tu-dup").length === 1,
      `${legacy}：升级时把重复的那条去掉了,只留一条`, JSON.stringify(left.map((r) => r.toolUseId)));
    check(left.filter((r) => r.toolUseId === "tu-other").length === 1,
      `${legacy}：不同 tool_use_id 的那条没被去重带走`);
    const idx = await dbClient.execute("PRAGMA index_list(monitor_pending_calls)");
    check(idx.rows.some((r: any) => Number(r.unique) === 1),
      `${legacy}：唯一约束补上了（旧库从此也撞得到冲突）`, JSON.stringify(idx.rows.map((r: any) => r.name)));
    const info = await dbClient.execute("PRAGMA table_info(monitor_pending_calls)");
    const keyCols = info.rows.filter((r: any) => Number(r.pk) > 0)
      .sort((a: any, b: any) => Number(a.pk) - Number(b.pk)).map((r: any) => String(r.name));
    check(keyCols.join(",") === "task_id,session_key,source_run,tool_use_id",
      `${legacy}：键重建成了当代的四列（来源在键里）`, keyCols.join(","));
    check(info.rows.some((r: any) => String(r.name) === "cli_session_id"),
      `${legacy}：归属那一列也补上了（销账判据要用它）`);

    // 真正要防住的后果:再同步一次不会又多一条。
    const again = {
      sessionKey: "s-legacy", toolUseId: "tu-dup", at: null, cliSessionId: null, sourceRun: "",
      call: { command: "sleep 600", description: "重复了两条" },
    };
    await syncPendingCalls(taskKey, [again], []);
    await syncPendingCalls(taskKey, [again], []);
    const after = await db.select().from(schema.monitorPendingCalls);
    check(after.filter((r) => r.toolUseId === "tu-dup").length === 1,
      `${legacy}：补齐之后再同步两轮也只有一条`, String(after.filter((r) => r.toolUseId === "tu-dup").length));

    // **另一半:同号不同来源的两条都要存得下。** 旧键下第二条会被冲突吞掉,而它入参的唯一
    // 出处就是这一行。
    const twoRuns = ["/runs/legacy-a.jsonl", "/runs/legacy-b.jsonl"].map((sourceRun) => ({
      sessionKey: "s-legacy", toolUseId: "tu-twin", at: null, cliSessionId: null, sourceRun,
      call: { command: `tail -f ${sourceRun}`, description: `来自 ${sourceRun}` },
    }));
    await syncPendingCalls(taskKey, twoRuns, []);
    const twins = (await db.select().from(schema.monitorPendingCalls))
      .filter((r) => r.toolUseId === "tu-twin");
    check(twins.length === 2, `${legacy}：同一个 tool_use 号、两个 run 文件 ⇒ 各占一行`,
      JSON.stringify(twins.map((r) => r.sourceRun)));
    // 销账也只许带走指名那一条。
    await syncPendingCalls(taskKey, [], [
      { sessionKey: "s-legacy", sourceRun: "/runs/legacy-a.jsonl", toolUseId: "tu-twin" },
    ]);
    const leftTwin = (await db.select().from(schema.monitorPendingCalls))
      .filter((r) => r.toolUseId === "tu-twin");
    check(leftTwin.length === 1 && leftTwin[0]?.sourceRun === "/runs/legacy-b.jsonl",
      `${legacy}：销账按 (会话, 来源, 号) 删,没把另一个 run 的同号调用带走`,
      JSON.stringify(leftTwin.map((r) => r.sourceRun)));
  }


  if (failures === 0) {
    console.log("✓ 内置 Monitor 未决调用表的键：两种旧形状（没有键、更粗的三列键）升级时都"
      + "重建成当代四列键并去重 / 同号不同来源的两条存得下 / 销账只带走指名那一条"
      + " 均受回归保护");
  }
  process.exit(failures ? 1 : 0);
}

try {
  await main();
} finally {
  releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
}
