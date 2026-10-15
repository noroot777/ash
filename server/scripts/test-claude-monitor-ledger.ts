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
import { and, eq } from "drizzle-orm";
import { requireTmpDb, releaseTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "ash-ledger-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
requireTmpDb("monitor-ledger");

const [{ db, ensureSchema, dbClient }, schema, { ClaudeMonitorTrace }, { backfillClaudeMonitors, forgetTaskMonitorScan }, { listMonitors }, { inspectProcess }] =
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

  // ── ⑤b 新 run 文件**还是空的**（新回合刚建文件、还没输出）──────────────────
  // 这一刻一个新字节都没有，但「上一代已经结束」已经成立。只看「有没有读到新内容」就提交
  // 不了这个变化（第 5 轮审查实测 emptyNewRun：连续两次回填，旧行仍 running、source_pid
  // 仍是 null）。⑤ 那组的第二个文件有一行 init，所以触发不到这条。
  {
    const f = await fixture("empty-new-run", live.pid, live.startedAt);
    write(f.file("20261014T010000000Z"), startSeq(f.cli, "n-emptyrun", "上一代起的"));
    await backfillClaudeMonitors(f.taskId);
    check((await listMonitors(f.taskId)).at(0)?.status === "running", "⑤b 此刻来源还活着，是 running");
    writeFileSync(f.file("20261014T020000000Z"), "");   // 新回合建了文件，零字节
    await backfillClaudeMonitors(f.taskId);
    const row = (await listMonitors(f.taskId)).at(0);
    check(row?.status === "lost", "⑤b 空的新 run 文件也是「上一代已结束」的证据", String(row?.status));
    const raw = (await db.select().from(monitors).where(eq(monitors.nativeId, "n-emptyrun"))).at(0);
    check(raw?.sourcePid === 0, "⑤b 这个结论同样落了库", String(raw?.sourcePid));
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

  // ── ⑦ 起点是一个**区间**，宽到不能忽略时不编到期时刻 ───────────────────────
  //
  // 第 4 轮我在这里断言「起点用回执那条事件的时刻」，那个理解是错的：计时器在工具返回**前**
  // 就起了，而回执消息要等 PostToolUse hooks 跑完才构建（第 5 轮审查从 claude 2.1.283 二进制
  // 提取源码证实）。所以回执时刻只是真实起点的**上界**，tool_use 时刻是下界。
  //
  // 判据因此变成区间宽度：窄到可忽略就用上界给精确时刻，宽了就只报时长。
  {
    // (a) 延迟很大（hooks 跑了 20 分钟）：给不出到期时刻，但时长仍然说得出来。
    const wide = await fixture("anchor-wide", live.pid, live.startedAt);
    write(wide.file(), [
      { type: "system", subtype: "init", session_id: wide.cli },
      { type: "assistant", timestamp: "2026-10-14T03:00:00.000Z", message: { model: "m", content: [
        { type: "tool_use", name: "Monitor", id: "tu-wide", input: { command: "sleep 600", description: "等了很久才起来", timeout_ms: 600_000 } },
      ] } },
      { type: "system", subtype: "task_started", task_id: "n-wide", tool_use_id: "tu-wide", task_type: "local_bash", session_id: wide.cli },
      { type: "user", timestamp: "2026-10-14T03:20:00.000Z", message: { role: "user", content: [
        { type: "tool_result", tool_use_id: "tu-wide", content: "Monitor started (task n-wide, expires in 1m 30s unless the source ends first)." },
      ] } },
    ]);
    await backfillClaudeMonitors(wide.taskId);
    const w = (await listMonitors(wide.taskId)).at(0);
    check(w?.lifetime === "bounded", "⑦(a) 读到回执 → 时长已知", String(w?.lifetime));
    check(w?.timeoutMs === 90_000, "⑦(a) 时长就是回执说的 90 秒", String(w?.timeoutMs));
    check(w?.expiresAt === null,
      "⑦(a) 起点区间宽达 20 分钟 → 不编到期时刻（上一轮会按回执时刻编一个，偏晚 20 分钟）",
      String(w?.expiresAt));

    // (b) 对照：延迟是正常量级（实测真实回执与 tool_use 差 22~59ms）→ 照常给精确到期时刻。
    const tight = await fixture("anchor-tight", live.pid, live.startedAt);
    write(tight.file(), [
      { type: "system", subtype: "init", session_id: tight.cli },
      { type: "assistant", timestamp: "2026-10-14T03:00:00.000Z", message: { model: "m", content: [
        { type: "tool_use", name: "Monitor", id: "tu-tight", input: { command: "sleep 600", description: "正常启动", timeout_ms: 600_000 } },
      ] } },
      { type: "system", subtype: "task_started", task_id: "n-tight", tool_use_id: "tu-tight", task_type: "local_bash", session_id: tight.cli },
      { type: "user", timestamp: "2026-10-14T03:00:00.040Z", message: { role: "user", content: [
        { type: "tool_result", tool_use_id: "tu-tight", content: "Monitor started (task n-tight, expires in 1m 30s unless the source ends first)." },
      ] } },
    ]);
    await backfillClaudeMonitors(tight.taskId);
    const t = (await listMonitors(tight.taskId)).at(0);
    check(t?.startedAt === "2026-10-14T03:00:00.040Z", "⑦(b) 区间窄 → 起点取上界", String(t?.startedAt));
    const tspan = t?.expiresAt ? Date.parse(t.expiresAt) - Date.parse(t.startedAt) : -1;
    check(tspan === 90_000, "⑦(b) 到期时刻按 90 秒给出", `${tspan}ms`);
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
    // 这个夹具里 tool_use 在 01:00:05、回执追加在 01:05:00，起点区间宽近 5 分钟，所以补回来
    // 的是**时长**而不是到期时刻——起点不确定就不编一个（见 ⑦）。
    check(fixed?.timeoutMs === 90_000, "⑧补回来的时长就是回执说的 90 秒", String(fixed?.timeoutMs));
    check(fixed?.expiresAt === null, "⑧起点区间太宽，不给到期时刻", String(fixed?.expiresAt));
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

  // ── ⑩ 跨文件因果：前一个文件没读完，后一个文件的事实不能被丢掉 ──────────────
  //
  // 第 5 轮审查实测的那一幕：前 run 文件超过单次上限、Monitor 的 task_started 在它尾部，而后
  // run 文件里的回执和 completed 当轮就被读完并丢弃（关联不上任何 Monitor），游标还推到了尾。
  // 于是第二轮读到 started 时，那两条事实再也不会来，卡片永远停在 lost + unknown。
  //
  // 两道防线各钉一条：顺序（别制造孤儿）+ 缓冲（已产生的孤儿不丢）。
  {
    const f = await fixture("cross-file", live.pid, live.startedAt);
    const LIMIT = 50_000;
    const filler = JSON.stringify({ type: "assistant", timestamp: "2026-10-14T01:00:00.000Z",
      message: { model: "m", content: [{ type: "text", text: "x".repeat(900) }] } });
    // 前文件：一堆填充 + 尾部才是 Monitor 的 tool_use/task_started（读不到上限之外）
    writeFileSync(f.file("20261014T010000000Z"),
      Array(120).fill(filler).join("\n") + "\n"
      + startSeq(f.cli, "n-cross", "跨文件", "Monitor started (task n-cross, expires in 1m 30s unless the source ends first).")
        .slice(1).map((e) => JSON.stringify(e)).join("\n") + "\n");
    // 后文件：只有终态（回执跟 tool_use 同回合，所以放在前文件里）
    writeFileSync(f.file("20261014T020000000Z"), [
      { type: "assistant", timestamp: "2026-10-14T02:00:00.000Z", message: { model: "m", content: [{ type: "text", text: "下一回合" }] } },
      { type: "system", subtype: "task_notification", task_id: "n-cross", status: "completed", summary: "跨文件跑完了", session_id: f.cli },
    ].map((e) => JSON.stringify(e)).join("\n") + "\n");

    const scan = await import("../src/claude-monitor-scan.js");
    const st = scan.newTaskScan();
    // 第 1 轮：前文件撞上限，**后文件一个字节都不该读**（否则它的终态会变成孤儿被丢掉）。
    await scan.scanSession(st, `s-${f.taskId}`, f.cli, f.file("20261014T010000000Z"), LIMIT);
    const cursors = [...st.sessions.get(`s-${f.taskId}`)!.cursors.entries()];
    const secondCursor = cursors.find(([path]) => path.includes("20261014T020000000Z"));
    check(st.truncated, "⑩第 1 轮确实撞到了上限");
    check(!secondCursor || secondCursor[1].offset === 0,
      "⑩前文件没读完时，后文件不被抢先读掉", `后文件 offset=${secondCursor?.[1].offset}`);
    // 续读到底
    for (let i = 0; i < 12 && st.truncated; i++) {
      st.truncated = false;
      await scan.scanSession(st, `s-${f.taskId}`, f.cli, f.file("20261014T010000000Z"), LIMIT);
    }
    const found = scan.foundOf(st);
    check(found.length === 1, "⑩最终认出了那条 Monitor", `found=${found.length}`);
    check(found[0]?.status === "exited", "⑩后文件里的终态也拿到了，不是 lost", String(found[0]?.status));
    check(found[0]?.lifetime === "bounded", "⑩前文件尾部的回执也拿到了", String(found[0]?.lifetime));
  }

  // ── ⑪ 孤儿缓冲：事实先到、它的 Monitor 后到，也不能丢 ──────────────────────
  // 直接驱动扫描层：把终态写在**前面**，task_started 写在后面（模拟上一轮已被消费的情况）。
  {
    const f = await fixture("orphan", live.pid, live.startedAt);
    writeFileSync(f.file(), [
      { type: "assistant", timestamp: "2026-10-14T01:00:00.000Z", message: { model: "m", content: [{ type: "text", text: "先来的终态" }] } },
      { type: "system", subtype: "task_notification", task_id: "n-orph", status: "completed", summary: "我先到了", session_id: f.cli },
      ...startSeq(f.cli, "n-orph", "后到的 Monitor", "Monitor started (task n-orph, expires in 1m 30s unless the source ends first)."),
    ].map((e) => JSON.stringify(e)).join("\n") + "\n");
    await backfillClaudeMonitors(f.taskId);
    const row = (await listMonitors(f.taskId)).at(0);
    check(row?.status === "exited", "⑪先到的终态被缓冲住，Monitor 出现后回溯应用", String(row?.status));
  }

  // ── ⑫ 否定缓存不是永久的：此刻库里没有 ≠ 它不是 Monitor ──────────────────────
  // close 查库没命中会记一笔「不是我们的」来省掉重复查库，但那只能短期有效——回填可能还没
  // 跑到，或者上一次写库失败了。永久否定会让那条通知之后即使行出现了也永远被短路。
  {
    const f = await fixture("foreign-ttl", live.pid, live.startedAt);
    const trace = new ClaudeMonitorTrace(f.cli);
    await settle();
    // 库里还没有这一行 → 这条通知查库不命中，被记入否定缓存
    trace.event({ type: "system", subtype: "task_notification", task_id: "n-ttl", status: "completed",
      summary: "行还没出现时就来了", session_id: f.cli });
    await settle();
    check((await listMonitors(f.taskId)).length === 0, "⑫此刻确实没有这一行");
    // 行出现了（回填补的），同一条通知再来一次必须被收下
    await db.insert(monitors).values({
      id: "m-ttl", taskId: f.taskId, command: "sleep 600", description: "后来才出现", cwd: "",
      status: "running", pid: null, pidStartedAt: null, logPath: "", offset: 0, events: 0, exitCode: null,
      startedAt: now(), expiresAt: now(), endedAt: null, endedReason: null, ownerUserId: null,
      kind: "claude", nativeId: "n-ttl", cliSessionId: f.cli, sourceLifetime: "unknown",
      lifetimeEvidence: null, startEvidence: null, timeoutMs: null, sourcePid: null, sourcePidStartedAt: null,
    });
    // (a) 精确信号：行出现时生产路径（回填 / 实时 open）都会发 task.monitors。
    const { bus } = await import("../src/bus.js");
    bus.publish({ type: "task.monitors", taskId: f.taskId });
    trace.event({ type: "system", subtype: "task_notification", task_id: "n-ttl", status: "completed",
      summary: "这次该收下了", session_id: f.cli });
    await settle();
    const row = (await db.select().from(monitors).where(eq(monitors.id, "m-ttl"))).at(0);
    check(row?.status === "exited",
      "⑫(a) 投影行变化的信号让否定缓存立即作废", `${row?.status}（running = 被永久短路了）`);

    // (b) 兜底：**不发**任何信号，光靠时限也要能恢复——否则正确性就押在「每个 writer 都
    //     记得 publish」上了。
    const f2 = await fixture("foreign-fallback", live.pid, live.startedAt);
    const t2 = new ClaudeMonitorTrace(f2.cli);
    await settle();
    t2.event({ type: "system", subtype: "task_notification", task_id: "n-fb", status: "completed",
      summary: "行还没出现", session_id: f2.cli });
    await settle();
    await db.insert(monitors).values({
      id: "m-fb", taskId: f2.taskId, command: "sleep 600", description: "兜底", cwd: "",
      status: "running", pid: null, pidStartedAt: null, logPath: "", offset: 0, events: 0, exitCode: null,
      startedAt: now(), expiresAt: now(), endedAt: null, endedReason: null, ownerUserId: null,
      kind: "claude", nativeId: "n-fb", cliSessionId: f2.cli, sourceLifetime: "unknown",
      lifetimeEvidence: null, startEvidence: null, timeoutMs: null, sourcePid: null, sourcePidStartedAt: null,
    });
    await new Promise((r) => setTimeout(r, 2_100));   // 过兜底时限，不发任何 bus 信号
    t2.event({ type: "system", subtype: "task_notification", task_id: "n-fb", status: "completed",
      summary: "兜底之后该收下了", session_id: f2.cli });
    await settle();
    const row2 = (await db.select().from(monitors).where(eq(monitors.id, "m-fb"))).at(0);
    check(row2?.status === "exited",
      "⑫(b) 没有任何信号时，兜底时限也能让否定结论作废", `${row2?.status}`);
  }

  // ── ⑬ 两组更新**各用各的形状**：状态带 CAS，独立元信息不带 ──────────────────
  //
  // 状态是「先读、再写」的单调更新：读写之间隔着 await，期间另一个 writer 可能已经落了来源
  // 终态，只按 id 写会把它覆盖掉（第 5 轮审查按代码推断指出；对称的 revive/bury 一开始就带）。
  //
  // 但**独立元信息（时长、起点、会话归属、代次）跟状态无关，绝不能跟着状态一起 CAS**。上一版
  // 把它们塞进同一条带 CAS 的 UPDATE，于是「完成抢先于回执到达」之后 CAS 命中 0 行，时长也
  // 一起被丢掉，那一行永远显示「期限未知」（第 6 轮审查 casAtRace 实测）。
  //
  // **这里断言的是生成的 SQL 形状，不是并发行为**：同一个 Trace 的写操作全都串行在一条 queue
  // 上，跨 writer 的覆盖需要真正的时序竞争，点注入在当前测试里不会变红。所以这条测的是「两
  // 种形状各自还在不在」，防止任何一边被改回去；真并发下的正确性靠条件本身成立。
  // 「CAS 没命中要进恢复账本」那一条由 ⑭ 用真实竞争覆盖。
  {
    const f = await fixture("conditional-update", live.pid, live.startedAt);
    write(f.file(), [
      ...startSeq(f.cli, "n-cond", "条件更新", "Monitor started (task n-cond, expires in 1m 30s unless the source ends first)."),
      { type: "assistant", timestamp: "2026-10-14T01:00:07.000Z", message: { model: "m", content: [{ type: "text", text: "x" }] } },
      { type: "system", subtype: "task_notification", task_id: "n-cond", status: "completed", summary: "好了", session_id: f.cli },
    ]);
    // 先放一行 running 进去，这样回填走的是 mergeInto（更新）而不是插入。
    await db.insert(monitors).values({
      id: "m-cond", taskId: f.taskId, command: "sleep 600", description: "条件更新", cwd: "",
      status: "running", pid: null, pidStartedAt: null, logPath: "", offset: 0, events: 0, exitCode: null,
      startedAt: "2026-10-14T01:00:05.000Z", expiresAt: "2026-10-14T01:00:05.000Z",
      endedAt: null, endedReason: null, ownerUserId: null,
      kind: "claude", nativeId: "n-cond", cliSessionId: f.cli, sourceLifetime: "unknown",
      lifetimeEvidence: null, startEvidence: null, timeoutMs: null, sourcePid: null, sourcePidStartedAt: null,
    });

    const realUpdate = db.update.bind(db);
    const seen: string[] = [];
    (db as any).update = (table: unknown) => {
      const q = realUpdate(table as never);
      const realSet = q.set.bind(q);
      (q as any).set = (values: unknown) => {
        const w = realSet(values as never);
        const realWhere = (w as any).where.bind(w);
        (w as any).where = (cond: unknown) => {
          const built = realWhere(cond);
          try { seen.push(built.toSQL().sql); } catch { /* 拿不到 SQL 就不记 */ }
          return built;
        };
        return w;
      };
      return q;
    };
    try { await backfillClaudeMonitors(f.taskId); } finally { (db as any).update = realUpdate; }

    check((await listMonitors(f.taskId)).at(0)?.status === "exited", "⑬这一轮确实走到了更新");
    const monitorUpdates = seen.filter((sql) => /update\s+"?monitors"?/i.test(sql));
    check(monitorUpdates.length > 0, "⑬捕获到了对 monitors 的 UPDATE", `${seen.length} 条`);
    const whereOf = (sql: string) => (sql.split(/\bwhere\b/i)[1] ?? "").trim();
    // 改状态的那一条（SET 里有 status）必须带 CAS。
    const stateUpdates = monitorUpdates.filter((sql) => /"status"\s*=/.test(sql.split(/\bwhere\b/i)[0] ?? ""));
    check(stateUpdates.length > 0, "⑬这一轮里有改状态的 UPDATE", `${monitorUpdates.length} 条`);
    check(stateUpdates.every((sql) => /"status"/.test(whereOf(sql))),
      "⑬改状态的 UPDATE 在 WHERE 里带着旧状态条件，不是只按 id 写",
      stateUpdates.map((s) => whereOf(s).slice(0, 90)).join(" | "));
    // 只补元信息的那一条（SET 里没有 status）必须**不**带状态条件——否则终态行上时长补不进去。
    const metaUpdates = monitorUpdates.filter((sql) => !/"status"\s*=/.test(sql.split(/\bwhere\b/i)[0] ?? ""));
    check(metaUpdates.length > 0, "⑬这一轮里有只补元信息的 UPDATE（时长/起点/归属）", `${monitorUpdates.length} 条`);
    check(metaUpdates.every((sql) => !/"status"/.test(whereOf(sql))),
      "⑬补元信息的 UPDATE 不受状态条件约束（终态行上也要补得进去）",
      metaUpdates.map((s) => whereOf(s).slice(0, 90)).join(" | "));
  }

  // ── ⑮ 一个任务两条 CLI 会话撞同一个编号：各是各的，事实不许串过去 ──────────────
  //
  // native_id / tool_use_id 的唯一性由来源侧保证,而来源侧只承诺**在一条会话内**唯一。同一个
  // 任务上先后两条 claude 会话(续聊、接管、重试)各自编号,撞号是允许的。身份少了「哪条会话」
  // 这一维时:持久唯一索引只让其中一张卡存在,配对把乙的事实写到甲那一行,未决表里乙那条还
  // 悬着的调用被甲的同号行当成「已经成行」清掉(第 13 轮审查 N1)。
  {
    const f = await fixture("same-native", live.pid, live.startedAt);  // 会话甲
    const cliB = `${f.cli}-b`;
    const fileB = join(f.dir, `s2-${f.taskId}-20261014T020000000Z.agent-out.jsonl`);
    await db.insert(sessions).values({
      id: `s2-${f.taskId}`, taskId: f.taskId, role: "single", agentType: "claude", executor: "claude@x",
      cliSessionId: cliB, cwd: root, startedAt: now(), agentOutPath: fileB,
      agentPid: live.pid, agentStartedAt: live.startedAt,
    });
    // 甲:同号监听跑完了。外加一条**只有调用**的 tu-hang(乙那边也会用同一个号)。
    write(f.file(), [
      ...startSeq(f.cli, "n-twin", "甲的监听", "Monitor started (task n-twin, expires in 1m 30s unless the source ends first)."),
      { type: "system", subtype: "task_notification", task_id: "n-twin", status: "completed", summary: "甲跑完了", session_id: f.cli },
      { type: "assistant", timestamp: "2026-10-14T01:00:08.000Z", message: { model: "m", content: [
        { type: "tool_use", name: "Monitor", id: "tu-hang", input: { command: "sleep 1", description: "甲这条起来了", timeout_ms: 600_000 } },
      ] } },
      { type: "system", subtype: "task_started", task_id: "n-hang-a", tool_use_id: "tu-hang", task_type: "local_bash", session_id: f.cli },
    ]);
    // 乙:同一个 native_id 还在跑;同一个 tool_use_id 还悬着(没有 task_started)。
    write(fileB, [
      ...startSeq(cliB, "n-twin", "乙的监听", "Monitor started (task n-twin, expires in 1m 30s unless the source ends first)."),
      { type: "assistant", timestamp: "2026-10-14T02:00:08.000Z", message: { model: "m", content: [
        { type: "tool_use", name: "Monitor", id: "tu-hang", input: { command: "sleep 2", description: "乙这条还悬着", timeout_ms: 600_000 } },
      ] } },
    ]);
    await backfillClaudeMonitors(f.taskId);
    // **再读一轮,而且先把进程内状态抹掉**:未决表的自愈(「库里已经有同号的行了 ⇒ 这条早就
    // 配上了」)发生在每一轮开头读表的时候;进程内还缓着那条调用时,它当轮又会被写回去,误清
    // 看不出来。位置在库里,所以这一轮不会重读那几行——乙的入参真就只剩未决表这一份了。
    forgetTaskMonitorScan(f.taskId);
    await backfillClaudeMonitors(f.taskId);

    const twins = (await listMonitors(f.taskId)).filter((r) => r.nativeId === "n-twin");
    check(twins.length === 2, "⑮同号的两条监听各占一行,不是挤成一张卡",
      `${twins.length} 行:${twins.map((r) => r.description).join(" / ")}`);
    const a = twins.find((r) => r.description === "甲的监听");
    const b = twins.find((r) => r.description === "乙的监听");
    check(a?.status === "exited", "⑮甲的完成通知落在甲那一行", String(a?.status));
    check(b?.status === "running", "⑮没有把甲的终态套到乙身上", String(b?.status));
    const hanging = await db.select().from(schema.monitorPendingCalls)
      .where(and(eq(schema.monitorPendingCalls.taskId, f.taskId),
        eq(schema.monitorPendingCalls.toolUseId, "tu-hang")));
    check(hanging.length === 1 && hanging[0]?.sessionKey === `s2-${f.taskId}`,
      "⑮乙那条还悬着的调用没被甲的同号行当成「已经成行」清掉",
      JSON.stringify(hanging.map((r) => r.sessionKey)));

    // 实时那一侧同一个判据:两条流各自开同一个号,不许认成同一行(locateRow / open 的查库
    // 回退原来只按 task+native 找,接管回来的行只在库里,内存缓存挡不住它)。
    const traceA = new ClaudeMonitorTrace(f.cli);
    const traceB = new ClaudeMonitorTrace(cliB);
    await settle();
    for (const [trace, cli, tag] of [[traceA, f.cli, "甲"], [traceB, cliB, "乙"]] as const) {
      // 入参走 toolUse()（流里那条 assistant 由 claude-stream 拆开再喂进来），身份走 event()。
      trace.toolUse("Monitor", { command: "sleep 600", description: `${tag}实时`, timeout_ms: 600_000 }, `tu-rt-${tag}`);
      trace.event({ type: "system", subtype: "task_started", task_id: "n-rt", tool_use_id: `tu-rt-${tag}`,
        task_type: "local_bash", session_id: cli });
      // **等甲那一行真的落库再让乙开**：同一拍里两条都还没写进去,谁查库都查不到对方,
      // 「查库那一步问没问会话」就测不出来了(本轮自测:点注入去掉归属判断,这组仍然绿)。
      await settle();
    }
    const rt = (await listMonitors(f.taskId)).filter((r) => r.nativeId === "n-rt");
    check(rt.length === 2, "⑮实时投影也给两条会话各开一行",
      `${rt.length} 行:${rt.map((r) => r.description).join(" / ")}`);
  }

  live.kill();
  if (failures) {
    console.error(`\n${failures} 条断言未通过`);
    process.exitCode = 1;
  } else {
    console.log("✓ 内置 Monitor 账本不变量：lost 行可被重建认领 / 晚到回填也收通知 / 已有行按来源死活双向纠正"
      + " / 缓存随文件增长与新会话失效 / 代次区分（新进程 ≠ 起它的那一代，结论持久化）"
      + " / 带归属的旧期限按证据列纠正 / 起点是区间（窄→精确时刻，宽→只报时长）/ 回执前重启后从历史补回时长"
      + " / 同任务两条会话撞同号时各是各的 均受回归保护");
  }
}

try {
  await main();
} finally {
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
}
