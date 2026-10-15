// **来源身份是绑定下来的，不是落库那一刻查出来的**（新一轮第 1 轮审查 F1）。
//
// 坏法只有一个形状，出口有好几个：`sessions.agent_pid` / `agent_started_at` /
// `agent_out_path` 记的是这条会话**当下那一代**，每回合被下一轮整组覆盖；而实时投影的写库
// 排在队列上。于是「落库那一刻去问 sessions」拿到的可能是下一代人的凭据 ——
//
//   上一轮刚结束、很快继续运行同一个任务 ⇒ 旧流的 open 这时才落库 ⇒ 给上一轮的监听写上新
//   一代的 pid 和 run 文件 ⇒ 死活裁决看到「它的 run 就是最新的、它的 pid 真活着」，把早就
//   结束的旧卡续命成「正在盯着」，刷新和反复回填都不自愈。
//
// 所以这份回归钉四件事，每一件对应一个出口：
//   ① 绑定层：事件进来那一刻把来源定下来，之后会话行怎么被覆盖都不改归属（交错顺序 vs 对照）；
//   ② 流自带的来源最硬：连「构造之前会话行就已经被下一代覆盖」这种也要认流自己那一份；
//   ③ 历史纠正：库里**已经写错**的那些行，靠旧 run 文件里的事实纠回来（判据是同一次调用）；
//   ④ 收尾：一条流只收自己这一代的尾，别的代次交给代次裁决 —— 而没有 run 凭据时退回老语义。
//
// 真实进程、真实 run 文件、生产 Trace / backfill / listMonitors，不替换任何产品函数。
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { requireTmpDb, releaseTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "ash-monitor-origin-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
// 恢复账本的退避阶梯：这份测试不靠它推进，别让定时器在收尾后还在跑。
process.env.ASH_MONITOR_BACKOFF_MS = "600000,600000";
requireTmpDb("monitor-origin");

const [
  { db, ensureSchema, dbClient }, schema, { ClaudeMonitorTrace },
  { runOriginOfChild }, { backfillClaudeMonitors, forgetTaskMonitorScan }, { listMonitors },
  { inspectProcess }, { stopAllMonitorRecovery },
] = await Promise.all([
  import("../src/db/index.js"),
  import("../src/db/schema.js"),
  import("../src/claude-monitors.js"),
  import("../src/claude-monitor-origin.js"),
  import("../src/claude-monitor-backfill.js"),
  import("../src/monitors.js"),
  import("../src/proc.js"),
  import("../src/claude-monitor-recovery.js"),
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
const settle = () => new Promise((r) => setTimeout(r, 80));
const line = (value: unknown) => `${JSON.stringify(value)}\n`;

/** 一个真活着的进程 + 它真实的启动时刻（代次凭据必须两样一起比，见 proc.ts）。 */
function liveProcess(): { pid: number; startedAt: string | null; kill: () => void } {
  const child = spawn("sleep", ["120"], { stdio: "ignore" });
  const pid = child.pid!;
  return { pid, startedAt: inspectProcess(pid)?.startedAt ?? null, kill: () => child.kill("SIGTERM") };
}

let seq = 0;
/**
 * 一个任务 + 一条 claude 会话 + 两代 run 文件：旧的里面有一次正常的 Monitor 调用，新的只有
 * init（新一轮还没挂监听）—— 正是「上一轮结束后很快继续运行」那个现场。
 */
async function twoGenerations(name: string) {
  const taskId = `t-${name}-${seq += 1}`;
  const cli = `cli-${taskId}`;
  const sessionId = `s-${taskId}`;
  const dir = join(root, "runs", taskId);
  mkdirSync(dir, { recursive: true });
  const oldRun = join(dir, `${sessionId}-20261015T010000000Z.agent-out.jsonl`);
  const newRun = join(dir, `${sessionId}-20261015T020000000Z.agent-out.jsonl`);
  const call = {
    type: "assistant", session_id: cli, timestamp: "2026-10-15T01:00:00.000Z",
    message: { content: [{ type: "tool_use", name: "Monitor", id: `tu-${taskId}`, input: {
      command: "tail -F old-build.log", description: "上一轮的监听",
    } }] },
  };
  const started = {
    type: "system", subtype: "task_started", session_id: cli,
    task_id: `n-${taskId}`, tool_use_id: `tu-${taskId}`, task_type: "local_bash",
  };
  writeFileSync(oldRun, line({ type: "system", subtype: "init", session_id: cli }) + line(call) + line(started));
  writeFileSync(newRun, line({ type: "system", subtype: "init", session_id: cli }));
  await db.insert(tasks).values({
    id: taskId, projectId: "p", title: name, body: "", status: "running",
    agentType: "claude", mode: "single", createdAt: now(), updatedAt: now(),
  });
  const gen1 = liveProcess();
  const gen2 = liveProcess();
  await db.insert(sessions).values({
    id: sessionId, taskId, role: "single", agentType: "claude", executor: "claude@test",
    cliSessionId: cli, cwd: root, startedAt: now(),
    agentOutPath: oldRun, agentPid: gen1.pid, agentStartedAt: gen1.startedAt,
  });
  return {
    taskId, cli, sessionId, oldRun, newRun, gen1, gen2,
    nativeId: `n-${taskId}`, toolUseId: `tu-${taskId}`, call, started,
    /** 下一轮接着跑：会话行那三列被整组覆盖（照 orchestrator 的写法）。 */
    nextGeneration: () => db.update(sessions)
      .set({ agentOutPath: newRun, agentPid: gen2.pid, agentStartedAt: gen2.startedAt })
      .where(eq(sessions.id, sessionId)),
    rows: () => db.select().from(monitors).where(eq(monitors.taskId, taskId)),
    /** 完整历史回填几轮（配对状态每轮都丢一次，走的是最难那条路）。 */
    refill: async (rounds = 4) => {
      for (let i = 0; i < rounds; i += 1) {
        forgetTaskMonitorScan(taskId);
        await backfillClaudeMonitors(taskId);
      }
    },
    done: () => { gen1.kill(); gen2.kill(); },
  };
}

async function main(): Promise<void> {
  await db.insert(projects).values({ id: "p", name: "p", repoPath: root, createdAt: now() });

  // ── ① 绑定层：会话行在旧流记完之前就被下一轮覆盖 ────────────────────────────
  // 难的那个顺序：事件都进了投影、队列还没清完，这时下一轮把会话行整组覆盖、旧进程结束。
  // 对照组只差一件事 —— 先等旧投影自己收完尾再覆盖。两组的结论必须一样。
  for (const race of [false, true]) {
    const f = await twoGenerations(race ? "race" : "control");
    const trace = new ClaudeMonitorTrace(f.cli);
    trace.toolUse("Monitor", f.call.message.content[0]!.input, f.toolUseId);
    trace.event(f.started);
    const settled = trace.finishAll();
    if (!race) await settled;                 // 对照：先记完，再换代
    await f.nextGeneration();
    f.gen1.kill();
    await settle();
    await settled;
    const row = (await f.rows()).at(0);
    const tag = race ? "①交错" : "①对照";
    check((await f.rows()).length === 1, `${tag}：只有一行投影`, String((await f.rows()).length));
    check(row?.sourceRun === f.oldRun,
      `${tag}：行上记的是**起它的那一代** run 文件`, String(row?.sourceRun));
    check(row?.sourcePid === f.gen1.pid && row?.sourcePidStartedAt === f.gen1.startedAt,
      `${tag}：代次凭据也是那一代的进程，不是下一轮的新进程`, `${row?.sourcePid} vs ${f.gen2.pid}`);
    await f.refill();
    const card = (await listMonitors(f.taskId)).at(0);
    check(card?.status === "lost",
      `${tag}：反复回填之后仍然是「进程已不在」（新进程不给旧监听续命）`, String(card?.status));
    f.done();
  }

  // ── ② 流自带的来源最硬 ──────────────────────────────────────────────────────
  // 极端形状：会话行**在 Trace 构造之前**就已经是下一代了（接管/慢队列都可能这样）。这时
  // 只有流自己带着的那份凭据能说对话 —— 它就是这条 stdout 的那个进程和那个文件。
  {
    const f = await twoGenerations("stream-origin");
    await f.nextGeneration();
    // 生产路径就是这么取的：从 child 上读 pid 和那组落盘路径（见 runOriginOfChild）。
    const child = { pid: f.gen1.pid, ashPaths: { out: f.oldRun } };
    const origin = runOriginOfChild(child);
    check(origin.pid === f.gen1.pid && origin.runPath === f.oldRun
      && origin.pidStartedAt === f.gen1.startedAt, "②child 上就能取到完整来源身份",
      JSON.stringify(origin));
    check(runOriginOfChild({ pid: f.gen2.pid }).runPath === "",
      "②没有落盘文件的流（Windows / 常驻）只有 pid，不编一个 run 文件");
    const trace = new ClaudeMonitorTrace(f.cli, origin);
    trace.toolUse("Monitor", f.call.message.content[0]!.input, f.toolUseId);
    trace.event(f.started);
    await trace.finishAll();
    const row = (await f.rows()).at(0);
    check(row?.sourceRun === f.oldRun && row?.sourcePid === f.gen1.pid,
      "②会话行已经被下一代覆盖，照样记成流自己那一代", `${row?.sourceRun} / ${row?.sourcePid}`);
    f.gen1.kill();
    await f.refill();
    check((await listMonitors(f.taskId)).at(0)?.status === "lost",
      "②那一代进程结束后它就是「进程已不在」");
    f.done();
  }

  // ── ③ 历史纠正：库里已经写错的来源，靠旧 run 文件里的事实纠回来 ─────────────
  // 这是存量修复路径：升级前那些行记的是下一代的 run 和一个真活着的新 pid，`reconcileLiveness`
  // 因此判它「还在盯着」。旧文件里那条调用是硬证据 —— 它的 tool_use 就躺在那个文件里。
  {
    const f = await twoGenerations("repair");
    await f.nextGeneration();
    await db.insert(monitors).values({
      id: `m-${f.taskId}`, taskId: f.taskId, command: "tail -F old-build.log",
      description: "上一轮的监听", cwd: root, status: "running", pid: null, pidStartedAt: null,
      logPath: "", offset: 0, events: 0, exitCode: null, startedAt: "2026-10-15T01:00:00.100Z",
      expiresAt: "2026-10-15T01:00:00.100Z", endedAt: null, endedReason: null, ownerUserId: null,
      kind: "claude", nativeId: f.nativeId, cliSessionId: f.cli, toolUseId: f.toolUseId,
      sourceLifetime: "unknown", lifetimeEvidence: null, startEvidence: "observed",
      startAnchorWidthMs: 20, timeoutMs: null,
      // 抄错的那一代：新 run + 新进程（而且它真活着）。
      sourcePid: f.gen2.pid, sourcePidStartedAt: f.gen2.startedAt, sourceRun: f.newRun,
      startLowAt: "2026-10-15T01:00:00.000Z",
    });
    f.gen1.kill();
    await f.refill();
    const row = (await f.rows()).at(0);
    check((await f.rows()).length === 1, "③还是同一行（纠正不是再插一张卡）",
      String((await f.rows()).length));
    check(row?.sourceRun === f.oldRun, "③写错的来源被旧 run 文件的事实纠回来了", String(row?.sourceRun));
    check(row?.sourcePid === 0 && row?.sourcePidStartedAt === null,
      "③连带那一代的 pid 一起换掉（0 = 起它的那一代 run 之后又起过新的）",
      `${row?.sourcePid} / ${row?.sourcePidStartedAt}`);
    check((await listMonitors(f.taskId)).at(0)?.status === "lost",
      "③纠正之后卡片不再被新进程续命", String((await listMonitors(f.taskId)).at(0)?.status));
    f.done();
  }

  // ── ③b 反向约束：证明不了是同一次调用，就不许改写非空来源 ───────────────────
  // `native_id` 只承诺一条 CLI 会话内唯一，两代之间撞号时按会话挑中的那一行未必就是这一条。
  // 那种情况下改写归属是永久性的错；只许补空（老规矩）。
  {
    const f = await twoGenerations("no-proof");
    await f.nextGeneration();
    await db.insert(monitors).values({
      id: `m-${f.taskId}`, taskId: f.taskId, command: "tail -F other.log",
      description: "另一次调用（同号）", cwd: root, status: "running", pid: null, pidStartedAt: null,
      logPath: "", offset: 0, events: 0, exitCode: null, startedAt: "2026-10-15T02:00:00.100Z",
      expiresAt: "2026-10-15T02:00:00.100Z", endedAt: null, endedReason: null, ownerUserId: null,
      kind: "claude", nativeId: f.nativeId, cliSessionId: f.cli,
      toolUseId: `tu-another-${f.taskId}`,      // **不是**旧文件里那一次调用
      sourceLifetime: "unknown", lifetimeEvidence: null, startEvidence: "observed",
      startAnchorWidthMs: 20, timeoutMs: null,
      sourcePid: f.gen2.pid, sourcePidStartedAt: f.gen2.startedAt, sourceRun: f.newRun,
      startLowAt: "2026-10-15T02:00:00.000Z",
    });
    await f.refill();
    const row = (await f.rows()).find((r) => r.id === `m-${f.taskId}`);
    check(row?.sourceRun === f.newRun && row?.sourcePid === f.gen2.pid,
      "③b 配不上同一次调用时，非空来源一个字不动", `${row?.sourceRun} / ${row?.sourcePid}`);
    f.done();
  }

  // ── ④ 收尾只收自己这一代 ────────────────────────────────────────────────────
  // 同一条 CLI 会话跨两代（resume 后号不变）。新一代的流结束时，不许拿自己的死亡给上一代
  // 的行下结论；而**存量行**（source_run 为空）只可能是自己的，照收。
  {
    const f = await twoGenerations("finish-scope");
    await f.nextGeneration();
    const seed = async (id: string, sourceRun: string | null) => db.insert(monitors).values({
      id, taskId: f.taskId, command: "tail -F x.log", description: id, cwd: root,
      status: "running", pid: null, pidStartedAt: null, logPath: "", offset: 0, events: 0,
      exitCode: null, startedAt: now(), expiresAt: now(), endedAt: null, endedReason: null,
      ownerUserId: null, kind: "claude", nativeId: `n-${id}`, cliSessionId: f.cli,
      toolUseId: `tu-${id}`, sourceLifetime: "unknown", lifetimeEvidence: null,
      startEvidence: "observed", startAnchorWidthMs: 20, timeoutMs: null,
      sourcePid: null, sourcePidStartedAt: null, sourceRun, startLowAt: null,
    });
    await seed("m-gen1", f.oldRun);
    await seed("m-gen2", f.newRun);
    await seed("m-legacy", null);
    const gen2Stream = new ClaudeMonitorTrace(f.cli, runOriginOfChild({
      pid: f.gen2.pid, ashPaths: { out: f.newRun },
    }));
    await gen2Stream.finishAll();
    const statusOf = async (id: string) =>
      (await db.select().from(monitors).where(eq(monitors.id, id))).at(0)?.status;
    check(await statusOf("m-gen2") === "lost", "④自己这一代的收了", String(await statusOf("m-gen2")));
    check(await statusOf("m-legacy") === "lost",
      "④没有来源凭据的存量行也收了（证明不了是别人的就算我的）", String(await statusOf("m-legacy")));
    check(await statusOf("m-gen1") === "running",
      "④上一代那一行不碰（它的死活由代次裁决说）", String(await statusOf("m-gen1")));
    // 回填那一轮会按代次把上一代判死——结论一样，但凭据是对的那一个。
    await f.refill(1);
    check(await statusOf("m-gen1") === "lost",
      "④上一代由代次裁决判死（旧 run 不是最新的那个）", String(await statusOf("m-gen1")));

    f.done();
  }

  // ── ④b 根本没有 run 凭据的会话（常驻调度台 / Windows：会话行就没有落盘文件） ──
  // 那种流拿不出代次凭据，收尾只能退回老语义：整条会话一起收 —— 宁可多收，不留僵尸卡。
  {
    const f = await twoGenerations("no-run-path");
    await db.update(sessions).set({ agentOutPath: null, agentPid: null, agentStartedAt: null })
      .where(eq(sessions.id, f.sessionId));
    const seed = (id: string, sourceRun: string | null) => db.insert(monitors).values({
      id, taskId: f.taskId, command: "tail -F x.log", description: id, cwd: root,
      status: "running", pid: null, pidStartedAt: null, logPath: "", offset: 0, events: 0,
      exitCode: null, startedAt: now(), expiresAt: now(), endedAt: null, endedReason: null,
      ownerUserId: null, kind: "claude", nativeId: `n-${id}`, cliSessionId: f.cli,
      toolUseId: `tu-${id}`, sourceLifetime: "unknown", lifetimeEvidence: null,
      startEvidence: "observed", startAnchorWidthMs: 20, timeoutMs: null,
      sourcePid: null, sourcePidStartedAt: null, sourceRun, startLowAt: null,
    });
    await seed("m-nr-legacy", null);
    await seed("m-nr-file", f.oldRun);
    await new ClaudeMonitorTrace(f.cli).finishAll();
    const statusOf = async (id: string) =>
      (await db.select().from(monitors).where(eq(monitors.id, id))).at(0)?.status;
    check(await statusOf("m-nr-legacy") === "lost" && await statusOf("m-nr-file") === "lost",
      "④b 没有 run 凭据的流照老语义整条会话收尾（不留僵尸卡）",
      `${await statusOf("m-nr-legacy")} / ${await statusOf("m-nr-file")}`);
    f.done();
  }

  if (failures) {
    console.error(`\n${failures} 条断言未通过`);
    process.exitCode = 1;
  } else {
    console.log("✓ 内置 Monitor 的来源身份：事件进来那一刻绑定（会话行被下一轮覆盖也不改归属，"
      + "交错与对照同一结论）/ 流自带的凭据优先于库里当下那一行 / 已经写错的来源靠旧 run 文件"
      + "的同一次调用纠回来（配不上就一个字不动）/ 收尾只收自己这一代、存量行照收、"
      + "没有凭据时退回整条会话 均受回归保护");
  }
}

try {
  await main();
} finally {
  stopAllMonitorRecovery();
  dbClient.close();
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
}
