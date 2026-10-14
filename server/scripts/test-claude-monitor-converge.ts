// **恢复必须收敛**：固定输入多读几轮就该读完、销账；一次性事实一条不丢、也不反复重读前缀。
//
// 第 8 轮审查实测的那条路是：普通后台 Bash 的终态通知被当成「还没配上的事实」堆进缓冲
// （实测 76 条 task_started 里 64 条是它们），513 条顺序完全正常的 Bash 生命周期就能顶满，
// 然后整个任务的游标被丢掉、下一轮从零重读、再次顶满——于是**永远读不到末尾那个真 Monitor**
// （142MB 合法日志，真实页面 0 张卡）。
//
// 这份测试把那个形状压缩到可回归的规模：用 `ASH_MONITOR_SCAN_MAX_BYTES` 把单次上限调小，
// 于是「多轮才读完、必须收敛」这件事可以在几 KB 的夹具上验，而不是 142MB。
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { requireTmpDb, releaseTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "ash-mon-converge-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
// 单次只读 32 KiB：几十 KB 的夹具就能复现「截限 + 多轮续读」，不必写 128 MiB 的文件。
process.env.ASH_MONITOR_SCAN_MAX_BYTES = "32768";
requireTmpDb("monitor-converge");

const [
  { db, ensureSchema, dbClient }, schema, { ClaudeMonitorTrace }, { backfillClaudeMonitors, monitorScanTracked },
  recovery, { listMonitors }, scan,
] = await Promise.all([
  import("../src/db/index.js"),
  import("../src/db/schema.js"),
  import("../src/claude-monitors.js"),
  import("../src/claude-monitor-backfill.js"),
  import("../src/claude-monitor-recovery.js"),
  import("../src/monitors.js"),
  import("../src/claude-monitor-scan.js"),
]);
const { monitorRecoveryOf, monitorRecoverySessionPending, stopAllMonitorRecovery } = recovery;
const { newTaskScan, scanSession } = scan;
const { monitors, projects, sessions, tasks } = schema;
await ensureSchema();

let failures = 0;
const check = (ok: boolean, label: string, detail = "") => {
  if (ok) return;
  failures += 1;
  console.error(`✗ ${label}${detail ? ` —— ${detail}` : ""}`);
};
const now = () => new Date().toISOString();
const settle = (ms = 80) => new Promise((r) => setTimeout(r, ms));

let seq = 0;
async function fixture(name: string) {
  const taskId = `t-${name}-${seq++}`;
  const cli = `cli-${taskId}`;
  const dir = join(root, "runs", taskId);
  mkdirSync(dir, { recursive: true });
  await db.insert(tasks).values({ id: taskId, projectId: "p", title: name, body: "", status: "running",
    agentType: "claude", mode: "single", createdAt: now(), updatedAt: now() });
  await db.insert(sessions).values({
    id: `s-${taskId}`, taskId, role: "single", agentType: "claude", executor: "claude@x",
    cliSessionId: cli, cwd: root, startedAt: now(),
    agentOutPath: join(dir, `s-${taskId}-20261015T010000000Z.agent-out.jsonl`),
    agentPid: null, agentStartedAt: null,
  });
  return { taskId, cli, file: join(dir, `s-${taskId}-20261015T010000000Z.agent-out.jsonl`) };
}

const line = (ev: unknown) => JSON.stringify(ev) + "\n";

/** 一组**完整、顺序正常**的普通后台 Bash 生命周期（调用 → 开始 → 回执 → 完成）。 */
const plainBash = (cli: string, n: number) => [
  line({ type: "assistant", timestamp: "2026-10-15T01:00:05.000Z", message: { model: "m", content: [
    { type: "tool_use", name: "Bash", id: `tb${n}`, input: { command: `pytest -q shard${n}`, run_in_background: true } },
  ] } }),
  line({ type: "system", subtype: "task_started", task_id: `bbash${n}`, tool_use_id: `tb${n}`, task_type: "local_bash", session_id: cli }),
  line({ type: "user", timestamp: "2026-10-15T01:00:06.000Z", message: { role: "user", content: [
    { type: "tool_result", tool_use_id: `tb${n}`, content: `Running in background (bbash${n})` },
  ] } }),
  line({ type: "system", subtype: "task_notification", task_id: `bbash${n}`, status: "completed", summary: "跑完了", session_id: cli }),
].join("");

/** 末尾那个**真 Monitor**：调用 → 开始 → 90 秒回执 → 完成。 */
const realMonitor = (cli: string, nativeId: string) => [
  line({ type: "assistant", timestamp: "2026-10-15T02:00:05.000Z", message: { model: "m", content: [
    { type: "tool_use", name: "Monitor", id: `tu-${nativeId}`, input: { command: "until grep -q OK /tmp/r; do sleep 5; done", description: "末尾那个哨兵", timeout_ms: 600_000 } },
  ] } }),
  line({ type: "system", subtype: "task_started", task_id: nativeId, tool_use_id: `tu-${nativeId}`, task_type: "local_bash", session_id: cli }),
  line({ type: "user", timestamp: "2026-10-15T02:00:05.040Z", message: { role: "user", content: [
    { type: "tool_result", tool_use_id: `tu-${nativeId}`, content: `Monitor started (task ${nativeId}, expires in 1m 30s unless the source ends first).` },
  ] } }),
  line({ type: "system", subtype: "task_notification", task_id: nativeId, status: "completed", summary: "等到了", session_id: cli }),
].join("");

/** 自动推进会自己往下读；这里只是等它读完（或等到超时）。 */
async function waitRecovered(taskId: string, tries = 300): Promise<void> {
  for (let i = 0; i < tries && monitorRecoveryOf(taskId); i += 1) await settle(100);
}

async function main(): Promise<void> {
  await db.insert(projects).values({ id: "p", name: "p", repoPath: root, createdAt: now() });

  // ── ① 大量普通后台 Bash + 末尾一个真 Monitor：必须读到末尾 ────────────────────
  //
  // 报告实测的就是这个形状（513 组 Bash + 末尾 Monitor，142MB）。关键不是文件大，而是
  // ①「Bash 的终态通知不该占着孤儿缓冲」②「截限之后下一轮要从游标继续，而不是从零重读」。
  {
    const f = await fixture("bash-prefix");
    let body = line({ type: "system", subtype: "init", session_id: f.cli });
    for (let i = 0; i < 150; i += 1) body += plainBash(f.cli, i);
    body += realMonitor(f.cli, "btail001");
    writeFileSync(f.file, body);
    console.log(`  ① 夹具 ${body.length} 字节、150 组普通 Bash + 末尾真 Monitor，单次上限 32 KiB`);

    await backfillClaudeMonitors(f.taskId);
    // 第一轮必然没读完（远超 8 KiB）——这正是报告里「首次为空」的那一刻。
    check(monitorRecoveryOf(f.taskId)?.pending === true, "①第一轮没读完，留了账");
    await waitRecovered(f.taskId);
    check(monitorRecoveryOf(f.taskId) === null,
      "①固定输入最终读完并销账（不是永远 pending）", JSON.stringify(monitorRecoveryOf(f.taskId)));
    const rows = await listMonitors(f.taskId);
    check(rows.length === 1 && rows[0]?.nativeId === "btail001",
      "①末尾那个真 Monitor 补出来了（150 组 Bash 没把它挡住）",
      `${rows.length} 条：${rows.map((r) => r.nativeId).join(",")}`);
    check(rows[0]?.status === "exited", "①而且带着来源报的终态", String(rows[0]?.status));
    check(rows[0]?.timeoutMs === 90_000, "①和来源回执说的时长", String(rows[0]?.timeoutMs));
  }

  // ── ② 真·乱序事实占满缓冲：背压，不丢事实、不重读前缀 ───────────────────────
  //
  // 600 条**回执在前、task_started 永远不来**的 Monitor 事实（现实里不会这样，但这是缓冲
  // 真正满的唯一途径）。契约三条：缓冲满了就停在那一行之前、游标不越过它、下一轮不重读
  // 前缀（而不是「挤掉最老的那条一次性事实」）。
  //
  // 这一条直接调扫描层并给一个很大的单次上限：否则先撞的是字节上限，测不到缓冲这一支。
  {
    const f = await fixture("real-disorder");
    let body = line({ type: "system", subtype: "init", session_id: f.cli });
    for (let i = 0; i < 600; i += 1) {
      body += line({ type: "assistant", timestamp: "2026-10-15T01:00:05.000Z", message: { model: "m", content: [
        { type: "tool_use", name: "Monitor", id: `tu-dis${i}`, input: { command: "tail -F /tmp/x", description: `乱序 ${i}`, timeout_ms: 600_000 } },
      ] } });
      body += line({ type: "user", timestamp: "2026-10-15T01:00:06.000Z", message: { role: "user", content: [
        { type: "tool_result", tool_use_id: `tu-dis${i}`, content: `Monitor started (task bdis${i}, expires in 30m unless the source ends first).` },
      ] } });
    }
    writeFileSync(f.file, body);

    const scanState = newTaskScan();
    const big = 64 * 1024 * 1024;
    await scanSession(scanState, `s-${f.taskId}`, f.cli, f.file, big);
    const first = [...scanState.sessions.values()][0]!;
    const cursor1 = first.cursors.get(f.file)!;
    check(scanState.orphanOverflow === true, "②缓冲满了 → 置 orphanOverflow（背压）");
    check(cursor1.offset < body.length,
      "②游标停在那条还没消费的事实之前（没读到文件尾）", `${cursor1.offset}/${body.length}`);
    check(first.orphanReceipts.size === 512, "②缓冲停在上限上，没有挤掉任何一条", String(first.orphanReceipts.size));

    // 再扫一轮：缓冲还是满的 → 停在同一个位置，**不重读前缀**。
    scanState.advanced = false;
    scanState.orphanOverflow = false;
    await scanSession(scanState, `s-${f.taskId}`, f.cli, f.file, big);
    const cursor2 = first.cursors.get(f.file)!;
    check(cursor2.offset === cursor1.offset, "②下一轮停在同一位置", `${cursor1.offset} → ${cursor2.offset}`);
    check(scanState.advanced === false,
      "②而且没有「读到新字节」——不会被当成进展把退避预算清零", String(scanState.advanced));

    // 经由回填看一遍对外行为：留账、游标留着、一条错误的行都不写。
    await backfillClaudeMonitors(f.taskId);
    check(monitorRecoveryOf(f.taskId)?.pending === true, "②回填这一侧也留了账");
    check(monitorScanTracked(f.taskId) === true, "②游标留着（没被丢掉从零重读）");
    check((await listMonitors(f.taskId)).length === 0,
      "②一条错误的行都没写出去（没有凭空出现的 unknown 卡）");
  }

  // ── ③ 第一次归属查询就失败：责任挂在会话身份上，库好了自己补出来 ───────────────
  //
  // 上一版要在记账时再查一次同一个正在失败的 `sessions`，catch 一兜，责任凭空消失——而来源
  // 事实（tool_use/task_started/回执/完成）早已消费完（第 8 轮审查实测 firstLookup）。
  {
    const f = await fixture("first-lookup");
    writeFileSync(f.file, line({ type: "system", subtype: "init", session_id: f.cli }) + realMonitor(f.cli, "bfirst01"));

    const realExecute = dbClient.execute.bind(dbClient);
    let failed = 0;
    (dbClient as any).execute = async (stmt: any) => {
      const sql = typeof stmt === "string" ? stmt : String(stmt?.sql ?? "");
      if (/from\s+"?sessions"?/i.test(sql)) {
        failed += 1;
        throw new Error("INJECTED_SQLITE_BUSY");
      }
      return realExecute(stmt);
    };
    // 这条 Trace 从来没成功查过归属（第一条 Monitor 就撞上故障）。
    const trace = new ClaudeMonitorTrace(f.cli);
    const input = { command: "until grep -q OK /tmp/r; do sleep 5; done", description: "末尾那个哨兵", timeout_ms: 600_000 };
    trace.event({ type: "assistant", timestamp: now(), message: { content: [{ type: "tool_use", name: "Monitor", input, id: "tu-bfirst01" }] } });
    trace.toolUse("Monitor", input, "tu-bfirst01");
    trace.event({ type: "system", subtype: "task_started", task_id: "bfirst01",
      tool_use_id: "tu-bfirst01", task_type: "local_bash", session_id: f.cli });
    trace.toolResult("tu-bfirst01", "Monitor started (task bfirst01, expires in 1m 30s unless the source ends first).");
    trace.event({ type: "system", subtype: "task_notification", task_id: "bfirst01",
      status: "completed", summary: "等到了", session_id: f.cli });
    await settle(400);
    check(failed > 0, "③注入真的把归属查询打失败了", `${failed} 次`);
    check((await listMonitors(f.taskId)).length === 0, "③这一刻确实一行都没落库");
    check(monitorRecoverySessionPending(f.cli) === true,
      "③责任挂在了会话身份上（不是查不到就丢掉）");

    // 库好了：**不需要任何人再调一次**，账本自己解析归属并把事实补回来。
    (dbClient as any).execute = realExecute;
    for (let i = 0; i < 60 && (await listMonitors(f.taskId)).length === 0; i += 1) await settle(100);
    const rows = await listMonitors(f.taskId);
    check(rows.length === 1 && rows[0]?.nativeId === "bfirst01",
      "③故障恢复后自动补出来了（无人工介入）", `${rows.length} 条`);
    check(rows[0]?.timeoutMs === 90_000, "③时长也在", String(rows[0]?.timeoutMs));
    await waitRecovered(f.taskId);
    check(monitorRecoverySessionPending(f.cli) === false, "③会话那一档的责任销了");
  }

  // ── ④ 被内存硬上限挤掉时：读取位置要停好，不能退回从零重读 ────────────────────
  //
  // 软上限（32）已经豁免「正在恢复中」的游标，但硬上限（64）那一支原来是直接丢掉——于是
  // 「阈值从 32 抬到 64」并不改变结论：同时有 65 个没读完的任务轮转时，被挤掉的那个下一轮
  // 从零重读，永远到不了末尾（第 8 轮审查按控制流推断）。现在只丢可重建的配对状态，位置
  // 停好（`parked`）。
  {
    const big = await fixture("hard-cap");
    let body = line({ type: "system", subtype: "init", session_id: big.cli });
    for (let i = 0; i < 150; i += 1) body += plainBash(big.cli, i);
    body += realMonitor(big.cli, "bcap001");
    writeFileSync(big.file, body);
    await backfillClaudeMonitors(big.taskId); // 第一轮：撞 32 KiB 上限，游标停在半路
    check(monitorRecoveryOf(big.taskId)?.pending === true, "④这个任务还没读完");
    const firstRound = (await listMonitors(big.taskId)).length;
    check(firstRound === 0, "④第一轮还没读到末尾那个 Monitor", `${firstRound} 条`);

    // 70 个**同样处于恢复中**的任务（文件读不开 → 立刻 pending，而且扫描很便宜）。
    // 只有它们都在恢复中，软上限的豁免才会把压力推到硬上限上。
    const fillers: string[] = [];
    for (let i = 0; i < 70; i += 1) {
      const other = await fixture(`cap-filler${i}`);
      writeFileSync(other.file, line({ type: "system", subtype: "init", session_id: other.cli }));
      chmodSync(other.file, 0o000);
      fillers.push(other.file);
      await backfillClaudeMonitors(other.taskId);
    }
    check(monitorScanTracked(big.taskId) === false, "④它确实被挤出了快照表（硬上限生效）");
    for (const path of fillers) chmodSync(path, 0o644); // 让填充任务自己销账，别一直刷

    // 位置停好了 → 继续读就能到末尾；位置丢了就会反复重读前 32 KiB、永远读不完。
    await waitRecovered(big.taskId);
    const rows = await listMonitors(big.taskId);
    check(rows.length === 1 && rows[0]?.nativeId === "bcap001",
      "④被挤掉之后仍然从原位继续、最终读到末尾那个 Monitor",
      `${rows.length} 条：${rows.map((r) => r.nativeId).join(",")}`);
    check(monitorRecoveryOf(big.taskId) === null, "④并且销了账");
  }

  if (failures === 0) {
    console.log("✓ 内置 Monitor 恢复的收敛性：普通后台 Bash 不占缓冲（末尾 Monitor 读得到）/ "
      + "真乱序满缓冲时背压不丢事实且预算真在耗 / 首次归属查询失败也不丢责任（库好了自动补）/ "
      + "内存硬上限挤掉快照后读取位置仍停在原位 均受回归保护");
  }
}

try {
  await main();
} finally {
  stopAllMonitorRecovery();
  releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
}
process.exit(failures === 0 ? 0 : 1);
