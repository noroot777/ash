/**
 * claude token 账本的历史回填 —— **手工跑，默认只看不改**。
 *
 * 口径修正本身在 src/usage.ts（claude 的 result 是线程累计快照，要先求差），这个脚本
 * 负责把改口径之前记歪的 `sessions.usage_*` 按落盘 trace 重算回来。逻辑在
 * src/claude-usage-repair.ts，这里只做命令行外壳 + 前后对照清单。
 *
 * 用法：
 *   # ① 先拷一份库，在拷贝上看前后对照（不加 --apply 永远不写）
 *   cp data/ash.db /tmp/ash-check.db
 *   npx tsx server/scripts/repair-claude-usage.ts --db /tmp/ash-check.db
 *   # ② 确认清单无误后在拷贝上真跑一遍，复查
 *   npx tsx server/scripts/repair-claude-usage.ts --db /tmp/ash-check.db --apply
 *   # ③ 生产库要先停 ash（避免跟运行中的回合抢同一条线程的快照），再显式放行
 *   npx tsx server/scripts/repair-claude-usage.ts --db data/ash.db --apply --force-production
 *
 * **推荐顺序是「停服务 → 回填 → 装新 build 重启」**，而不是反过来：回填会给 270 条还活着
 * 的 CLI 线程写下累计基线，重启后它们的下一回合就有东西可求差。若先重启再回填，每条线程
 * 的第一回合会把整份累计值记成增量（几千万）—— 脚本认得出那一笔并顺手补掉（计划里的
 * `rebasedFirstTurnAfterCutoff`），但多绕一圈，没必要。
 *
 * 选项：
 *   --db <path>            要读/写的库文件（等价于 ASH_DB）。不给就用默认生产库，但那时
 *                          --apply 会被拒。
 *   --apply                真写。缺省 dry-run。
 *   --force-production     允许对默认生产库 --apply。单独一道闸，因为这是不可逆的。
 *   --cutoff <iso>|none    「这一刻之后的 trace 条目已经是增量」。缺省从
 *                          usage_cumulative_snapshots 里 claude: 开头那批的最早
 *                          updated_at 推出来；`none` = 全部按旧口径处理（服务停着、
 *                          改口径后一轮都没跑过时的正确选择）。
 *   --report <path>        把完整计划写成 JSON。
 *   --limit <n>            清单只打前 n 条变化（默认 40；0 = 全打）。
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const value = (name: string): string | undefined => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
};

const dbArg = value("db");
if (dbArg) process.env.ASH_DB = resolve(dbArg);

const { DATA_DIR } = await import("../src/paths.js");
const productionDb = resolve(DATA_DIR, "ash.db");
const { resolveAshDbFile } = await import("../src/db/path.js");
const target = resolveAshDbFile();
const apply = flag("apply");
if (apply && target === productionDb && !flag("force-production")) {
  console.error(
    `拒绝对生产库动手：${target}\n`
    + "先在拷贝上验证（--db /tmp/ash-check.db），确认无误后加 --force-production，并且先停掉 ash。",
  );
  process.exit(2);
}

const { db } = await import("../src/db/index.js");
const { sessions } = await import("../src/db/schema.js");
const { eq, isNotNull, and } = await import("drizzle-orm");
const { planClaudeUsageRepair, applyClaudeUsageRepair } = await import("../src/claude-usage-repair.js");
const { usageTotal } = await import("@ash/shared/usage");
const { sessionUsage } = await import("../src/usage.js");

const cutoffArg = value("cutoff");
const plan = await planClaudeUsageRepair(
  cutoffArg === undefined ? {} : { cutoff: cutoffArg === "none" ? null : cutoffArg },
);

const num = (n: number) => n.toLocaleString("en-US");
const changed = plan.sessions.filter((item) => item.after);
const skipped = plan.sessions.filter((item) => item.skipped);
const straddling = plan.sessions.filter((item) => item.straddlesCutoff);
const beforeTotal = plan.sessions.reduce((sum, item) => sum + (item.before ? usageTotal(item.before) : 0), 0);
const afterTotal = plan.sessions.reduce(
  (sum, item) => sum + usageTotal(item.after ?? item.before ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: null, turns: 0 }),
  0,
);

console.log(`库文件        ${target}${target === productionDb ? "（生产库）" : ""}`);
console.log(`模式          ${apply ? "APPLY（会写库）" : "dry-run（只读）"}`);
console.log(`cutoff        ${plan.cutoff ?? "无（全部 trace 条目按旧口径处理）"}`);
console.log(
  `口径分界      最后一条逐轮增量 ${plan.boundary.lastIncremental ?? "—"}`
  + ` / 最早一条线程累计 ${plan.boundary.firstCumulative ?? "—"}`
  + ` / ${plan.boundary.clean ? "不交错" : "交错（见警告）"}`,
);
for (const warning of plan.warnings) console.log(`警告          ${warning}`);
console.log("");
console.log(`claude 会话   ${plan.sessions.length} 条：改 ${changed.length}、不动 ${plan.sessions.length - changed.length - skipped.length}、跳过 ${skipped.length}`);
console.log(`账面 token    ${num(beforeTotal)} → ${num(afterTotal)}`
  + (beforeTotal > 0 ? `（${(afterTotal / beforeTotal * 100).toFixed(2)}%，缩 ${(beforeTotal / Math.max(afterTotal, 1)).toFixed(1)} 倍）` : ""));
console.log(`累计快照      新建 ${plan.snapshots.length} 条（${plan.snapshots.filter((s) => s.baselineReady).length} 条可直接求差、${plan.snapshots.filter((s) => !s.baselineReady).length} 条待建基线）`);
if (straddling.length) {
  console.log(`跨 cutoff     ${straddling.length} 条会话的 trace 一半旧口径一半新口径，已按 cutoff 分段处理`);
}
const rebased = plan.sessions.filter((item) => item.rebasedFirstTurnAfterCutoff);
if (rebased.length) {
  console.log(`补首轮        ${rebased.length} 条会话在改口径后的第一回合把整份累计值记成了增量（快照还没建起来），已一并求差`);
}
console.log("");

const limit = Number(value("limit") ?? 40);
const shown = limit > 0 ? changed.slice(0, limit) : changed;
console.log("前后对照（按会话起始时间）");
console.log("会话          起始                      轮  口径/证据         账面 token → 重算 token        倍数");
for (const item of shown) {
  const before = item.before ? usageTotal(item.before) : 0;
  const after = usageTotal(item.after!);
  console.log(
    `${item.sessionId.padEnd(13)} ${item.startedAt.slice(0, 19)}  ${String(item.turns).padStart(3)}`
    + `  ${`${item.regime}/${item.evidence}`.padEnd(17)}`
    + ` ${num(before).padStart(15)} → ${num(after).padStart(12)}`
    + `  ${before > 0 ? `${(before / Math.max(after, 1)).toFixed(1)}x` : "—"}`,
  );
}
if (shown.length < changed.length) console.log(`…（另有 ${changed.length - shown.length} 条，--limit 0 全部打印）`);

if (skipped.length) {
  console.log("");
  console.log("跳过的会话（原账不动，并留一条待建基线快照）");
  for (const item of skipped.slice(0, limit > 0 ? limit : skipped.length)) {
    console.log(`  ${item.sessionId}  ${item.startedAt.slice(0, 19)}  ${item.skipped}`);
  }
}

const reportPath = value("report");
if (reportPath) {
  writeFileSync(resolve(reportPath), JSON.stringify(plan, null, 2));
  console.log(`\n完整计划已写入 ${resolve(reportPath)}`);
}

if (!apply) {
  console.log("\ndry-run 结束，一个字节都没写。确认清单后加 --apply。");
  process.exit(0);
}

const result = await applyClaudeUsageRepair(plan);
console.log(`\n已写入：${result.sessions} 条会话、${result.snapshots} 条累计快照。`);

// 复查一遍库里真实落下的值，而不是复述计划。
const rows = await db.select().from(sessions)
  .where(and(eq(sessions.agentType, "claude"), isNotNull(sessions.usageTurns)));
const verified = rows.reduce((sum, row) => {
  const usage = sessionUsage(row);
  return sum + (usage ? usageTotal(usage) : 0);
}, 0);
console.log(`复查：库里 claude 会话账面合计 ${num(verified)} token`
  + (verified === afterTotal ? "（与计划一致）" : `（计划 ${num(afterTotal)}，不一致！）`));
process.exit(verified === afterTotal ? 0 : 1);
