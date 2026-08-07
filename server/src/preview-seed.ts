// 预览实例的「配置播种」：把主库里**只属于设置**的那几张表，原样搬进预览的空库。
//
// 为什么需要这一步：预览起的是这个分支的整套（前端 + 后端 + 一个独立的空库，理由见
// `scripts/dev.mjs` 头部）。空库意味着**一个执行器都没有** —— 新建任务面板上写着
// 「还没有已注册执行器，暂不能创建任务」，创建按钮是灰的。于是预览退化成只能看看静态
// 页面，而凡是「得真跑一个任务才看得见」的改动（token 计数就是），在预览里根本没法验。
//
// 为什么白名单是正着列的：运行态（tasks / sessions / groups / queue_items / schedules …）
// **一张都不能进副本**。副本上的调度器分不出真假 —— 它会去接管 pid、推进队列、甚至停掉
// 本机正在干活的 agent。反着列（黑名单）意味着以后每加一张表都要有人记得去加一行，
// 漏一次的代价是上面那条；正着列则是新表默认进不来。
//
// 有一件事得说在明处：`llm_providers` 里存着明文 key，搬过去等于在
// `<worktree>/data/preview.db` 里多一份。同机器、同用户、同样在 .gitignore 里，跟主库
// 是同一条信任边界；但它会一直躺在那儿，直到 worktree 被删掉。不搬的代价是挂了供应商的
// 执行器（本项目日常用的那几个正是）在预览里起不来 CLI —— 那就等于没播种。
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createClient, type Client } from "@libsql/client";
import { dbClient } from "./db/index.js";
import { resolveHarnessDbFile } from "./db/path.js";

/** 顺序有意义：被引用的排在引用方前面（供应商 → 执行器）。 */
export const CONFIG_TABLES = [
  "app_settings",
  "llm_providers",
  "agents",
  "workflows",
  "team_presets",
  "projects",
] as const;

async function columnsOf(client: Client, table: string): Promise<string[]> {
  // 表不存在时 PRAGMA 返回空结果而不是报错，正好当「这张表跳过」用。
  const res = await client.execute(`PRAGMA table_info("${table}")`);
  return res.rows.map((row) => String(row.name));
}

/**
 * 搬表。两条规矩，都是为了让它在真实的漂移下不炸：
 *
 * ① **只搬两边都有的列**。schema 漂移两个方向都会发生：分支给某张表加了列（预览有、
 *    主库没有）、或者预览跑的是更旧的代码（主库有、预览没有）。取交集意味着两种都只是
 *    少搬一列，而不是整个启动挂掉。
 * ② **目标表非空就整张跳过**。预览是可以反复重启的，用户在预览里自己改过的配置不该被
 *    下一次启动悄悄盖回主库那份。判空按**每张表各判各的**。
 *
 * 单张表失败只记一笔继续走：少一张配置表最多是少点东西可选，不值得让 server 起不来。
 */
export async function copyConfigTables(source: Client, dest: Client): Promise<Record<string, number>> {
  const copied: Record<string, number> = {};
  for (const table of CONFIG_TABLES) {
    try {
      const [srcCols, destCols] = await Promise.all([columnsOf(source, table), columnsOf(dest, table)]);
      const cols = srcCols.filter((col) => destCols.includes(col));
      if (!cols.length) continue;
      const existing = await dest.execute(`SELECT COUNT(*) AS n FROM "${table}"`);
      if (Number(existing.rows[0]?.n ?? 0) > 0) continue;
      const list = cols.map((col) => `"${col}"`).join(", ");
      const rows = (await source.execute(`SELECT ${list} FROM "${table}"`)).rows;
      if (!rows.length) continue;
      const holes = cols.map(() => "?").join(", ");
      await dest.batch(
        rows.map((row) => ({
          sql: `INSERT INTO "${table}" (${list}) VALUES (${holes})`,
          args: cols.map((col) => row[col] ?? null),
        })),
        "write",
      );
      copied[table] = rows.length;
    } catch (e) {
      console.error(`[harness] 预览播种：${table} 没搬成（跳过）:`, e);
    }
  }
  return copied;
}

/**
 * 启动期入口，只有 `HARNESS_SEED_FROM` 非空时才走（也就是只有预览会走）。
 *
 * 源库是**用户正在用的那份**，所以这里只 SELECT，绝不写。（libsql 的 file: URL 不认
 * `?mode=ro`，拦不住的那一层只能靠这一条自律 + 上面的白名单。）
 */
export async function seedPreviewConfig(sourceFile: string): Promise<void> {
  const src = resolve(sourceFile);
  if (src === resolveHarnessDbFile()) return; // 自己搬自己
  if (!existsSync(src)) {
    console.error(`[harness] 预览播种：源库不在（${src}），预览会是个空库。`);
    return;
  }
  const source = createClient({ url: `file:${src}` });
  try {
    const copied = await copyConfigTables(source, dbClient);
    const summary = Object.entries(copied).map(([table, n]) => `${table} ${n} 行`).join("、");
    console.log(summary
      ? `[harness] 预览空库已从主库播种配置：${summary}（运行态一律没搬）`
      : "[harness] 预览播种：没有需要搬的配置（库里已有内容，或主库也是空的）");
  } catch (e) {
    console.error("[harness] 预览播种失败（预览照常起，只是没有执行器可选）:", e);
  } finally {
    source.close();
  }
}
