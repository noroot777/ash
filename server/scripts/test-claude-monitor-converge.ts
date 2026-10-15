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
// 退避阶梯压到 8 × 60ms：默认阶梯整条跑完 ≈ 9 分钟，「多轮才读完」和「预算耗尽」两件事就
// 都没法在测试里跑。档位数（8）保持一致，耗尽需要的次数才跟生产一样。
process.env.ASH_MONITOR_BACKOFF_MS = "60,60,60,60,60,60,60,60";
requireTmpDb("monitor-converge");

const [
  { db, ensureSchema, dbClient }, schema, { ClaudeMonitorTrace }, { backfillClaudeMonitors, monitorCheckpointOf, monitorScanTracked },
  recovery, { listMonitors }, scan, { bus },
] = await Promise.all([
  import("../src/db/index.js"),
  import("../src/db/schema.js"),
  import("../src/claude-monitors.js"),
  import("../src/claude-monitor-backfill.js"),
  import("../src/claude-monitor-recovery.js"),
  import("../src/monitors.js"),
  import("../src/claude-monitor-scan.js"),
  import("../src/bus.js"),
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
  //
  // **组数必须顶过 LATE_CAP（512）**：150 组时缓冲根本填不满，于是「普通 Bash 不占缓冲」
  // 这条断言是免费的——把 notMonitorTools/confirmedForeign 两处删掉，测试照样绿。
  {
    const f = await fixture("bash-prefix");
    let body = line({ type: "system", subtype: "init", session_id: f.cli });
    for (let i = 0; i < 600; i += 1) body += plainBash(f.cli, i);
    body += realMonitor(f.cli, "btail001");
    writeFileSync(f.file, body);
    console.log(`  ① 夹具 ${body.length} 字节、600 组普通 Bash（> 缓冲上限 512）`
      + ` + 末尾真 Monitor，单次上限 32 KiB`);

    await backfillClaudeMonitors(f.taskId);
    // 第一轮必然没读完（远超 8 KiB）——这正是报告里「首次为空」的那一刻。
    check(monitorRecoveryOf(f.taskId)?.pending === true, "①第一轮没读完，留了账");
    await waitRecovered(f.taskId);
    check(monitorRecoveryOf(f.taskId) === null,
      "①固定输入最终读完并销账（不是永远 pending）", JSON.stringify(monitorRecoveryOf(f.taskId)));
    const rows = await listMonitors(f.taskId);
    check(rows.length === 1 && rows[0]?.nativeId === "btail001",
      "①末尾那个真 Monitor 补出来了（600 组 Bash 没把它挡住）",
      `${rows.length} 条：${rows.map((r) => r.nativeId).join(",")}`);
    check(rows[0]?.status === "exited", "①而且带着来源报的终态", String(rows[0]?.status));
    check(rows[0]?.timeoutMs === 90_000, "①和来源回执说的时长", String(rows[0]?.timeoutMs));
  }

  // ── ② 一轮里要裁决的事实太多：背压，不丢事实、不重读前缀 ─────────────────────
  //
  // 600 条**回执在前、task_started 永远不来**的 Monitor 事实（现实里不会这样，但这是单轮通道
  // 真正顶满的唯一途径）。契约三条：顶满了就停在那一行之前、游标不越过它、下一轮不重读前缀
  // （而不是「挤掉最老的那条一次性事实」）。
  //
  // 这一条直接调扫描层并给一个很大的单次上限：否则先撞的是字节上限，测不到这一支。
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
    check(scanState.lateOverflow === true, "②单轮通道顶满了 → 置 lateOverflow（背压）");
    check(cursor1.offset < body.length,
      "②游标停在那条还没消费的事实之前（没读到文件尾）", `${cursor1.offset}/${body.length}`);
    check(first.late.length === 512, "②通道停在上限上，没有挤掉任何一条", String(first.late.length));
    // 这 600 条调用都还悬着（`task_started` 永远不来）。**位置不为它们让路**：入参由
    // `monitor_pending_calls` 保着（见 claude-monitor-pending.ts）。让路的那一版会被一条
    // 永远不会完结的调用把位置钉死（第 11 轮审查实测 12 轮停滞）。
    const park = scan.parkableCursors(scanState).get(f.file)!;
    check(park.offset === cursor1.offset, "②停好的位置就是读到的位置（不往回退）",
      `停好 ${park.offset} / 读到 ${cursor1.offset}`);
    check(scan.pendingCallsOf(scanState).length >= 512,
      "②而那些悬着的调用交出来落盘了（位置不回退的前提）",
      String(scan.pendingCallsOf(scanState).length));

    // 再扫一轮：通道还是满的 → 停在同一个位置，**不重读前缀**。
    scanState.advanced = false;
    scanState.lateOverflow = false;
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
    const parkedCalls = await db.select().from(schema.monitorPendingCalls)
      .where(eq(schema.monitorPendingCalls.taskId, f.taskId));
    check(parkedCalls.length > 0 && parkedCalls.every((r) => !!r.command),
      "②回填这一侧把悬着的调用连入参一起落了盘（下一轮不靠重读那一行）",
      `${parkedCalls.length} 条`);
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
  //
  // **压力要每一轮都在**：挤一次只损失一轮的进度，之后照样读完——那样测不出区别。所以这里
  // 让 70 个「文件读不开」的任务一直处于恢复中（软上限豁免它们 → 压力全压到硬上限上），
  // 每读一轮就把它们全推一遍，于是被测任务**每一轮都被挤出去**。位置停好才收敛。
  {
    const big = await fixture("hard-cap");
    let body = line({ type: "system", subtype: "init", session_id: big.cli });
    for (let i = 0; i < 150; i += 1) body += plainBash(big.cli, i);
    body += realMonitor(big.cli, "bcap001");
    writeFileSync(big.file, body);

    // 70 个同样处于恢复中的任务（文件读不开 → 立刻 pending，而且扫描很便宜）。
    const fillers: { taskId: string; file: string }[] = [];
    for (let i = 0; i < 70; i += 1) {
      const other = await fixture(`cap-filler${i}`);
      writeFileSync(other.file, line({ type: "system", subtype: "init", session_id: other.cli }));
      chmodSync(other.file, 0o000);
      fillers.push({ taskId: other.taskId, file: other.file });
    }
    const squeeze = async () => {
      for (const f of fillers) await backfillClaudeMonitors(f.taskId);
    };

    await backfillClaudeMonitors(big.taskId); // 第一轮：撞 32 KiB 上限，游标停在半路
    check(monitorRecoveryOf(big.taskId)?.pending === true, "④这个任务还没读完");
    // **位置不等被挤掉才留**：提交确认之后当场进检查点表，于是它的存活不依赖「这份运行中的
    // 对象还在不在 LRU」——被挤掉可以发生在本轮任何一个 await 处（第 12 轮审查 F1）。
    check(monitorScanTracked(big.taskId) === true && monitorCheckpointOf(big.taskId) !== null,
      "④这一轮确认提交之后，位置同时在内存快照和检查点表里（不是只等被挤掉时才停）",
      `快照 ${monitorScanTracked(big.taskId)} / 检查点 ${JSON.stringify([...(monitorCheckpointOf(big.taskId)?.values() ?? [])])}`);
    check((await listMonitors(big.taskId)).length === 0,
      "④第一轮还没读到末尾那个 Monitor", `${(await listMonitors(big.taskId)).length} 条`);
    await squeeze();
    check(monitorScanTracked(big.taskId) === false, "④它确实被挤出了快照表（硬上限生效）");

    let rounds = 1;
    for (; rounds < 12 && (await listMonitors(big.taskId)).length === 0; rounds += 1) {
      await backfillClaudeMonitors(big.taskId);
      await squeeze(); // 每一轮都重新顶满，被测任务又被挤出去
    }
    const rows = await listMonitors(big.taskId);
    check(rows.length === 1 && rows[0]?.nativeId === "bcap001",
      "④每一轮都被挤掉，仍然从原位继续、最终读到末尾那个 Monitor",
      `${rounds} 轮后 ${rows.length} 条：${rows.map((r) => r.nativeId).join(",")}`);
    for (const f of fillers) chmodSync(f.file, 0o644); // 让填充任务自己销账，别一直刷
    await waitRecovered(big.taskId);
    check(monitorRecoveryOf(big.taskId) === null, "④并且销了账",
      JSON.stringify(monitorRecoveryOf(big.taskId)));
  }

  // ── ⑤ 丢过游标的那一轮：「读到新字节」不算进展，退避预算要照常往下走 ──────────────
  //
  // 对称错误：CAS miss / 写失败这两条路会把游标丢掉，而丢完的下一轮必然「读到新字节」（它在
  // 重读已经读过的前缀）。拿它当进展就会把预算清零——于是每秒重读一个大文件、永远到不了
  // exhausted（第 8 轮审查指出）。进展得绑定单调往前的位置或确认落地的事实。
  //
  // 怎么验：让**每一轮都以丢游标收场**（写库一直失败），于是每一轮都是重读。契约成立时退避
  // 阶梯照常往下走（1→2→5s，4.6 秒内能数到第 3 档）；把 `!reread` 去掉就变成每秒清零重排
  // 第一档，永远停在 1。
  {
    const f = await fixture("rewound");
    let body = line({ type: "system", subtype: "init", session_id: f.cli });
    body += realMonitor(f.cli, "brew001");
    for (let i = 0; i < 150; i += 1) body += plainBash(f.cli, i); // 远超 32 KiB → 每轮都截限
    writeFileSync(f.file, body);

    // 写库一直失败 → 每轮都走 catch：事实读过了却没落库，游标被丢掉（下一轮从零重读）。
    // 只拦这个任务的语句，别影响还在恢复中的 ②。
    const realExecute = dbClient.execute.bind(dbClient);
    let hit = 0;
    (dbClient as any).execute = async (stmt: any) => {
      const sql = typeof stmt === "string" ? stmt : String(stmt?.sql ?? "");
      const args = JSON.stringify(stmt?.args ?? []);
      if (/monitors/i.test(sql) && args.includes(f.taskId)) {
        hit += 1;
        throw new Error("INJECTED_WRITE_FAILURE");
      }
      return realExecute(stmt);
    };
    await backfillClaudeMonitors(f.taskId);
    check(hit > 0, "⑤注入真的打到了写库那一步", `${hit} 次`);
    const a1 = monitorRecoveryOf(f.taskId)?.attempts ?? -1;
    check(a1 === 1, "⑤第一轮排了第一档重试", String(a1));

    // 之后每一轮都是重读，预算必须继续往下耗（压短后的阶梯：每档 60ms）。
    await settle(500);
    const a2 = monitorRecoveryOf(f.taskId)?.attempts ?? -1;
    check(a2 >= 3, "⑤重读那几轮不算进展（预算真的在往下耗，不是每轮清零重排第一档）",
      `${a1} → ${a2}`);

    // 故障结束：丢游标丢的只是位置，事实还在文件里 —— 重新读一遍就补回来。
    // （读库也得等注入撤了再读：listMonitors 自己会被同一条注入打中。）
    (dbClient as any).execute = realExecute;
    check((await listMonitors(f.taskId)).length === 0, "⑤故障期间一行都没落库");
    for (let i = 0; i < 12 && (await listMonitors(f.taskId)).length === 0; i += 1) {
      await backfillClaudeMonitors(f.taskId);
    }
    const rows = await listMonitors(f.taskId);
    check(rows.length === 1 && rows[0]?.nativeId === "brew001",
      "⑤故障结束后那条事实被重新读到了（丢游标没丢事实）", `${rows.length} 条`);
  }

  // ── ⑥ 预算耗尽：账留着、状态推出去、下一次真实请求能把它重新推起来 ──────────────
  //
  // 一直失败的那种（文件权限坏了）推到上限就停，但**账不能销**——面板据此显示「还有历史没
  // 读完」，而不是谎称「这个任务没用过哨兵」。耗尽本身是一次可见状态变化（exhausted 从 false
  // 变 true），不推的话用户看到的永远是「正在自动继续」（第 8 轮审查不拦项 1）。
  {
    const f = await fixture("exhaust");
    writeFileSync(f.file, line({ type: "system", subtype: "init", session_id: f.cli }));
    chmodSync(f.file, 0o000); // 永远读不开 → 每轮都失败、永远没有进展

    let published = 0;
    const off = bus.subscribe((ev: any) => {
      if (ev.type === "task.monitors" && ev.taskId === f.taskId) published += 1;
    });
    await backfillClaudeMonitors(f.taskId);
    const after1 = published;
    // 8 档 × 60ms，留足余量
    for (let i = 0; i < 60 && monitorRecoveryOf(f.taskId)?.exhausted !== true; i += 1) await settle(50);
    const state = monitorRecoveryOf(f.taskId);
    check(state?.exhausted === true, "⑥推到上限就停下定时器", JSON.stringify(state));
    check(state?.pending === true && state.reasons.includes("scan-failed"),
      "⑥但账留着（不会谎称这个任务没用过哨兵）", JSON.stringify(state));
    check(published > after1, "⑥耗尽这件事推给了前端（exhausted 从 false 变 true）",
      `${after1} → ${published}`);

    // 下一次真实请求（用户打开面板）把预算还回去，并且真的重新推起来。
    chmodSync(f.file, 0o644);
    await backfillClaudeMonitors(f.taskId);
    check(monitorRecoveryOf(f.taskId) === null, "⑥真实请求重新推起来之后读完了、销了账",
      JSON.stringify(monitorRecoveryOf(f.taskId)));
    off();
  }

  // ── ⑦ 并发：别的任务在这一轮的 await 里把它挤掉 ──────────────────────────────────
  //
  // ④ 是「扫完一轮、再被挤掉」。真实请求不排队：两条 GET 合流到同一个回填，多个任务同时补
  // 历史时，**淘汰发生在被测任务自己这一轮的某个 await 处**（登记快照、读未决调用、枚举文件、
  // 读盘、提交，每一处都是）。那一刻会话桶可能还没建（位置是惰性接入的），于是「挤掉时把位置
  // 抠出来」抠到的是空表，已确认的位置就此消失、下一轮从零重读 —— 固定输入永远读不到末尾
  // （第 12 轮审查 F1 实测：`Promise.all` 一次 67 个任务，连续 12 轮只读到第一个窗口）。
  //
  // 契约：**在途的不在别人手里拆**（记下来，等它自己这一轮结束时让位），于是整轮都有唯一
  // 接班者——跑的时候位置在这份对象上，结束时位置进检查点表。断言盯着位置本身，不只盯
  // 「最终读到了末尾」：后者在单窗口夹具上是免费的。
  {
    const target = await fixture("inflight-evict");
    let body = line({ type: "system", subtype: "init", session_id: target.cli });
    for (let i = 0; i < 150; i += 1) body += plainBash(target.cli, i); // 远超 32 KiB → 要好几轮
    body += realMonitor(target.cli, "binf001");
    writeFileSync(target.file, body);

    // 同 ④：70 个永远读不开的任务一直处于恢复中（软上限豁免它们），压力全压到硬上限上。
    const fillers: { taskId: string; file: string }[] = [];
    for (let i = 0; i < 70; i += 1) {
      const other = await fixture(`inflight-filler${i}`);
      writeFileSync(other.file, line({ type: "system", subtype: "init", session_id: other.cli }));
      chmodSync(other.file, 0o000);
      fillers.push({ taskId: other.taskId, file: other.file });
    }
    /** **同时**开跑（不是「读完再施压」）：淘汰因此落在被测任务这一轮的 await 里。 */
    const concurrent = () => Promise.all([
      backfillClaudeMonitors(target.taskId),
      ...fillers.map((f) => backfillClaudeMonitors(f.taskId)),
    ]);
    const checkpointAt = () => {
      const cursors = [...(monitorCheckpointOf(target.taskId)?.values() ?? [])];
      return cursors.reduce((max, c) => Math.max(max, c.offset), -1);
    };

    let rounds = 0;
    let last = -1;
    for (; rounds < 12 && (await listMonitors(target.taskId)).length === 0; rounds += 1) {
      await concurrent();
      check(monitorScanTracked(target.taskId) === false,
        "⑦在途被选中淘汰的，到它自己这一轮结束时才让位（让了）", `第 ${rounds + 1} 轮`);
      const offset = checkpointAt();
      check(offset > last, "⑦位置每轮都往前（在途被挤掉也不归零）",
        `第 ${rounds + 1} 轮：${last} → ${offset}`);
      last = offset;
    }
    const rows = await listMonitors(target.taskId);
    check(rows.length === 1 && rows[0]?.nativeId === "binf001",
      "⑦并发淘汰下仍然读到末尾那个 Monitor",
      `${rounds} 轮后 ${rows.length} 条：${rows.map((r) => r.nativeId).join(",")}`);
    check(rows[0]?.status === "exited", "⑦带着来源报的终态（不是一直写着正在盯着）",
      String(rows[0]?.status));
    for (const f of fillers) chmodSync(f.file, 0o644); // 让填充任务自己销账，别一直刷
    await waitRecovered(target.taskId);
    check(monitorRecoveryOf(target.taskId) === null, "⑦并且销了账",
      JSON.stringify(monitorRecoveryOf(target.taskId)));
  }

  if (failures === 0) {
    console.log("✓ 内置 Monitor 恢复的收敛性：普通后台 Bash 不占缓冲（末尾 Monitor 读得到）/ "
      + "真乱序满缓冲时背压不丢事实且预算真在耗 / 首次归属查询失败也不丢责任（库好了自动补）/ "
      + "每轮都被硬上限挤掉也从原位继续 / 丢过游标后的重读不算进展 / "
      + "预算耗尽会留账并推给前端 / 并发在途淘汰下位置单调往前 均受回归保护");
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
