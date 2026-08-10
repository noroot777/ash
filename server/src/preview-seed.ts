// 预览实例的开局播种：从**你正在用的那个库**里搬一份数据进预览的空库。
//
// 两档，由 `HARNESS_SEED_MODE` 选（默认 snapshot）：
//
//   · `snapshot` —— 配置 + 运行态一起搬，搬完把运行态**洗一遍**（见 sanitize）。
//     打开预览看到的就是你现在这台 harness 的样子：一样的任务列表、一样的分组、一样的
//     会话与 token 账。这是默认档，因为「预览里空无一物」本身就让人验不了东西：
//     token 计数、列表密度、分组折叠……凡是得有数据才看得见的改动，空库里一概验不出来。
//   · `config` —— 只搬设置那几张表（老行为）。快照这条路万一出问题时的退路。
//
// **为什么快照能搬，共用一个库文件不能**：单实例锁的粒度是 DB 文件路径
// （`server/src/singleton.ts`），两个 server 开同一个库 = 幽灵调度器——第二个实例照样
// 30s tick、照样拉起 agent，而它起的子进程只在它自己内存里，主界面点停止停不掉它
// （事故见 `docs/incidents.md`「端口撞车产幽灵」）。副本没有这个问题：预览爱怎么写怎么写，
// 一个字节都落不到你的主库上。
//
// 副本仍然会漏出去的那部分，靠另外两道闸堵：
//   ① 快照里的任务行带着**真** worktree 路径和分支名 → 合并/删 worktree/删分支这类
//      动别人仓库的操作在预览实例上一律拒绝（`preview-instance.ts`）。
//   ② `sessions.agent_pid` 是**真** pid，主实例那边的 agent 正拿着它干活 → 洗成 null，
//      否则预览的 `reattachRunningTasks` 会 pid + 启动时间双双比中，真去接管它的输出。
//
// 还有一件事得说在明处：`llm_providers` 里存着明文 key，搬过去等于在
// `<worktree>/data/preview.db` 里多一份。同机器、同用户、同样在 .gitignore 里，跟主库
// 是同一条信任边界；worktree 删除时它也一起清理。不搬的代价是挂了供应商的
// 执行器（本项目日常用的那几个正是）在预览里起不来 CLI —— 那就等于没播种。
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createClient, type Client } from "@libsql/client";
import { dbClient } from "./db/index.js";
import { resolveHarnessDbFile } from "./db/path.js";

export type SeedMode = "snapshot" | "config";

/** 顺序有意义：被引用的排在引用方前面（供应商 → 执行器）。 */
export const CONFIG_TABLES = [
  "app_settings",
  "llm_providers",
  "agents",
  "workflows",
  "team_presets",
  "reviewer_profiles",
  "projects",
] as const;

/**
 * 快照档额外搬的运行态表。同样按引用顺序排。
 *
 * **`schedules` / `scheduled_messages` 故意不在这里**：那两张表一进副本，预览的调度器
 * 就会到点替你派活、到点替你发消息——用的还是真项目目录。预览是给你看的，不是替你干活的
 * （第二道保险是预览实例根本不启动调度器，见 `preview-instance.ts`）。
 */
export const SNAPSHOT_TABLES = [
  "groups",
  "tasks",
  "notes",
  "note_tasks",
  "sessions",
  // sessions 的 Codex 总账要靠这份累计基线继续求差；只搬前者不搬后者，预览里一续聊
  // 就会把整条线程累计值再加一次。
  "usage_cumulative_snapshots",
  "queue_items",
  "free_workflow_states",
  "free_workflow_events",
  "free_review_runs",
  "free_review_rounds",
] as const;

/** 一次 INSERT 多少行。纯粹是别让单个 batch 撑太大，行数本身不多（千级）。 */
const CHUNK = 400;

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
 * 单张表失败只记一笔继续走：少一张表最多是少点东西可看，不值得让 server 起不来。
 */
export async function copyTables(
  source: Client,
  dest: Client,
  tables: readonly string[],
): Promise<Record<string, number>> {
  const copied: Record<string, number> = {};
  for (const table of tables) {
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
      for (let i = 0; i < rows.length; i += CHUNK) {
        await dest.batch(
          rows.slice(i, i + CHUNK).map((row) => ({
            sql: `INSERT INTO "${table}" (${list}) VALUES (${holes})`,
            args: cols.map((col) => row[col] ?? null),
          })),
          "write",
        );
      }
      copied[table] = rows.length;
    } catch (e) {
      console.error(`[harness] 预览播种：${table} 没搬成（跳过）:`, e);
    }
  }
  return copied;
}

/** 老名字，只搬配置那几张。留着是因为它就是 `config` 档本身。 */
export function copyConfigTables(source: Client, dest: Client): Promise<Record<string, number>> {
  return copyTables(source, dest, CONFIG_TABLES);
}

/**
 * 洗运行态。**每一条都是「副本里这个值指着副本外的真东西」**，不洗就会伤到主实例：
 *
 * · `tasks.status` running/queued —— 那是**主实例**正在跑的任务。留着的话预览启动时
 *   `reattachRunningTasks` 会去接管，接不上就被 `reconcileInterrupted` 判 failed，
 *   而用户看到的是「我的任务怎么在预览里全挂了」。team 台的闲态是 `idle` 不是 `paused`，
 *   分开洗，否则常驻调度台会显示成一个被暂停的普通任务。
 * · `tasks.verify_round` —— 非空 = 此刻正在跑第几轮验证。副本里没人在跑。
 * · `sessions.agent_*` —— pid、ps 启动时间、输出文件路径。pid + 启动时间是
 *   `isSameProcess` 的**全部**判据，副本跟主库拿的是同一台机器上同一个进程，它会**判中**，
 *   然后预览就开始 tail 一个正在被主实例消费的输出文件。
 * · `schedules` / `scheduled_messages` —— 预览库上可能是旧分支或人工操作留下的，
 *   每次启动都清空，防止它在任何漏掉预览标记的旧后端上到点派活。
 *
 * 列不存在就跳过那一条（分支删过列的情形），失败只记一笔——洗不干净的代价大，但让 server
 * 起不来的代价更大，而两者都不如「明确打一行日志」。
 */
export async function sanitizeSnapshot(dest: Client): Promise<string[]> {
  const done: string[] = [];
  const taskCols = await columnsOf(dest, "tasks");
  const sessionCols = await columnsOf(dest, "sessions");
  const run = async (label: string, sql: string) => {
    try {
      const res = await dest.execute(sql);
      done.push(`${label} ${res.rowsAffected}`);
    } catch (e) {
      console.error(`[harness] 预览播种：洗「${label}」没成:`, e);
    }
  };

  if (taskCols.includes("status")) {
    if (taskCols.includes("mode")) {
      await run("在跑的团队台→idle", `UPDATE tasks SET status='idle' WHERE status IN ('running','queued') AND mode='team'`);
      await run("在跑的任务→paused", `UPDATE tasks SET status='paused' WHERE status IN ('running','queued') AND mode<>'team'`);
    } else {
      await run("在跑的任务→paused", `UPDATE tasks SET status='paused' WHERE status IN ('running','queued')`);
    }
  }
  if (taskCols.includes("verify_round")) {
    await run("验证轮清零", `UPDATE tasks SET verify_round=NULL WHERE verify_round IS NOT NULL`);
  }
  if ((await columnsOf(dest, "free_review_runs")).length) {
    await run("自由审查运行态清零", `UPDATE free_review_runs SET status='failed', finished_at=COALESCE(finished_at, updated_at) WHERE status IN ('reviewing','repairing','manual_repairing','reworking')`);
  }
  if ((await columnsOf(dest, "free_review_rounds")).length) {
    await run("自由审查轮次清零", `UPDATE free_review_rounds SET status='error', ended_at=COALESCE(ended_at, started_at) WHERE status='reviewing'`);
  }

  const agentCols = ["agent_pid", "agent_started_at", "agent_out_path", "agent_err_path", "agent_rc_path", "agent_offset"]
    .filter((col) => sessionCols.includes(col));
  if (agentCols.length) {
    await run("会话上的真 pid 与输出文件", `UPDATE sessions SET ${agentCols.map((c) => `${c}=NULL`).join(", ")}`);
  }
  await run("定时任务清空", "DELETE FROM schedules");
  await run("待发消息清空", "DELETE FROM scheduled_messages");
  return done;
}

/**
 * 启动期入口，只有 `HARNESS_SEED_FROM` 非空时才走（也就是只有预览会走）。
 *
 * 源库是**用户正在用的那份**，所以这里只 SELECT，绝不写。（libsql 的 file: URL 不认
 * `?mode=ro`，拦不住的那一层只能靠这一条自律 + 上面的白名单。）
 */
export async function seedPreviewDb(sourceFile: string, mode: SeedMode = "snapshot"): Promise<void> {
  const src = resolve(sourceFile);
  if (src === resolveHarnessDbFile()) return; // 自己搬自己
  if (!existsSync(src)) {
    console.error(`[harness] 预览播种：源库不在（${src}），预览会是个空库。`);
    return;
  }
  const tables = mode === "snapshot" ? [...CONFIG_TABLES, ...SNAPSHOT_TABLES] : CONFIG_TABLES;
  const source = createClient({ url: `file:${src}` });
  try {
    const copied = await copyTables(source, dbClient, tables);
    const summary = Object.entries(copied).map(([table, n]) => `${table} ${n}`).join("、");
    if (!summary) {
      console.log("[harness] 预览播种：没有需要搬的（库里已有内容，或主库也是空的）");
      return;
    }
    console.log(`[harness] 预览库已从主库搬来（${mode}）：${summary}`);
    if (mode === "snapshot") {
      const washed = await sanitizeSnapshot(dbClient);
      console.log(`[harness] 预览快照已洗掉运行态：${washed.join("、") || "无"}（定时任务与定时消息压根没搬）`);
    }
  } catch (e) {
    console.error("[harness] 预览播种失败（预览照常起，只是库是空的）:", e);
  } finally {
    source.close();
  }
}
