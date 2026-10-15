// **不变量与恢复**：第 6 轮审查复现出来的那几条。
//
// 它们的共同形状是**「我这一半知道了」被当成了「整件事知道了」**：
//
// · 时长由回执证明过，就把那个**起点来自回执时刻**（实测晚一分钟）的到期时刻照原样放出去；
// · 时长刚补上，就把**还没算过**的占位到期列当成真值（卡片画出「开始即到期」）；
// · 看见了启动事件，就认定**此刻**就是起点（写库队列积压 2.2 秒 / 接管积压重放几分钟都照算）；
// · 发出了一条更新，就认定它**落地了**（CAS 命中 0 行、写失败、扫描没读完，三条都当成读完了）。
//
// 所以这份测试盯的是**两样证据各自齐不齐**，以及**没确认落地的事实有没有人继续推**。
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { requireTmpDb, releaseTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "ash-mon-recovery-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
requireTmpDb("monitor-recovery");

const [
  { db, ensureSchema, dbClient }, schema, { ClaudeMonitorTrace }, { backfillClaudeMonitors },
  { monitorRecoveryOf, stopAllMonitorRecovery }, { listMonitors }, { runDataMigrations }, { inspectProcess },
] = await Promise.all([
  import("../src/db/index.js"),
  import("../src/db/schema.js"),
  import("../src/claude-monitors.js"),
  import("../src/claude-monitor-backfill.js"),
  import("../src/claude-monitor-recovery.js"),
  import("../src/monitors.js"),
  import("../src/db/migrations.js"),
  import("../src/proc.js"),
]);
const { monitors, projects, sessions, tasks } = schema;
await ensureSchema();

let failures = 0;
const check = (ok: boolean, label: string, detail = "") => {
  if (ok) return;
  failures += 1;
  console.error(`✗ ${label}${detail ? ` —— ${detail}` : ""}`);
};
const now = () => new Date().toISOString();
const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));

let seq = 0;
/** 建一个任务 + 一条 claude 会话（`pid` 决定这条会话「现在」有没有活进程）。 */
async function fixture(name: string, pid: number | null = null, pidStartedAt: string | null = null) {
  const taskId = `t-${name}-${seq++}`;
  const cli = `cli-${taskId}`;
  const dir = join(root, "runs", taskId);
  mkdirSync(dir, { recursive: true });
  await db.insert(tasks).values({ id: taskId, projectId: "p", title: name, body: "", status: "running",
    agentType: "claude", mode: "single", createdAt: now(), updatedAt: now() });
  await db.insert(sessions).values({
    id: `s-${taskId}`, taskId, role: "single", agentType: "claude", executor: "claude@x",
    cliSessionId: cli, cwd: root, startedAt: now(),
    agentOutPath: join(dir, `s-${taskId}-20261014T010000000Z.agent-out.jsonl`),
    agentPid: pid, agentStartedAt: pidStartedAt,
  });
  return { taskId, cli, file: join(dir, `s-${taskId}-20261014T010000000Z.agent-out.jsonl`) };
}

/** 一行一个事件写一份 agent-out.jsonl。 */
const write = (path: string, events: unknown[]) =>
  writeFileSync(path, events.map((e) => JSON.stringify(e)).join("\n") + "\n");

/** 存量行：各列直给，模拟升级前写进去的那些。 */
const legacyRow = (over: Record<string, unknown>) => ({
  id: `row-${seq++}`, taskId: "", command: "sleep 1800", description: "存量行", cwd: "",
  status: "running", pid: null, pidStartedAt: null, logPath: "", offset: 0, events: 0, exitCode: null,
  startedAt: now(), expiresAt: now(), endedAt: null, endedReason: null, ownerUserId: null,
  kind: "claude", nativeId: null, cliSessionId: null, sourceLifetime: "unknown",
  lifetimeEvidence: null, startEvidence: null, timeoutMs: null, sourcePid: null, sourcePidStartedAt: null,
  // **默认不带误差界** —— 这就是升级前那些行的形状：起点档位可能写着 'observed'，但没有
  // 任何能重验它的东西（见 shared 的 monitorStartTrusted）。需要「可信起点」的用例显式给。
  startAnchorWidthMs: null,
  ...over,
});

/** 像 claude-stream 那样喂一次 Monitor 调用：先 event()（带来源时刻）再 toolUse()。 */
const callMonitor = (
  trace: InstanceType<typeof ClaudeMonitorTrace>, nativeId: string, at: string,
): void => {
  const input = { command: "sleep 1800", description: `盯 ${nativeId}`, timeout_ms: 1_800_000 };
  trace.event({
    type: "assistant", timestamp: at,
    message: { model: "m", content: [{ type: "tool_use", name: "Monitor", input, id: `tu-${nativeId}` }] },
  });
  trace.toolUse("Monitor", input, `tu-${nativeId}`);
};

const spanOf = (m: { startedAt: string; expiresAt: string | null } | undefined): number =>
  m?.expiresAt ? Date.parse(m.expiresAt) - Date.parse(m.startedAt) : -1;

async function main(): Promise<void> {
  await db.insert(projects).values({ id: "p", name: "p", repoPath: root, createdAt: now() });

  // ── ① 存量「时长真、起点是回执时刻」的行：回算时长，**不再放出那个晚一分钟的时刻** ──
  //
  // 旧算法把回执时刻当起点，于是 expires_at = 回执时刻 + 时长。实测回执比真实启动晚 60 秒
  // （PostToolUse hooks 跑完才构建那条消息），所以那个时刻整整错 60 秒，而旧判据凭「时长由
  // 回执证明过」就把它放出去了。现在：迁移回算 timeout_ms、start_evidence 留空 → 对外只给
  // 时长，卡片说「总共盯 90 秒（起点不确定）」。
  {
    const f = await fixture("legacy-receipt");
    const toolUseAt = "2026-10-14T14:52:01.767Z";  // 真实起点在这附近
    const receiptAt = "2026-10-14T14:53:01.767Z";  // 回执晚一分钟
    await db.insert(monitors).values(legacyRow({
      id: "row-legacy90", taskId: f.taskId, nativeId: "legacy90", cliSessionId: f.cli,
      sourceLifetime: "bounded", lifetimeEvidence: "receipt", startEvidence: null, timeoutMs: null,
      startedAt: receiptAt, expiresAt: new Date(Date.parse(receiptAt) + 90_000).toISOString(),
    }) as never);

    await runDataMigrations(dbClient as never);
    const row = (await db.select().from(monitors).where(eq(monitors.id, "row-legacy90"))).at(0);
    check(row?.timeoutMs === 90_000, "①迁移把时长回算了出来（expires_at − started_at）", String(row?.timeoutMs));
    check(row?.startEvidence === null, "①起点证据仍然是空的——回执时刻不是起点", String(row?.startEvidence));
    const dto = (await listMonitors(f.taskId)).find((m) => m.nativeId === "legacy90");
    check(dto?.expiresAt === null, "①对外不再给那个由回执时刻算出来的到期时刻", String(dto?.expiresAt));
    check(dto?.timeoutMs === 90_000, "①时长照样给（卡片改说「总共盯 90 秒（起点不确定）」）", String(dto?.timeoutMs));
    // 真实起点在 [tool_use, 回执] 之间，所以旧显示值的误差就是这个区间宽度。
    check(Math.abs(Date.parse(receiptAt) - Date.parse(toolUseAt)) === 60_000, "①（口径）旧显示值误差 60 秒");

    // **幂等**：runDataMigrations 没有版本表，每次启动都会再跑一遍。
    await runDataMigrations(dbClient as never);
    await runDataMigrations(dbClient as never);
    const again = (await db.select().from(monitors).where(eq(monitors.id, "row-legacy90"))).at(0);
    check(again?.timeoutMs === 90_000, "①反复迁移不会把回算出来的时长改坏", String(again?.timeoutMs));
  }

  // ── ①b 两样证据都在、而**存储列是个过期的占位值**：对外必须给现算的那个 ───────
  //
  // 这一条单独钉「现算」本身。上一版对外是「读 expires_at + 几个开关判断」，于是任何一条
  // 忘了同步那一列的写入路径都会把占位值漏出去（实测：期限从 unknown 升级那一刻，卡片
  // 跨度 0ms）。现在少任何一半证据就只报时长，两半都在时值由二者算出——跟那一列写成什么
  // 无关，所以这条拿一个**故意写错的**存储列来验。
  {
    const f = await fixture("computed-not-column");
    const started = "2026-10-14T12:00:00.000Z";
    await db.insert(monitors).values(legacyRow({
      id: "row-stale-col", taskId: f.taskId, nativeId: "stalecol", cliSessionId: f.cli,
      sourceLifetime: "bounded", lifetimeEvidence: "receipt", startEvidence: "observed",
      startAnchorWidthMs: 40, // 实时锚点，误差 40ms（真实量级 22~59ms）→ 起点可信
      timeoutMs: 90_000, startedAt: started, expiresAt: started, // ← 占位值没被同步
    }) as never);
    const dto = (await listMonitors(f.taskId)).find((m) => m.nativeId === "stalecol");
    check(spanOf(dto) === 90_000, "①b对外给的是「起点 + 时长」现算的值，不是那一列里的占位值",
      `${spanOf(dto)}ms`);
  }

  // ── ② 存量 ash 行：改成现算之后期限不能凭空消失 ─────────────────────────────
  //
  // ash 自己的哨兵起点和时长本来都确定，但升级前的行只有 expires_at 没有 timeout_ms。
  // 迁移不覆盖它的话，对外那个现算的到期时刻会变成 null —— 纯倒退。
  {
    const f = await fixture("legacy-ash");
    const started = "2026-10-14T10:00:00.000Z";
    await db.insert(monitors).values(legacyRow({
      id: "row-legacy-ash", taskId: f.taskId, kind: "ash", nativeId: null,
      sourceLifetime: "bounded", lifetimeEvidence: "self", startEvidence: "observed", timeoutMs: null,
      startedAt: started, expiresAt: new Date(Date.parse(started) + 300_000).toISOString(),
    }) as never);
    // 走**完整升级路径**（DDL 的 post-ALTER 补误差界 0 + 数据迁移回算时长），不是只跑迁移：
    // ash 行那两样证据分别由两段补齐，少任何一段这一行都会丢掉期限。
    await ensureSchema();
    const dto = (await listMonitors(f.taskId)).find((m) => m.id === "row-legacy-ash");
    check(dto?.timeoutMs === 300_000, "②ash 存量行的时长被回算出来", String(dto?.timeoutMs));
    check(spanOf(dto) === 300_000, "②它的期限没有因为改成现算而消失", `${spanOf(dto)}ms`);
  }

  // ── ③ 回执晚到、区间很宽，但这一行**已经有可信起点** ───────────────────────
  //
  // 回执前重启 → 实时那半只落了「起点 = 看着它开始的那一刻」（observed）、期限未知。重启后
  // 回执由历史回填读到，而它的区间宽到 60 秒（宽窗口）→ 锚点不可用。上一版就此只补时长、
  // 把占位到期列留在原地，于是卡片跨度 0ms（「开始即到期」）。正确做法：**用这一行自己那个
  // 可信起点**算出真期限。
  {
    const f = await fixture("pending-receipt");
    const observed = "2026-10-14T14:55:34.745Z";
    await db.insert(monitors).values(legacyRow({
      id: "row-pending90", taskId: f.taskId, nativeId: "pending90", cliSessionId: f.cli,
      description: "回执前重启", sourceLifetime: "unknown", lifetimeEvidence: null,
      // 实时投影写下的锚点 + 误差界（新代码一律两样一起写）。
      startEvidence: "observed", startAnchorWidthMs: 5,
      timeoutMs: null, startedAt: observed, expiresAt: observed,
    }) as never);
    // 历史里：起手事件 + 一分钟后才到的回执（区间 60 秒 ≫ 容差）。
    write(f.file, [
      { type: "system", subtype: "init", session_id: f.cli },
      { type: "assistant", timestamp: "2026-10-14T14:55:34.740Z", message: { model: "m", content: [
        { type: "tool_use", name: "Monitor", id: "tu-pending90", input: { command: "sleep 1800", description: "回执前重启", timeout_ms: 1_800_000 } },
      ] } },
      { type: "system", subtype: "task_started", task_id: "pending90", tool_use_id: "tu-pending90", task_type: "local_bash", session_id: f.cli },
      { type: "user", timestamp: "2026-10-14T14:56:34.740Z", message: { role: "user", content: [
        { type: "tool_result", tool_use_id: "tu-pending90", content: "Monitor started (task pending90, expires in 1m 30s unless the source ends first)." },
      ] } },
    ]);
    await backfillClaudeMonitors(f.taskId);
    const dto = (await listMonitors(f.taskId)).find((m) => m.nativeId === "pending90");
    check(dto?.timeoutMs === 90_000, "③时长由回执补上了", String(dto?.timeoutMs));
    check(dto?.startedAt === observed, "③起点仍是实时观察到的那一刻（不被宽区间的回执时刻顶掉）", String(dto?.startedAt));
    check(spanOf(dto) === 90_000, "③期限由「已有的可信起点 + 新补的时长」算出来，不是开始即到期", `${spanOf(dto)}ms`);
    // 库里那一列也要跟着对上。它已经不是对外契约（对外现算，见 ①b），但留着一个过期的
    // 占位值会让排查时对不上账，而且下一个读列的人就会再栽一次——所以 merge 也得把
    // 「本行自己已有的可信起点」算进去，而不是只认这一轮扫出来的锚点。
    const stored = (await db.select().from(monitors).where(eq(monitors.id, "row-pending90"))).at(0);
    check(stored?.expiresAt === new Date(Date.parse(observed) + 90_000).toISOString(),
      "③存储列同步成了真到期时刻，不留过期占位值", String(stored?.expiresAt));
  }

  // ── ④ 写库队列积压：起点取**事件到达那一刻**，不是落库那一刻 ────────────────
  {
    const f = await fixture("live-queue-delay");
    const trace = new ClaudeMonitorTrace(f.cli);
    // 在 open() 落库之前插一个 2.2 秒的慢活。注入点选**底层 client 的 execute**：drizzle 的
    // 查询构造器只有走到 `.where()` 之后才是 thenable，拦 `db.select` 那一层包不住（第一版
    // 就是这么写的，结果 `q.then` 是 undefined，抛了个 TypeError 被 queue 的重试吞掉——注入
    // 没生效、断言却是绿的，等于白给）。
    // 等价于「前面那一批写库很慢」或「接管时还在消费积压的流」。
    const realExecute = dbClient.execute.bind(dbClient);
    let held = false;
    (dbClient as any).execute = async (stmt: any) => {
      const sql = typeof stmt === "string" ? stmt : String(stmt?.sql ?? "");
      if (!held && /from\s+"?sessions"?/i.test(sql)) {
        held = true;
        await new Promise((r) => setTimeout(r, 2_200));
      }
      return realExecute(stmt);
    };
    const arrival = Date.now();
    callMonitor(trace, "live-delay", new Date(arrival - 5).toISOString());
    trace.event({ type: "system", subtype: "task_started", task_id: "live-delay",
      tool_use_id: "tu-live-delay", task_type: "local_bash", session_id: f.cli });
    await settle(2_600);
    (dbClient as any).execute = realExecute;
    check(held, "④注入真的生效了（慢查询被拦到了）");

    const row = (await db.select().from(monitors).where(eq(monitors.nativeId, "live-delay"))).at(0);
    const drift = row ? Math.abs(Date.parse(row.startedAt) - arrival) : -1;
    check(drift >= 0 && drift < 1_000, "④起点是事件到达那一刻，不含写库队列的积压", `${drift}ms`);
    check(row?.startEvidence === "observed", "④区间很窄 → 起点算有依据", String(row?.startEvidence));

    // 回执到了：期限 = 那个起点 + 来源说的时长。
    trace.toolResult("tu-live-delay", "Monitor started (task live-delay, expires in 1m 30s unless the source ends first).");
    await settle(120);
    const dto = (await listMonitors(f.taskId)).find((m) => m.nativeId === "live-delay");
    check(spanOf(dto) === 90_000, "④期限由这个起点算出来", `${spanOf(dto)}ms`);
  }

  // ── ⑤ 接管回来的积压重放：来源时刻很旧 → 不许自称「亲眼看着它开始的」 ────────
  //
  // 真实接管是从文件已消费位置之后接着读的（executors/detached.ts），积压的事件会一口气
  // 涌进来。那一刻的 Date.now() 跟真实起点差几分钟，所以**只报时长，不编时刻**。
  {
    const f = await fixture("attach-backlog");
    const trace = new ClaudeMonitorTrace(f.cli);
    callMonitor(trace, "backlog1", new Date(Date.now() - 7 * 60_000).toISOString());
    trace.event({ type: "system", subtype: "task_started", task_id: "backlog1",
      tool_use_id: "tu-backlog1", task_type: "local_bash", session_id: f.cli });
    await settle(120);
    const row = (await db.select().from(monitors).where(eq(monitors.nativeId, "backlog1"))).at(0);
    // 档位照实记（它确实是「看着事件到达」取的），**可信与否由误差界说话**：积压了 7 分钟，
    // 宽度远超容差。写入侧不替读取方下结论，判定在读的时候算（容差随时长放宽）。
    check((row?.startAnchorWidthMs ?? 0) > 60_000,
      "⑤积压重放：误差界如实记下了那几分钟", String(row?.startAnchorWidthMs));
    trace.toolResult("tu-backlog1", "Monitor started (task backlog1, expires in 30m unless the source ends first).");
    await settle(120);
    const dto = (await listMonitors(f.taskId)).find((m) => m.nativeId === "backlog1");
    check(dto?.timeoutMs === 1_800_000, "⑤时长照样记（来源说得很明确）", String(dto?.timeoutMs));
    check(dto?.expiresAt === null, "⑤但不给精确到期时刻", String(dto?.expiresAt));
  }

  // ── ⑥ 完成抢先于回执到达：时长照样补得上 ───────────────────────────────────
  //
  // 命令瞬间结束时 task_notification 会跑在 tool_result 前面。上一版 applyReceipt 上有一道
  // 状态闸、WHERE 里又按状态过滤了一遍，于是终态行上时长永远补不进去，卡片永远「期限未知」。
  // 时长是跟状态无关的元信息。
  {
    const f = await fixture("receipt-after-终态");
    const trace = new ClaudeMonitorTrace(f.cli);
    callMonitor(trace, "cas90", new Date().toISOString());
    trace.event({ type: "system", subtype: "task_started", task_id: "cas90",
      tool_use_id: "tu-cas90", task_type: "local_bash", session_id: f.cli });
    await settle(120);
    trace.event({ type: "system", subtype: "task_notification", task_id: "cas90",
      status: "completed", summary: "条件一上来就满足了", session_id: f.cli });
    await settle(120);
    const mid = (await db.select().from(monitors).where(eq(monitors.nativeId, "cas90"))).at(0);
    check(mid?.status === "exited", "⑥完成先到，落了来源终态", String(mid?.status));
    trace.toolResult("tu-cas90", "Monitor started (task cas90, expires in 1m 30s unless the source ends first).");
    await settle(120);
    const dto = (await listMonitors(f.taskId)).find((m) => m.nativeId === "cas90");
    check(dto?.lifetime === "bounded", "⑥终态行上期限照样从未知升级成有限期", String(dto?.lifetime));
    check(dto?.timeoutMs === 90_000, "⑥时长补上了（它跟状态无关）", String(dto?.timeoutMs));
    check(dto?.status === "exited", "⑥而来源终态没有被回执翻过去", String(dto?.status));
  }

  // ── ⑦ 没确认落地的事实：对外看得见，而且**自己会继续往下推** ────────────────
  //
  // 一次写失败之后，上一版只留一句「历史回填会再补」，而历史回填只在用户打开面板时才跑。
  // 现在进恢复账本：面板据此区分「还没读完」和「确实没有」，退避定时器自己把它推完。
  {
    const f = await fixture("recovery-drive");
    write(f.file, [
      { type: "system", subtype: "init", session_id: f.cli },
      { type: "assistant", timestamp: "2026-10-14T01:00:05.000Z", message: { model: "m", content: [
        { type: "tool_use", name: "Monitor", id: "tu-rec1", input: { command: "tail -F /tmp/r", description: "要恢复的", timeout_ms: 600_000 } },
      ] } },
      { type: "system", subtype: "task_started", task_id: "rec1", tool_use_id: "tu-rec1", task_type: "local_bash", session_id: f.cli },
    ]);

    const realInsert = db.insert.bind(db);
    let boom = 1;
    (db as any).insert = (table: unknown) => {
      if (boom > 0 && (table as any) === monitors) {
        boom -= 1;
        // 同步抛：这条插入现在交给 `db.batch` 执行（落库资格与它同批），造语句这一步抛
        // 出来才算「这次写没发生」。
        return { values: () => { throw new Error("INJECTED_SQLITE_BUSY"); } };
      }
      return (realInsert as any)(table);
    };
    try {
      await backfillClaudeMonitors(f.taskId);
    } finally {
      (db as any).insert = realInsert;
    }
    check((await listMonitors(f.taskId)).length === 0, "⑦写失败时这一行确实没落库");
    const pending = monitorRecoveryOf(f.taskId);
    check(pending?.pending === true, "⑦「观察到了、没确认落地」这件事对外看得见（面板据此不说「没有哨兵」）",
      JSON.stringify(pending));
    check(pending?.reasons.includes("write-failed") === true, "⑦而且说得出是哪一类", JSON.stringify(pending?.reasons));

    // **不碰它**：第一档退避 1 秒，自己推。
    for (let i = 0; i < 40 && monitorRecoveryOf(f.taskId); i += 1) await settle(100);
    check(monitorRecoveryOf(f.taskId) === null, "⑦没人再碰它，账自己销了（不以「用户再开一次」为前提）",
      JSON.stringify(monitorRecoveryOf(f.taskId)));
    const rows = await listMonitors(f.taskId);
    check(rows.length === 1 && rows[0]?.nativeId === "rec1", "⑦那条事实被自动续推补回来了",
      `${rows.length} 条：${rows.map((r) => r.nativeId).join(",")}`);
  }

  // ── ⑧ 条件更新**真的没命中**（CAS miss）：不许当成已提交 ────────────────────
  //
  // 来源终态只发一次。读到写之间隔着 await，期间另一个 writer 把状态改成了别的——这一发
  // 更新就落空了。上一版把落空当成「写成功了」，于是那条事实永久消失（实测 casAtRace）。
  // 这里用底层 client 把那次交错**做成确定的**：拦到 close 发出的那条 UPDATE，先把行改成
  // 一个不在 CAS 允许集合里的状态，再让它执行 → 必然 0 行。
  {
    const f = await fixture("cas-miss");
    const trace = new ClaudeMonitorTrace(f.cli);
    callMonitor(trace, "miss1", new Date().toISOString());
    trace.event({ type: "system", subtype: "task_started", task_id: "miss1",
      tool_use_id: "tu-miss1", task_type: "local_bash", session_id: f.cli });
    await settle(150);
    const rowId = (await db.select().from(monitors).where(eq(monitors.nativeId, "miss1"))).at(0)?.id;
    check(!!rowId, "⑧先有一行在盯着");

    const realExecute = dbClient.execute.bind(dbClient);
    let raced = false;
    (dbClient as any).execute = async (stmt: any) => {
      const sql = typeof stmt === "string" ? stmt : String(stmt?.sql ?? "");
      if (!raced && /update\s+"?monitors"?/i.test(sql) && /"status"\s*=\s*\?/.test(sql) && /where/i.test(sql)) {
        raced = true;
        // 另一个 writer 抢先把它改成了 stopped（不在 close 的 CAS 允许集合里）。
        await realExecute({ sql: `UPDATE monitors SET status='stopped' WHERE id=?`, args: [rowId!] } as never);
      }
      return realExecute(stmt);
    };
    trace.event({ type: "system", subtype: "task_notification", task_id: "miss1",
      status: "completed", summary: "来源说它跑完了", session_id: f.cli });
    await settle(200);
    (dbClient as any).execute = realExecute;
    check(raced, "⑧交错真的被做出来了");

    const row = (await db.select().from(monitors).where(eq(monitors.nativeId, "miss1"))).at(0);
    check(row?.status === "stopped", "⑧那一发更新确实没落到行上", String(row?.status));
    const pending = monitorRecoveryOf(f.taskId);
    check(pending?.reasons.includes("update-missed") === true,
      "⑧落空的更新进了恢复账本，不当成已提交", JSON.stringify(pending));
  }

  // ── ⑨ 回填那一侧的 CAS miss：记了账**不许**被同一轮的「销账」当场抹掉 ──────────
  //
  // 销账的条件是「这一轮什么都没剩下」。只问「读到 EOF 了吗」的话，刚记下的 miss 会被
  // 下一行当场销掉——我自己第一版就是这么写的，⑧ 走的是实时那条路，盖不住这一条。
  {
    const f = await fixture("merge-cas-miss");
    write(f.file, [
      { type: "system", subtype: "init", session_id: f.cli },
      { type: "assistant", timestamp: "2026-10-14T01:00:05.000Z", message: { model: "m", content: [
        { type: "tool_use", name: "Monitor", id: "tu-mm1", input: { command: "tail -F /tmp/m", description: "回填里落空", timeout_ms: 600_000 } },
      ] } },
      { type: "system", subtype: "task_started", task_id: "mm1", tool_use_id: "tu-mm1", task_type: "local_bash", session_id: f.cli },
      { type: "system", subtype: "task_notification", task_id: "mm1", status: "completed", summary: "跑完了", session_id: f.cli },
    ]);
    // 先放一行 running 进去 → 回填走 mergeInto（更新）而不是插入。
    await db.insert(monitors).values(legacyRow({
      id: "row-mm1", taskId: f.taskId, nativeId: "mm1", cliSessionId: f.cli, description: "回填里落空",
      status: "running",
    }) as never);

    const realExecute = dbClient.execute.bind(dbClient);
    let raced = false;
    (dbClient as any).execute = async (stmt: any) => {
      const sql = typeof stmt === "string" ? stmt : String(stmt?.sql ?? "");
      if (!raced && /update\s+"?monitors"?/i.test(sql) && /"status"\s*=\s*\?/.test(sql) && /where/i.test(sql)) {
        raced = true;
        await realExecute({ sql: `UPDATE monitors SET status='stopped' WHERE id=?`, args: ["row-mm1"] } as never);
      }
      return realExecute(stmt);
    };
    try {
      await backfillClaudeMonitors(f.taskId);
    } finally {
      (dbClient as any).execute = realExecute;
    }
    check(raced, "⑨交错真的被做出来了");
    const pending = monitorRecoveryOf(f.taskId);
    check(pending?.reasons.includes("update-missed") === true,
      "⑨回填里落空的更新留在账上（没被同一轮的销账抹掉）", JSON.stringify(pending));
  }

  if (failures === 0) {
    console.log("✓ 内置 Monitor 的两样证据与恢复：存量回执行降级 / ash 存量行不倒退 / "
      + "已有可信起点 + 晚到时长 / 队列积压不污染起点 / 接管重放只报时长 / 终态行上照样补时长 / "
      + "没落地的事实自动续推 / 落空的条件更新不算已提交（实时与回填两侧）均受回归保护");
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
