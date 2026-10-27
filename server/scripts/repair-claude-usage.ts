/**
 * claude token 账本的历史回填 —— **手工跑，默认只看不改**。
 *
 * 口径修正本身在 src/usage.ts（claude 的 result 是线程累计快照，要先求差），这个脚本
 * 负责把改口径之前记歪的 `sessions.usage_*` 按落盘 trace 重算回来，并把 trace 里那几条
 * usage 事件一并改写成真实增量（否则气泡上的「本轮」永远显示累计值）。计划在
 * src/claude-usage-repair.ts、落地协议在 src/claude-usage-apply.ts，这里只做命令行外壳 +
 * 前后对照。
 *
 * ── **一套资源 = 库 + 它的 runs 目录** ────────────────────────────────────────
 * 账在库里、`result` 原始数字在 `data/runs/<task>/<session>.trace.jsonl` 里，这次回填两边都
 * 要改，所以**拷贝验证必须连 runs 一起拷**。只拷库的话，`--db` 换的是库、trace 还指着
 * 正式那份，一跑 `--apply` 就把真实历史改写了（第 2 轮审查实测）。
 *
 * 规矩因此写死在下面的闸里：**`--apply` 要求 runs 目录正好是目标库的同级 `runs/`**
 * （`--db <dir>/ash.db` ⇒ `<dir>/runs`），对不上一律拒绝，没有放行开关。dry-run 不写
 * 任何东西，所以允许 `--runs` 随便指（例如拿正式 runs 给拷贝库预览一份清单，不用拷 10G）。
 *
 * 用法：
 *   # ① 拷一套出来（库 + runs 一起），在拷贝上看前后对照（不加 --apply 永远不写）
 *   mkdir -p /tmp/ash-check && cp data/ash.db /tmp/ash-check/ash.db && cp -R data/runs /tmp/ash-check/runs
 *   npx tsx server/scripts/repair-claude-usage.ts --db /tmp/ash-check/ash.db
 *   # ② 确认清单无误后在拷贝上真跑一遍，复查（runs 自动解析到 /tmp/ash-check/runs）
 *   npx tsx server/scripts/repair-claude-usage.ts --db /tmp/ash-check/ash.db --apply
 *   # ③ 生产库要先停 ash，再显式放行
 *   npx tsx server/scripts/repair-claude-usage.ts --db data/ash.db --apply --force-production
 *
 * **四道闸都要过**：路径像生产库要 `--force-production`；库和 runs 必须是配套的一套；
 * 库上**还有活着的 ash 实例**则一律拒绝（`liveAshHolderForDb`）；真跑之前还要**取到维护
 * 锁**（`<db>.maintenance.lock`）—— 探活只能看见「现在有没有」，取锁才能挡住「我跑着的
 * 时候别人起来」：ash 启动时会检查这把锁并拒绝启动。锁按库文件命名，而上面那条配套规矩
 * 已经把 runs 绑在同一个库上，所以一把锁覆盖了这次要写的全部资源。
 *
 * **推荐顺序是「停服务 → 回填 → 装新 build 重启」**，而不是反过来：回填会给还活着的 CLI
 * 线程写下累计基线，重启后它们的下一回合就有东西可求差。若先重启再回填，每条线程的第一
 * 回合会把整份累计值记成增量（落盘标记是 `snapshot`）—— 脚本凭那个标记认得出并顺手补掉
 * （计划里的 `rebasedFirstTurnAfterCutoff`），但多绕一圈，没必要。
 *
 * 选项：
 *   --db <path>            要读/写的库文件（等价于 ASH_DB）。不给就用默认生产库，但那时
 *                          --apply 会被拒。
 *   --runs <path>          trace 所在的 runs 目录（等价于 ASH_RUNS_DIR）。缺省 = 目标库的
 *                          同级 `runs/`。--apply 时只接受这个缺省值。
 *   --apply                真写。缺省 dry-run。
 *   --force-production     允许对默认生产库 --apply。单独一道闸，因为这是不可逆的。
 *   --boundary <iso>       claude CLI 改成「线程累计」口径的时刻，用来判旧账的口径。缺省
 *                          是实测常量 CLI_CUMULATIVE_SINCE；别的机器上升级时刻不同就在这
 *                          里指定。计划会把库里观察到的强证据跟它交叉核对并报分歧。
 *   --skip-traces          只改账、不改写 trace。**这会留下半成品**：气泡上的「本轮」继续
 *                          显示累计值，而且下一次再跑这个脚本会判成「库值跟记录对不上」而
 *                          整条线程只诊断不改（这是对的 —— 账已经改过了）。只给排查用。
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

const apply = flag("apply");
const refuse = (message: string) => {
  console.error(message);
  process.exit(2);
};

// 归属判断在 src/claude-usage-resources.ts（单独一层、可单测），这里只照它说的设环境变量。
// **必须在 import paths.js 之前**：那一份在模块加载时就把 ASH_RUNS_DIR 读成了常量。
const { resolveRepairResources } = await import("../src/claude-usage-resources.js");
const binding = resolveRepairResources({
  db: value("db"),
  runs: value("runs"),
  apply,
  forceProduction: flag("force-production"),
  env: process.env,
});
if (binding.refusal) refuse(binding.refusal);
process.env.ASH_DB = binding.dbFile;
process.env.ASH_RUNS_DIR = binding.runsDir;

const { RUNS_DIR } = await import("../src/paths.js");
const { liveAshHolderForDb } = await import("../src/singleton.js");
const { acquireMaintenanceLock, MaintenanceLockError } = await import("../src/maintenance-lock.js");
const target = binding.dbFile;
const productionDb = binding.productionDb;
const pairedRuns = binding.pairedRuns;
// 路径之外的那道闸：这份库现在有没有人在用。回填会改 sessions 和 trace 文件，跟运行中的
// 回合抢同一条线程就会互相覆盖，所以这一条**没有放行开关**。
const holder = apply ? liveAshHolderForDb(target) : null;
if (holder) {
  refuse(
    `拒绝动手：这份库上还有活着的 ash（PID ${holder.pid}，起于 ${holder.startedAt ?? "不详"}）\n`
    + `  ${holder.command ?? "命令不详"}\n`
    + "先停掉它再回填 —— 跑着的回合会跟回填抢同一条线程的累计快照和同一份 trace 文件。",
  );
}
// 真正取锁：挡住「我跑着的时候 ash 起来了」。ash 启动时会读这把锁并拒绝启动。
let release: (() => void) | null = null;
if (apply) {
  try {
    release = acquireMaintenanceLock(target, "repair-claude-usage").release;
  } catch (error) {
    if (!(error instanceof MaintenanceLockError)) throw error;
    refuse(`拒绝动手：${error.message}`);
  }
}
process.on("exit", () => release?.());

const { db } = await import("../src/db/index.js");
const { sessions } = await import("../src/db/schema.js");
const { eq, isNotNull, and } = await import("drizzle-orm");
const { planClaudeUsageRepair, plannedAfter, skipReason } = await import("../src/claude-usage-repair.js");
const { applyClaudeUsageRepair } = await import("../src/claude-usage-apply.js");
const { usageTotal } = await import("@ash/shared/usage");
const { sessionUsage } = await import("../src/usage.js");

const boundaryArg = value("boundary");
const plan = await planClaudeUsageRepair(boundaryArg === undefined ? {} : { boundary: boundaryArg });

const num = (n: number) => n.toLocaleString("en-US");
const changed = plan.sessions.filter((item) => plannedAfter(item));
const uncertain = plan.sessions.filter((item) => item.regime === "uncertain");
const unreadable = plan.sessions.filter((item) => item.regime === "unreadable");
const quarantined = plan.sessions.filter((item) => item.regime === "quarantined");
const skipped = plan.sessions.filter((item) => item.action.kind === "skip");
const straddling = plan.sessions.filter((item) => item.straddlesCutoff);
const readable = plan.sessions.filter((item) => item.recorded);
const traceEdits = plan.traces.reduce((sum, item) => sum + item.edits.length, 0);
const beforeTotal = plan.sessions.reduce((sum, item) => sum + (item.before ? usageTotal(item.before) : 0), 0);
const EMPTY = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: null, turns: 0 };
const afterTotal = plan.sessions.reduce(
  (sum, item) => sum + usageTotal(plannedAfter(item) ?? item.before ?? EMPTY),
  0,
);

console.log(`库文件        ${target}${target === productionDb ? "（生产库）" : ""}`);
console.log(`runs 目录     ${RUNS_DIR}${RUNS_DIR === pairedRuns ? "（与库配套）" : "（不配套，只能 dry-run）"}`);
console.log(`模式          ${apply ? "APPLY（会写库和 trace）" : "dry-run（只读）"}`);
console.log(`口径日期界    ${plan.boundary}（这之后开始的线程，旧账按「线程累计」判）`);
console.log(
  `库里强证据    最后一条逐轮增量 ${plan.observed.lastIncremental ?? "—"}`
  + ` / 最早一条线程累计 ${plan.observed.firstCumulative ?? "—"}`,
);
for (const warning of plan.warnings) console.log(`警告          ${warning}`);
console.log("");
console.log(
  `claude 会话   ${plan.sessions.length} 条：改 ${changed.length}`
  + `、不动 ${plan.sessions.length - changed.length - skipped.length}`
  + `、只诊断 ${skipped.length}（口径判不出 ${uncertain.length}、读不回来 ${unreadable.length}`
  + `、上次没结清 ${quarantined.length}）`,
);
console.log(`trace 可读    ${readable.length} / ${plan.sessions.length} 条会话`);
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

// 一份都读不到 trace，几乎一定是「只拷了库、没拷 runs」。这时候 --apply 会把账改成
// 「一条记录都没有」的样子，所以**大声拦下来**而不是安静地啥都不改。
if (plan.sessions.length > 0 && readable.length === 0) {
  console.log(`runs 目录下一份 trace 都读不到：${RUNS_DIR}`);
  console.log("拷贝验证要连 runs 一起拷（见文件头用法 ①），否则这个脚本什么也算不出来。");
  if (apply) process.exit(2);
}

const limit = Number(value("limit") ?? 40);
const shown = limit > 0 ? changed.slice(0, limit) : changed;
console.log("前后对照（按会话起始时间）");
console.log("会话          起始                      轮  口径/证据         账面 token → 重算 token        倍数");
for (const item of shown) {
  const before = item.before ? usageTotal(item.before) : 0;
  const after = usageTotal(plannedAfter(item)!);
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
  console.log("只诊断的会话（原账一律不动，并留一条待建基线快照）");
  for (const item of skipped.slice(0, limit > 0 ? limit : skipped.length)) {
    const total = item.before ? usageTotal(item.before) : 0;
    console.log(`  ${item.sessionId}  ${item.startedAt.slice(0, 19)}  账面 ${num(total).padStart(13)}  ${skipReason(item)}`);
  }
  if (limit > 0 && skipped.length > limit) {
    console.log(`  …（另有 ${skipped.length - limit} 条，--limit 0 全部打印）`);
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

// 改 trace 和落账的顺序、失败怎么回滚，全由 applyClaudeUsageRepair 保证（见那边的协议注释）。
const result = await applyClaudeUsageRepair(plan, { rewriteTraces: !flag("skip-traces") });
if (result.refused.length) {
  console.error("\n计划里有条目越过写入边界，这一轮一个字节都没写：");
  for (const line of result.refused) console.error(`  ${line}`);
  process.exit(3);
}
if (!result.committed) {
  console.error(`\n提交失败，已整体回滚：还原了 ${result.rolledBack} 份 trace，库一个字节没改。`);
  for (const failure of result.traces.failures) console.error(`  ${failure}`);
  if (result.unresolved) {
    console.error(`\n**有几份 trace 没能还原回去**，已记在 ${result.unresolved}。`);
    console.error("那几条线程现在 trace 是新的、账是旧的，脚本从此拒绝再碰它们。收拾步骤：");
    console.error("  ① 先看上面那条还原失败的原因（多半是磁盘满 / 权限 / 路径被占）；");
    console.error("  ② 把那几份 trace 从同目录的 .pre-usage-repair 备份还原回去（cp 回原名）；");
    console.error("  ③ 再删掉那份隔离记录，然后重跑。");
    console.error("  ——只删隔离记录、不还原备份也不会把账改坏：那几条线程的库值跟记录对不上，");
    console.error("    计划会继续把它们判成「只诊断」，但也就永远修不了了。");
  } else {
    console.error("\n排除掉上面那个原因之后可以直接重跑（这一轮没有留下半成品）。");
  }
  process.exit(3);
}
if (flag("skip-traces")) {
  console.log("\ntrace 未改写（--skip-traces）：气泡上的「本轮」会继续显示累计值，而且下一次再跑"
    + "这个脚本会判成「库值跟记录对不上」而整条线程只诊断不改。");
} else {
  console.log(`\ntrace 已改写：${result.traces.files} 份文件、${num(result.traces.entries)} 条 usage 事件`
    + "（原文件各留一份 .pre-usage-repair 备份）。");
  for (const failure of result.traces.failures) console.log(`  改不了：${failure}`);
  if (result.traces.failedThreads.length) {
    console.log(`  上面这些线程(${result.traces.failedThreads.length} 条)的账和累计快照这一轮也没动`
      + " —— 它们是一个失败集。看过原因再重跑，重跑只会补上没做的那部分。");
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
const expected = result.traces.failedThreads.length ? null : afterTotal;
console.log(`复查：库里 claude 会话账面合计 ${num(verified)} token`
  + (expected === null
    ? "（有线程没动，跟计划总量本来就不等）"
    : verified === expected ? "（与计划一致）" : `（计划 ${num(expected)}，不一致！）`));
process.exit(expected === null || verified === expected ? 0 : 1);
