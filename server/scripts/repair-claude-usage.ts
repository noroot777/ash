/**
 * claude token 账本的历史回填 —— **手工跑，默认只看不改**。
 *
 * 口径修正本身在 src/usage.ts（claude 的 result 是线程累计快照，要先求差），这个脚本
 * 负责把改口径之前记歪的 `sessions.usage_*` 按落盘 trace 重算回来，并把 trace 里那几条
 * usage 事件一并改写成真实增量（否则气泡上的「本轮」永远显示累计值）。逻辑在
 * src/claude-usage-repair.ts + src/claude-usage-trace.ts，这里只做命令行外壳 + 前后对照。
 *
 * 用法：
 *   # ① 先拷一份库，在拷贝上看前后对照（不加 --apply 永远不写）
 *   cp data/ash.db /tmp/ash-check.db
 *   npx tsx server/scripts/repair-claude-usage.ts --db /tmp/ash-check.db
 *   # ② 确认清单无误后在拷贝上真跑一遍，复查
 *   npx tsx server/scripts/repair-claude-usage.ts --db /tmp/ash-check.db --apply
 *   # ③ 生产库要先停 ash，再显式放行
 *   npx tsx server/scripts/repair-claude-usage.ts --db data/ash.db --apply --force-production
 *
 * **两道闸都要过**：路径像生产库要 `--force-production`；库上**还有活着的 ash 实例**则
 * 一律拒绝（`liveAshHolderForDb`）—— 后者才是真正要防的那件事：跑着的回合会跟回填抢同
 * 一条线程的快照、同一份 trace 文件，而只比路径的闸拦不住「--db 指到另一个检出的生产库」。
 *
 * **推荐顺序是「停服务 → 回填 → 装新 build 重启」**，而不是反过来：回填会给还活着的 CLI
 * 线程写下累计基线，重启后它们的下一回合就有东西可求差。若先重启再回填，每条线程的第一
 * 回合会把整份累计值记成增量（落盘标记是 `snapshot`）—— 脚本凭那个标记认得出并顺手补掉
 * （计划里的 `rebasedFirstTurnAfterCutoff`），但多绕一圈，没必要。
 *
 * 选项：
 *   --db <path>            要读/写的库文件（等价于 ASH_DB）。不给就用默认生产库，但那时
 *                          --apply 会被拒。
 *   --apply                真写。缺省 dry-run。
 *   --force-production     允许对默认生产库 --apply。单独一道闸，因为这是不可逆的。
 *   --boundary <iso>       claude CLI 改成「线程累计」口径的时刻，用来判旧账的口径。缺省
 *                          是实测常量 CLI_CUMULATIVE_SINCE；别的机器上升级时刻不同就在这
 *                          里指定。计划会把库里观察到的强证据跟它交叉核对并报分歧。
 *   --skip-traces          只改账、不改写 trace。气泡上的「本轮」会继续显示累计值。
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
const { liveAshHolderForDb } = await import("../src/singleton.js");
const target = resolveAshDbFile();
const apply = flag("apply");
if (apply && target === productionDb && !flag("force-production")) {
  console.error(
    `拒绝对生产库动手：${target}\n`
    + "先在拷贝上验证（--db /tmp/ash-check.db），确认无误后加 --force-production，并且先停掉 ash。",
  );
  process.exit(2);
}
// 路径之外的那道闸：这份库现在有没有人在用。回填会改 sessions 和 trace 文件，跟运行中的
// 回合抢同一条线程就会互相覆盖，所以这一条**没有放行开关**。
const holder = apply ? liveAshHolderForDb(target) : null;
if (holder) {
  console.error(
    `拒绝动手：这份库上还有活着的 ash（PID ${holder.pid}，起于 ${holder.startedAt ?? "不详"}）\n`
    + `  ${holder.command ?? "命令不详"}\n`
    + "先停掉它再回填 —— 跑着的回合会跟回填抢同一条线程的累计快照和同一份 trace 文件。",
  );
  process.exit(2);
}

const { db } = await import("../src/db/index.js");
const { sessions } = await import("../src/db/schema.js");
const { eq, isNotNull, and } = await import("drizzle-orm");
const { planClaudeUsageRepair, applyClaudeUsageRepair } = await import("../src/claude-usage-repair.js");
const { usageTotal } = await import("@ash/shared/usage");
const { sessionUsage } = await import("../src/usage.js");

const boundaryArg = value("boundary");
const plan = await planClaudeUsageRepair(boundaryArg === undefined ? {} : { boundary: boundaryArg });

const num = (n: number) => n.toLocaleString("en-US");
const changed = plan.sessions.filter((item) => item.after);
const uncertain = plan.sessions.filter((item) => item.regime === "uncertain");
const unreadable = plan.sessions.filter((item) => item.regime === "unreadable");
const straddling = plan.sessions.filter((item) => item.straddlesCutoff);
const traceEdits = plan.traces.reduce((sum, item) => sum + item.edits.length, 0);
const beforeTotal = plan.sessions.reduce((sum, item) => sum + (item.before ? usageTotal(item.before) : 0), 0);
const EMPTY = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: null, turns: 0 };
const afterTotal = plan.sessions.reduce(
  (sum, item) => sum + usageTotal(item.after ?? item.before ?? EMPTY),
  0,
);

console.log(`库文件        ${target}${target === productionDb ? "（生产库）" : ""}`);
console.log(`模式          ${apply ? "APPLY（会写库）" : "dry-run（只读）"}`);
console.log(`口径日期界    ${plan.boundary}（这之后开始的线程，旧账按「线程累计」判）`);
console.log(
  `库里强证据    最后一条逐轮增量 ${plan.observed.lastIncremental ?? "—"}`
  + ` / 最早一条线程累计 ${plan.observed.firstCumulative ?? "—"}`,
);
for (const warning of plan.warnings) console.log(`警告          ${warning}`);
console.log("");
console.log(
  `claude 会话   ${plan.sessions.length} 条：改 ${changed.length}`
  + `、不动 ${plan.sessions.length - changed.length - uncertain.length - unreadable.length}`
  + `、口径判不出 ${uncertain.length}、读不回来 ${unreadable.length}`,
);
console.log(`账面 token    ${num(beforeTotal)} → ${num(afterTotal)}`
  + (beforeTotal > 0 ? `（${(afterTotal / beforeTotal * 100).toFixed(2)}%，缩 ${(beforeTotal / Math.max(afterTotal, 1)).toFixed(1)} 倍）` : ""));
console.log(`累计快照      新建 ${plan.snapshots.length} 条（${plan.snapshots.filter((s) => s.baselineReady).length} 条可直接求差、${plan.snapshots.filter((s) => !s.baselineReady).length} 条待建基线）`);
console.log(`trace 改写    ${plan.traces.length} 份文件、${num(traceEdits)} 条 usage 事件`
  + (flag("skip-traces") ? "（--skip-traces：这次不改）" : ""));
if (straddling.length) {
  console.log(`跨口径        ${straddling.length} 条会话的 trace 一半是旧账、一半已按累计口径结算过，已按逐条标记分段`);
}
const rebased = plan.sessions.filter((item) => item.rebasedFirstTurnAfterCutoff);
if (rebased.length) {
  console.log(`补首轮        ${rebased.length} 条会话在改口径后的第一回合把整份累计值记成了增量（标记是 snapshot），已一并求差`);
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

const unresolved = [...uncertain, ...unreadable];
if (unresolved.length) {
  console.log("");
  console.log("没改的会话（原账一律不动，并留一条待建基线快照）");
  for (const item of unresolved.slice(0, limit > 0 ? limit : unresolved.length)) {
    const total = item.before ? usageTotal(item.before) : 0;
    console.log(`  ${item.sessionId}  ${item.startedAt.slice(0, 19)}  账面 ${num(total).padStart(13)}  ${item.skipped}`);
  }
  if (limit > 0 && unresolved.length > limit) {
    console.log(`  …（另有 ${unresolved.length - limit} 条，--limit 0 全部打印）`);
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

// 改 trace 和落账的顺序由 applyClaudeUsageRepair 自己保证（trace 当闸，见那边的注释）。
const result = await applyClaudeUsageRepair(plan, { rewriteTraces: !flag("skip-traces") });
if (flag("skip-traces")) {
  console.log("\ntrace 未改写（--skip-traces）：气泡上的「本轮」会继续显示累计值。");
} else {
  console.log(`\ntrace 已改写：${result.traces.files} 份文件、${num(result.traces.entries)} 条 usage 事件`
    + "（原文件各留一份 .pre-usage-repair 备份）。");
  for (const failure of result.traces.failures) console.log(`  改不了：${failure}`);
  if (result.traces.failedThreads.size) {
    console.log(`  上面这些线程(${result.traces.failedThreads.size} 条)的账这一轮也没动 —— 看过原因再重跑。`);
  }
}
console.log(`已写入：${result.sessions} 条会话、${result.snapshots} 条累计快照。`);

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
