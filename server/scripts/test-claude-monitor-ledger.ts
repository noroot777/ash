// **账本不变量**：谁说的算、什么时候可以改写、缓存什么时候失效。
//
// 这一份专钉第 4 轮审查复现出来的七条。它们有个共同形状：**「我手上没有这条事实」被当成了
// 「这条事实不成立」**，而每次换一个入口就又栽一次。前三轮的测试全绿却没挡住，原因是它们
// 只测了容易的那个顺序：
//   · lost 纠正测的是「同一个已认领 Trace 里改 DB」，漏了「新 Trace 重建认领」；
//   · 回填补旧行测的是「completed 已经在历史里」，漏了「先认领、后回填、再通知」；
//   · 缓存测的是读写失败重试，漏了「成功读完的文件还会继续长」。
// 所以这份测试的每一条都刻意走**难的那个顺序**。
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { requireTmpDb, releaseTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "ash-ledger-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
requireTmpDb("monitor-ledger");

const [{ db, ensureSchema }, schema, { ClaudeMonitorTrace }, { backfillClaudeMonitors }, { listMonitors }, { inspectProcess }] =
  await Promise.all([
    import("../src/db/index.js"),
    import("../src/db/schema.js"),
    import("../src/claude-monitors.js"),
    import("../src/claude-monitor-backfill.js"),
    import("../src/monitors.js"),
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
const settle = () => new Promise((r) => setTimeout(r, 60));

let seq = 0;
/** 建一个任务 + 一条 claude 会话。`pid` 决定这条会话"现在"有没有活进程。 */
async function fixture(name: string, pid: number | null, pidStartedAt: string | null = null) {
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
  return { taskId, cli, dir, file: (stamp = "20261014T010000000Z") => join(dir, `s-${taskId}-${stamp}.agent-out.jsonl`) };
}

/** 一段「起了一个 Monitor」的合法事件序列。 */
const startSeq = (cli: string, nativeId: string, desc: string, receipt?: string) => [
  { type: "system", subtype: "init", session_id: cli },
  { type: "assistant", timestamp: "2026-10-14T01:00:05.000Z", message: { model: "m", content: [
    { type: "tool_use", name: "Monitor", id: `tu-${nativeId}`, input: { command: "sleep 600", description: desc, timeout_ms: 600_000 } },
  ] } },
  { type: "system", subtype: "task_started", task_id: nativeId, tool_use_id: `tu-${nativeId}`, task_type: "local_bash", session_id: cli },
  ...(receipt ? [{ type: "user", timestamp: "2026-10-14T01:00:06.000Z", message: { role: "user", content: [
    { type: "tool_result", tool_use_id: `tu-${nativeId}`, content: receipt },
  ] } }] : []),
];
const write = (path: string, events: unknown[]) =>
  writeFileSync(path, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
const append = (path: string, events: unknown[]) =>
  appendFileSync(path, events.map((e) => JSON.stringify(e)).join("\n") + "\n");

/** 一个**真的活着**的进程，以及它真实的启动时刻。 */
function liveProcess(): { pid: number; startedAt: string | null; kill: () => void } {
  const child = spawn("sleep", ["600"], { stdio: "ignore" });
  const pid = child.pid!;
  return { pid, startedAt: inspectProcess(pid)?.startedAt ?? null, kill: () => child.kill("SIGTERM") };
}

async function main(): Promise<void> {
  await db.insert(projects).values({ id: "p", name: "p", repoPath: root, createdAt: now() });
  const live = liveProcess();

  // ── ① 库里已经是 lost 时，新建的 Trace 也要认回它 ───────────────────────────
  // close() 允许纠正 lost 了，但 reclaim 只认回 running 的话，通知根本到不了 close。
  {
    const f = await fixture("lost-reclaim", live.pid, live.startedAt);
    await db.insert(monitors).values({
      id: "m-lost", taskId: f.taskId, command: "sleep 600", description: "被误判的", cwd: "",
      status: "lost", pid: null, pidStartedAt: null, logPath: "", offset: 0, events: 0, exitCode: null,
      startedAt: now(), expiresAt: now(), endedAt: now(), endedReason: "推断：进程已不在",
      ownerUserId: null, kind: "claude", nativeId: "n-lost", cliSessionId: f.cli,
      sourceLifetime: "unknown", lifetimeEvidence: null, sourcePid: null, sourcePidStartedAt: null,
    });
    const trace = new ClaudeMonitorTrace(f.cli);
    await settle(); // 等认领完成——难的那个顺序正是"认领完了才来通知"
    trace.event({ type: "system", subtype: "task_notification", task_id: "n-lost", status: "completed",
      summary: "其实我跑完了", session_id: f.cli });
    await settle();
    const row = (await db.select().from(monitors).where(eq(monitors.id, "m-lost"))).at(0);
    // 这条不变量由**两条冗余路径**共同保证：reclaim 把 lost 行一起认回来（省掉查库），以及
    // 事件准入在名单未命中时查库裁决。点注入实测任断一条仍绿、两条同时断才红——所以这条
    // 断言不单独证明 reclaim 那一半，它证明的是「不管走哪条路，结论都得对」。
    check(row?.status === "exited", "①库里是 lost 的也能接到来源终态（认领/查库两条路任一条通）", String(row?.status));
  }

  // ── ② 先认领（空名单）、后回填插入、再来通知 ────────────────────────────────
  // 准入判据若是一次性内存名单，这条通知会被丢光，EOF 最后收成 lost 而不是 exited。
  {
    const f = await fixture("late-backfill", live.pid, live.startedAt);
    write(f.file(), startSeq(f.cli, "n-late", "晚到回填"));
    const trace = new ClaudeMonitorTrace(f.cli);
    await settle();                                   // 认领一个空名单
    check(await backfillClaudeMonitors(f.taskId) === 1, "②回填插了一行");
    trace.event({ type: "system", subtype: "task_notification", task_id: "n-late", status: "completed",
      summary: "回填之后才完成", session_id: f.cli });
    await settle();
    const afterNotify = (await listMonitors(f.taskId)).at(0);
    check(afterNotify?.status === "exited", "②内存名单里没有它，也要按库里的事实收下通知", String(afterNotify?.status));
    trace.finishAll();
    await settle();
    const afterEOF = (await listMonitors(f.taskId)).at(0);
    check(afterEOF?.status === "exited", "②流收尾不把来源已报的终态改成 lost", String(afterEOF?.status));
  }

  // ── ③ 已有行按来源死活**双向**纠正，与文件有没有新内容无关 ──────────────────
  {
    const alive = await fixture("merge-alive", live.pid, live.startedAt);
    await db.insert(monitors).values({
      id: "m-alive", taskId: alive.taskId, command: "sleep 600", description: "来源还活着", cwd: "",
      status: "lost", pid: null, pidStartedAt: null, logPath: "", offset: 0, events: 0, exitCode: null,
      startedAt: now(), expiresAt: now(), endedAt: now(), endedReason: "推断的", ownerUserId: null,
      kind: "claude", nativeId: "n-alive", cliSessionId: alive.cli,
      sourceLifetime: "unknown", lifetimeEvidence: null, sourcePid: null, sourcePidStartedAt: null,
    });
    await backfillClaudeMonitors(alive.taskId);
    check((await listMonitors(alive.taskId)).at(0)?.status === "running",
      "③写着 lost、来源其实还活着 → 回到 running", String((await listMonitors(alive.taskId)).at(0)?.status));

    const dead = await fixture("merge-dead", null);   // 这条会话没有活进程
    await db.insert(monitors).values({
      id: "m-dead", taskId: dead.taskId, command: "sleep 600", description: "来源已经没了", cwd: "",
      status: "running", pid: null, pidStartedAt: null, logPath: "", offset: 0, events: 0, exitCode: null,
      startedAt: now(), expiresAt: now(), endedAt: null, endedReason: null, ownerUserId: null,
      kind: "claude", nativeId: "n-dead", cliSessionId: dead.cli,
      sourceLifetime: "unknown", lifetimeEvidence: null, sourcePid: null, sourcePidStartedAt: null,
    });
    await backfillClaudeMonitors(dead.taskId);
    check((await listMonitors(dead.taskId)).at(0)?.status === "lost",
      "③写着 running、来源已经没了 → 落 lost", String((await listMonitors(dead.taskId)).at(0)?.status));
  }

  // ── ④ 缓存随文件增长失效：这些文件是活的，一直在追加 ───────────────────────
  {
    // (a) 空文件 → 之后才写进 Monitor
    const empty = await fixture("empty-then-append", live.pid, live.startedAt);
    writeFileSync(empty.file(), "");
    check(await backfillClaudeMonitors(empty.taskId) === 0, "④空文件这一轮补不出东西");
    write(empty.file(), startSeq(empty.cli, "n-empty", "空文件后追加"));
    check(await backfillClaudeMonitors(empty.taskId) === 1, "④空文件后来写了内容，下一次要读到", "仍是 0");

    // (b) 先没有会话 → 之后才新增
    const lateSession = `t-late-session-${seq++}`;
    await db.insert(tasks).values({ id: lateSession, projectId: "p", title: "后来才有会话", body: "", status: "running",
      agentType: "claude", mode: "single", createdAt: now(), updatedAt: now() });
    check(await backfillClaudeMonitors(lateSession) === 0, "④还没有会话时补不出东西");
    const dir2 = join(root, "runs", lateSession);
    mkdirSync(dir2, { recursive: true });
    const path2 = join(dir2, `s-${lateSession}-20261014T010000000Z.agent-out.jsonl`);
    write(path2, startSeq(`cli-${lateSession}`, "n-latesess", "后来才有会话"));
    await db.insert(sessions).values({
      id: `s-${lateSession}`, taskId: lateSession, role: "single", agentType: "claude", executor: "claude@x",
      cliSessionId: `cli-${lateSession}`, cwd: root, startedAt: now(), agentOutPath: path2,
      agentPid: live.pid, agentStartedAt: live.startedAt,
    });
    check(await backfillClaudeMonitors(lateSession) === 1, "④后来新增的会话要读到", "仍是 0");

    // (c) 已经扫过的文件后来追加了终态
    const growing = await fixture("growing", live.pid, live.startedAt);
    write(growing.file(), startSeq(growing.cli, "n-grow", "还会继续长"));
    check(await backfillClaudeMonitors(growing.taskId) === 1, "④先补出 running 那一行");
    check((await listMonitors(growing.taskId)).at(0)?.status === "running", "④此刻确实在盯着");
    append(growing.file(), [{ type: "system", subtype: "task_notification", task_id: "n-grow",
      status: "completed", summary: "后来才跑完", session_id: growing.cli }]);
    await backfillClaudeMonitors(growing.taskId);
    check((await listMonitors(growing.taskId)).at(0)?.status === "exited",
      "④已扫过的文件追加了终态，要读到", String((await listMonitors(growing.taskId)).at(0)?.status));
  }

  // ── ⑤ 同一条 CLI 会话的新进程，不等于起它的那一代还活着 ─────────────────────
  // sessions 的 pid 每回合被覆盖，所以「这条会话现在有活进程」是个陷阱。判据是代次：
  // 它所在的 run 文件后面还有更新的 run 文件 ⇒ 那一代必然已经退出。
  {
    const f = await fixture("generation", live.pid, live.startedAt); // 当前这代活着
    write(f.file("20261014T010000000Z"), startSeq(f.cli, "n-gen", "上一代起的"));
    write(f.file("20261014T020000000Z"), [{ type: "system", subtype: "init", session_id: f.cli }]);
    await backfillClaudeMonitors(f.taskId);
    const row = (await listMonitors(f.taskId)).at(0);
    check(row?.status === "lost", "⑤上一代 run 起的监听，不因当前有活进程被判成还在盯着", String(row?.status));
    // 结论要落库，否则下一次死活裁决又会被同一个活进程骗。
    const raw = (await db.select().from(monitors).where(eq(monitors.nativeId, "n-gen"))).at(0);
    check(raw?.sourcePid === 0, "⑤「那一代已结束」这个结论持久化了", String(raw?.sourcePid));
    await backfillClaudeMonitors(f.taskId);
    check((await listMonitors(f.taskId)).at(0)?.status === "lost", "⑤再回填一次也不会被复活");
  }

  // ── ⑥ 旧版本算法推出来的期限要被纠正，**包括带会话归属的那些** ───────────────
  // 上一版拿 cli_session_id IS NULL 当版本依据，而那一列比 source_lifetime 早两轮就有了。
  {
    const f = await fixture("legacy", live.pid, live.startedAt);
    write(f.file(), [
      ...startSeq(f.cli, "n-l90", "旧算法算的九十秒", "Monitor started (task n-l90, expires in 1m 30s unless the source ends first)."),
      ...startSeq(f.cli, "n-lforever", "旧算法算的持续监听", "Monitor started (task n-lforever, persistent — runs until TaskStop or session end)."),
    ]);
    const base = "2026-10-14T01:00:06.000Z";
    for (const [rid, nid, span] of [["m-l90", "n-l90", 60_000], ["m-lforever", "n-lforever", 300_000]] as const) {
      await db.insert(monitors).values({
        id: rid, taskId: f.taskId, command: "sleep 600", description: nid, cwd: "",
        status: "running", pid: null, pidStartedAt: null, logPath: "", offset: 0, events: 0, exitCode: null,
        startedAt: base, expiresAt: new Date(Date.parse(base) + span).toISOString(),
        endedAt: null, endedReason: null, ownerUserId: null,
        kind: "claude", nativeId: nid, cliSessionId: f.cli,   // **带归属**，旧判据抓不到
        sourceLifetime: "bounded", lifetimeEvidence: null,    // 证据为空 = 旧算法推的
        sourcePid: null, sourcePidStartedAt: null,
      });
    }
    // 先只跑迁移、**不回填**：用户没打开面板时，不可信的期限必须立刻变保守，不能继续显示
    // 一个错的时刻。（回填那条路也能纠正，两者是不同时机的保护；点注入实测只断迁移时整组
    // 仍绿，所以这一段单独钉住迁移本身。）
    await ensureSchema();
    const migratedOnly = (await db.select().from(monitors).where(eq(monitors.id, "m-l90"))).at(0);
    check(migratedOnly?.sourceLifetime === "unknown",
      "⑥迁移本身就把没有证据的 bounded 降回 unknown（哪怕它带着会话归属）", String(migratedOnly?.sourceLifetime));
    const dtoBeforeBackfill = (await listMonitors(f.taskId)).find((r) => r.nativeId === "n-l90");
    check(dtoBeforeBackfill?.expiresAt === null, "⑥降级后对外不再给那个编出来的到期时刻", String(dtoBeforeBackfill?.expiresAt));

    await backfillClaudeMonitors(f.taskId);
    const rows = await listMonitors(f.taskId);
    const r90 = rows.find((r) => r.nativeId === "n-l90");
    const rForever = rows.find((r) => r.nativeId === "n-lforever");
    const span90 = r90?.expiresAt ? Date.parse(r90.expiresAt) - Date.parse(r90.startedAt) : -1;
    check(span90 === 90_000, "⑥带归属的旧 60 秒被回执纠正成 90 秒", `${span90}ms`);
    check(rForever?.lifetime === "persistent", "⑥假的 5 分钟被纠正成持续监听", String(rForever?.lifetime));
    check(rForever?.expiresAt === null, "⑥持续监听对外不给到期时刻", String(rForever?.expiresAt));
    const raw90 = (await db.select().from(monitors).where(eq(monitors.id, "m-l90"))).at(0);
    check(raw90?.lifetimeEvidence === "receipt", "⑥纠正之后写上了证据，下次迁移不再降它", String(raw90?.lifetimeEvidence));
  }

  // ── ⑦ 起点取**起手回执**那条事件的时刻，不是 tool_use 那条 ──────────────────
  // 工具调用可能卡在权限确认上：模型发出调用和进程真正起来之间能差很久。
  {
    const f = await fixture("anchor", live.pid, live.startedAt);
    const toolUseAt = "2026-10-14T03:00:00.000Z";
    const receiptAt = "2026-10-14T03:20:00.000Z";   // 等了 20 分钟才真正起来
    write(f.file(), [
      { type: "system", subtype: "init", session_id: f.cli },
      { type: "assistant", timestamp: toolUseAt, message: { model: "m", content: [
        { type: "tool_use", name: "Monitor", id: "tu-anchor", input: { command: "sleep 600", description: "等了很久才起来", timeout_ms: 600_000 } },
      ] } },
      { type: "system", subtype: "task_started", task_id: "n-anchor", tool_use_id: "tu-anchor", task_type: "local_bash", session_id: f.cli },
      { type: "user", timestamp: receiptAt, message: { role: "user", content: [
        { type: "tool_result", tool_use_id: "tu-anchor", content: "Monitor started (task n-anchor, expires in 1m 30s unless the source ends first)." },
      ] } },
    ]);
    await backfillClaudeMonitors(f.taskId);
    const row = (await listMonitors(f.taskId)).at(0);
    check(row?.startedAt === receiptAt, "⑦起点用回执那条事件的时刻", String(row?.startedAt));
    const span = row?.expiresAt ? Date.parse(row.expiresAt) - Date.parse(row.startedAt) : -1;
    check(span === 90_000, "⑦到期时刻按回执跨度算", `${span}ms`);
    check(!!row?.expiresAt && Date.parse(row.expiresAt) > Date.parse(receiptAt),
      "⑦到期时刻不早于启动时刻（按 tool_use 算会早 20 分钟）", String(row?.expiresAt));
  }

  // ── ⑧ 回执**到达之前**就重启：期限不该永远停在未知 ────────────────────────
  // 实时路径确实补不回来（reclaim 只恢复 nativeId→rowId，不恢复 tool_use_id 的对应关系，
  // 而 tool_result 只带 tool_use_id）。报告给了两条出路：持久化那个关联，或者从可增长的历史
  // 里补录。这里走后者——④ 把缓存改成增量之后，这条路本来就通了，不必再加一列。
  {
    const f = await fixture("restart-before-receipt", live.pid, live.startedAt);
    // 实时投影落下的那一行：起来了，但回执还没消费就重启了。
    write(f.file(), startSeq(f.cli, "n-restart", "回执前重启"));
    await db.insert(monitors).values({
      id: "m-restart", taskId: f.taskId, command: "sleep 600", description: "回执前重启", cwd: "",
      status: "running", pid: null, pidStartedAt: null, logPath: "", offset: 0, events: 0, exitCode: null,
      startedAt: "2026-10-14T01:00:05.000Z", expiresAt: "2026-10-14T01:00:05.000Z",
      endedAt: null, endedReason: null, ownerUserId: null,
      kind: "claude", nativeId: "n-restart", cliSessionId: f.cli,
      sourceLifetime: "unknown", lifetimeEvidence: null, sourcePid: null, sourcePidStartedAt: null,
    });
    await backfillClaudeMonitors(f.taskId);
    check((await listMonitors(f.taskId)).at(0)?.lifetime === "unknown", "⑧回执还没出现时，期限老实说未知");
    // 重启后那条回执被写进历史文件（agent 继续跑着）。
    append(f.file(), [{ type: "user", timestamp: "2026-10-14T01:05:00.000Z", message: { role: "user", content: [
      { type: "tool_result", tool_use_id: "tu-n-restart", content: "Monitor started (task n-restart, expires in 1m 30s unless the source ends first)." },
    ] } }]);
    await backfillClaudeMonitors(f.taskId);
    const fixed = (await listMonitors(f.taskId)).at(0);
    check(fixed?.lifetime === "bounded", "⑧回执追加进历史后，期限从未知补了回来", String(fixed?.lifetime));
    const span = fixed?.expiresAt ? Date.parse(fixed.expiresAt) - Date.parse(fixed.startedAt) : -1;
    check(span === 90_000, "⑧补回来的跨度就是回执说的 90 秒", `${span}ms`);
  }

  // ── ⑨ 撞到单次读取上限之后，下一次要**接着往后读** ─────────────────────────
  // 生产上限是 128 MiB，写不进夹具，所以直接驱动扫描层并把上限压到 100 KB。
  //
  // 这一条自测时抓到一个真 bug：跳过判据原本写的是「文件大小有没有变」，而撞上限之后文件
  // 大小当然没变、游标却还停在半路，于是第 2 轮直接 continue，后半截永远读不到（offset
  // 卡在 99134/409154）。判据得是「读到文件尾了没有」。
  {
    const f = await fixture("resume-after-limit", live.pid, live.startedAt);
    const filler = JSON.stringify({ type: "assistant", timestamp: "2026-10-14T01:00:00.000Z",
      message: { model: "m", content: [{ type: "text", text: "x".repeat(900) }] } });
    // 把 Monitor 放在文件**尾部**：只读前缀的话一条都补不到。
    writeFileSync(f.file(), Array(400).fill(filler).join("\n") + "\n"
      + startSeq(f.cli, "n-tail", "藏在文件尾部").slice(1).map((e) => JSON.stringify(e)).join("\n") + "\n");

    const scan = await import("../src/claude-monitor-scan.js");
    const st = scan.newTaskScan();
    const LIMIT = 100_000;
    let rounds = 0;
    let sawTruncated = false;
    for (;;) {
      rounds += 1;
      st.truncated = false;
      await scan.scanSession(st, `s-${f.taskId}`, f.cli, f.file(), LIMIT);
      if (st.truncated) sawTruncated = true;
      if (!st.truncated || rounds > 10) break;
    }
    check(sawTruncated, "⑨这个夹具确实撞到了上限（否则这条测不到东西）");
    check(rounds > 1, "⑨分了多轮才读完", `${rounds} 轮`);
    check(scan.foundOf(st).length === 1, "⑨尾部那个 Monitor 最终读到了，不是永远只能读前缀",
      `found=${scan.foundOf(st).length}`);
  }

  live.kill();
  if (failures) {
    console.error(`\n${failures} 条断言未通过`);
    process.exitCode = 1;
  } else {
    console.log("✓ 内置 Monitor 账本不变量：lost 行可被重建认领 / 晚到回填也收通知 / 已有行按来源死活双向纠正"
      + " / 缓存随文件增长与新会话失效 / 代次区分（新进程 ≠ 起它的那一代，结论持久化）"
      + " / 带归属的旧期限按证据列纠正 / 起点取起手回执时刻 / 回执前重启后从历史补回期限 均受回归保护");
  }
}

try {
  await main();
} finally {
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
}
