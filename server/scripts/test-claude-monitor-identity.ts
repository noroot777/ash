// **空归属不是通配符**（第 14 轮审查 N2）。
//
// `monitors.cli_session_id` 是后加的列，升级前写进去的行上一律为空。四个认行的地方都曾把
// 这种行当成「跟谁都相等」的兜底证据，于是 null 的含义从「不知道是谁的」变成了「就是你」。
// 后果不是显示得丑，是**毁掉另一条会话的恢复依据**：审查实测里，一条无归属的旧投影把另一条
// 会话里还悬着的同号调用销了账 —— 那条调用的入参只存在于那一行，卡再也出不来。
//
// 这份测试盯两件事：
// ① 销账要有同来源的证据，证明不了就留着未决责任（`loadPendingCalls`）；
// ② 认行同理：无归属的那一行要有**可重验的同来源证据**才认得下来（`matchBySource`，实时与
//    历史共用）。「库里只有这一行」不算证据 —— 那只说明恢复进度走到哪儿了，不说明别的会话
//    没有同号监听（第 5 轮审查 N2）。
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { requireTmpDb, releaseTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "ash-mon-identity-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
requireTmpDb("monitor-identity");

const [
  { db, ensureSchema }, schema, { loadPendingCalls }, { matchBySource }, { listMonitors },
] = await Promise.all([
  import("../src/db/index.js"),
  import("../src/db/schema.js"),
  import("../src/claude-monitor-pending.js"),
  import("../src/claude-monitor-identity.js"),
  import("../src/monitors.js"),
]);
const { monitorPendingCalls, monitors, projects, sessions, tasks } = schema;
await ensureSchema();

let failures = 0;
const check = (ok: boolean, label: string, detail = "") => {
  if (ok) return;
  failures += 1;
  console.error(`✗ ${label}${detail ? ` —— ${detail}` : ""}`);
};
const now = () => new Date().toISOString();

async function main(): Promise<void> {
  await db.insert(projects).values({ id: "p", name: "p", repoPath: root, createdAt: now() });
  mkdirSync(join(root, "runs"), { recursive: true });

  // ── ① 销账：无归属的旧投影不许把别人的未决调用带走 ─────────────────────────────
  {
    const taskId = "t-settle";
    await db.insert(tasks).values({ id: taskId, projectId: "p", title: "t", body: "", status: "running",
      agentType: "claude", mode: "single", createdAt: now(), updatedAt: now() });
    await db.insert(sessions).values({
      id: "s-b", taskId, role: "single", agentType: "claude", executor: "claude@x",
      cliSessionId: "cli-b", cwd: root, startedAt: now(),
      agentOutPath: join(root, "runs", "s-b-20261015T010000000Z.agent-out.jsonl"),
    });
    // 新会话里还悬着的调用（入参只存在于这一行）。
    await db.insert(monitorPendingCalls).values({
      taskId, sessionKey: "s-b", toolUseId: "tu-same", command: "tail -f b.log",
      description: "乙的调用", at: now(), sourceRun: null,
    });
    // 升级前写进去的旧投影：同号 tool_use，**没有归属**。
    await db.insert(monitors).values({
      id: "m-legacy", taskId, command: "tail -f a.log", description: "甲的旧投影", cwd: root,
      status: "running", pid: null, pidStartedAt: null, logPath: "", offset: 0, events: 0,
      exitCode: null, startedAt: now(), expiresAt: now(), endedAt: null, endedReason: null,
      ownerUserId: null, kind: "claude", nativeId: "bsame", cliSessionId: null,
      toolUseId: "tu-same", sourceLifetime: "unknown",
    });

    const loaded = await loadPendingCalls(taskId);
    check(loaded.get("s-b")?.length === 1,
      "①证明不了同来源 ⇒ 未决调用留着（恢复依据没被毁）",
      `${loaded.get("s-b")?.length ?? 0} 条`);
    const left = await db.select().from(monitorPendingCalls)
      .where(and(eq(monitorPendingCalls.taskId, taskId), eq(monitorPendingCalls.sessionKey, "s-b")));
    check(left.length === 1, "①库里那一行也还在（不是「读得出来但已经删了」）", `${left.length} 行`);
  }

  // ── ①(b) 对照：同来源的证据照常销账（自愈那条路不许被这次收紧弄没了）───────────
  {
    const taskId = "t-settle-same";
    await db.insert(tasks).values({ id: taskId, projectId: "p", title: "t", body: "", status: "running",
      agentType: "claude", mode: "single", createdAt: now(), updatedAt: now() });
    await db.insert(sessions).values({
      id: "s-c", taskId, role: "single", agentType: "claude", executor: "claude@x",
      cliSessionId: "cli-c", cwd: root, startedAt: now(),
      agentOutPath: join(root, "runs", "s-c-20261015T010000000Z.agent-out.jsonl"),
    });
    await db.insert(monitorPendingCalls).values({
      taskId, sessionKey: "s-c", toolUseId: "tu-done", command: "tail -f c.log",
      description: "已经成行的调用", at: now(), sourceRun: null,
    });
    await db.insert(monitors).values({
      id: "m-same", taskId, command: "tail -f c.log", description: "它自己的投影", cwd: root,
      status: "running", pid: null, pidStartedAt: null, logPath: "", offset: 0, events: 0,
      exitCode: null, startedAt: now(), expiresAt: now(), endedAt: null, endedReason: null,
      ownerUserId: null, kind: "claude", nativeId: "bdone", cliSessionId: "cli-c",
      toolUseId: "tu-done", sourceLifetime: "unknown",
    });
    const loaded = await loadPendingCalls(taskId);
    check(!loaded.get("s-c")?.length, "①(b) 同来源的证据照常销账", `${loaded.get("s-c")?.length ?? 0} 条`);
    const left = await db.select().from(monitorPendingCalls)
      .where(eq(monitorPendingCalls.taskId, taskId));
    check(left.length === 0, "①(b) 而且是就地清掉，不会越积越多", `${left.length} 行`);
  }

  // ── ② 认行：要有可重验的同来源证据（第 5 轮审查 N2）─────────────────────────
  //
  // 四个认行的地方（实时 locate、open 的重复判定、历史 pick、迟到事实）现在共用这一个判据，
  // 所以这里直接打在判据本身上。证据只有一样：**同一个 run 文件**（文件名带会话 id，一个
  // 文件只由一次进程启动写出）。「库里只有这一行」不是证据 —— 那只是恢复进度。
  {
    const runA = join(root, "runs", "s-a-20261015T000000000Z.agent-out.jsonl");
    const runB = join(root, "runs", "s-b-20261015T010000000Z.agent-out.jsonl");
    const legacy = { id: "m-legacy", cliSessionId: null, sourceRun: runA };
    const mine = { id: "m-mine", cliSessionId: "cli-b", sourceRun: runB };
    const other = { id: "m-other", cliSessionId: "cli-a", sourceRun: runA };
    const mineOf = (sourceRun: string) => ({ cliSessionId: "cli-b", sourceRun });
    check(matchBySource([mine, legacy], mineOf(runB))?.id === "m-mine", "②同来源优先");
    check(matchBySource([legacy], mineOf(runB)) === undefined,
      "②唯一候选不是证据：甲的无归属旧行不许被乙认走",
      JSON.stringify(matchBySource([legacy], mineOf(runB))));
    check(matchBySource([legacy], mineOf(runA))?.id === "m-legacy",
      "②同一个 run 文件 ⇒ 认（存量行的升级路径仍在）");
    check(matchBySource([legacy, other], mineOf(runB)) === undefined,
      "②还有别的候选时同样要证据，没有就不认",
      JSON.stringify(matchBySource([legacy, other], mineOf(runB))));
    check(matchBySource([other], mineOf(runA)) === undefined,
      "②别人的行一律不认（run 对上也不行：它的归属跟我矛盾）");
    check(matchBySource([legacy], { cliSessionId: null, sourceRun: "" }) === undefined,
      "②两边都不知道也不是证据（两个未知不等于同一个来源）");
    check(matchBySource([legacy], { cliSessionId: null, sourceRun: runA })?.id === "m-legacy",
      "②连自己是谁都不知道时，run 对得上照样认");
    check(matchBySource([], mineOf(runB)) === undefined, "②没有候选就是没有");
    // 另一条证据：**来源全集**里只有我（来自 `sessions`，不是投影库里的行数）。升级前落下的
    // 那些行连 run 都没记，这是它们唯一还能被认回来的依据（第 3 轮审查：不认 = 永远 running）。
    const old = { id: "m-old", cliSessionId: null, sourceRun: null };
    check(matchBySource([old], { ...mineOf(runB), soleSource: true })?.id === "m-old",
      "②来源全集里只有我 ⇒ 无归属的行就是我的（存量行不至于永远 running）");
    check(matchBySource([old], mineOf(runB)) === undefined,
      "②同一行，没有来源全集这个前提就不认");
    check(matchBySource([other], { ...mineOf(runB), soleSource: true }) === undefined,
      "②全集只有我也只管无归属的行，别人署名的照样不认");
  }

  // ── ②(b) 落到行为上：乙另起一行，甲那张卡一个字不动 ────────────────────────────
  //
  // 判据改在共享层，但毁掉的是两张卡，所以反例要打在库上：甲的无归属旧投影是库里**唯一**
  // 的同号候选，乙读到自己的同号监听时，不许认走它（认走 = 甲的卡被乙的终态改写、乙自己
  // 那张再也插不进来）。
  {
    const taskId = "t-claim";
    const runJia = join(root, "runs", "s-jia-20261014T000000000Z.agent-out.jsonl");
    const runYi = join(root, "runs", "s-yi-20261015T020000000Z.agent-out.jsonl");
    await db.insert(tasks).values({ id: taskId, projectId: "p", title: "t", body: "", status: "running",
      agentType: "claude", mode: "single", createdAt: now(), updatedAt: now() });
    // 两条来源都在：所以「来源全集里只有我」这条路也不成立，甲那一行谁都证明不了是自己的。
    for (const [sid, cli, out] of [["s-jia", "cli-jia", runJia], ["s-yi", "cli-yi", runYi]]) {
      await db.insert(sessions).values({
        id: sid!, taskId, role: "single", agentType: "claude", executor: "claude@x",
        cliSessionId: cli!, cwd: root, startedAt: now(), agentOutPath: out!,
      });
    }
    await db.insert(monitors).values({
      id: "m-jia", taskId, command: "tail -f jia.log", description: "甲的旧投影", cwd: root,
      status: "running", pid: null, pidStartedAt: null, logPath: "", offset: 0, events: 0,
      exitCode: null, startedAt: now(), expiresAt: now(), endedAt: null, endedReason: null,
      ownerUserId: null, kind: "claude", nativeId: "bshared", cliSessionId: null,
      toolUseId: null, sourceLifetime: "unknown", sourceRun: runJia,
    });
    const { commitRound } = await import("../src/claude-monitor-commit.js");
    const outcome = await commitRound(taskId, [{
      nativeId: "bshared", toolUseId: "tu-yi", call: { command: "tail -f yi.log", description: "乙的监听" },
      cliSessionId: "cli-yi", startedAtLow: now(), startedAtHigh: null, fileStartedAt: now(),
      endedAt: now(), lifetime: "unknown", expiresMs: null,
      status: "completed", endedReason: null, filePath: runYi, staleRun: false,
    }], [], () => {});
    check(outcome.added === 1, "②(b) 乙另起一行（没有认走甲的）", `added=${outcome.added}`);
    const jia = (await db.select().from(monitors).where(eq(monitors.id, "m-jia"))).at(0);
    check(jia?.status === "running" && jia?.cliSessionId === null && jia?.toolUseId === null,
      "②(b) 甲那张卡一个字没动",
      `${jia?.status} / ${jia?.cliSessionId} / ${jia?.toolUseId}`);
    check((await listMonitors(taskId)).length === 2, "②(b) 两张卡并存，各是各的");
  }

  // ── ④ 同一条 ash 会话的**两个历史 CLI 身份**：两张卡，不是一张 ───────────────────
  //
  // resume 之后 CLI 换号，`sessions.cli_session_id` 只留得下最新那个。上一版把所有旧 run 文件
  // 里的事实都归一到这个当前值，`found` 又只按 native_id 存 —— 于是同一条 ash 会话里 cli-old
  // 和 cli-new 各有一个同号监听时，两条合成一条：审查实测只剩旧那一张卡，描述还是旧的，
  // cli_session_id/tool_use_id/status 却全变成了新一轮的（第 6 轮审查 N2）。
  await twoHistoricalSources();

  // 收尾：库里那两条任务的卡各是各的（没被上面的判据串掉）。
  check((await listMonitors("t-settle")).length === 1, "③甲的旧投影自己那张卡还在");

  if (failures === 0) {
    console.log("✓ 内置 Monitor 的归属判据：空归属不当通配符（销账与认行都要可重验的同来源证据）"
      + " / 同来源照常销账 / 存量行按 run 文件升级 / 认不下来就另起一行"
      + " / 同一条 ash 会话换过号时两个历史来源各是各的 均受回归保护");
  }
  process.exit(failures ? 1 : 0);
}

async function twoHistoricalSources(): Promise<void> {
  const { backfillClaudeMonitors } = await import("../src/claude-monitor-backfill.js");
  const taskId = "t-history";
  const dir = join(root, "runs", taskId);
  mkdirSync(dir, { recursive: true });
  const runOf = (stamp: string) => join(dir, `sesshist-${stamp}.agent-out.jsonl`);
  const oldRun = runOf("20261014T000000000Z");
  const newRun = runOf("20261015T000000000Z");
  const ev = (o: unknown) => JSON.stringify(o) + "\n";
  const story = (cli: string, tu: string, done: boolean) =>
    ev({ type: "system", subtype: "init", session_id: cli })
    + ev({ type: "assistant", timestamp: "2026-10-14T00:00:01.000Z", message: { model: "m", content: [
      { type: "tool_use", name: "Monitor", id: tu,
        input: { command: `tail -F /tmp/${tu}`, description: `${cli} 的监听`, timeout_ms: 600_000 } },
    ] } })
    + ev({ type: "system", subtype: "task_started", task_id: "bshared", tool_use_id: tu,
      task_type: "local_bash", session_id: cli })
    + (done
      ? ev({ type: "system", subtype: "task_notification", task_id: "bshared",
        status: "completed", summary: "新这一轮跑完了", session_id: cli })
      : "");
  writeFileSync(oldRun, story("cli-old", "tu-old", false));
  writeFileSync(newRun, story("cli-new", "tu-new", true));

  await db.insert(tasks).values({ id: taskId, projectId: "p", title: "换过号", body: "", status: "running",
    agentType: "claude", mode: "single", createdAt: now(), updatedAt: now() });
  // 一条 ash 会话，两代 run 文件；库里只记得**当前**那个 cli 身份。
  await db.insert(sessions).values({
    id: "sesshist", taskId, role: "single", agentType: "claude", executor: "claude@x",
    cliSessionId: "cli-new", cwd: root, startedAt: now(), agentOutPath: newRun,
  });
  // 旧来源那张卡（升级前落下的：没有归属，但记着自己是从哪个 run 读出来的）。
  await db.insert(monitors).values({
    id: "m-old", taskId, command: "tail -F /tmp/tu-old", description: "cli-old 的监听", cwd: root,
    status: "running", pid: null, pidStartedAt: null, logPath: "", offset: 0, events: 0,
    exitCode: null, startedAt: now(), expiresAt: now(), endedAt: null, endedReason: null,
    ownerUserId: null, kind: "claude", nativeId: "bshared", cliSessionId: null,
    toolUseId: null, sourceLifetime: "unknown", sourceRun: oldRun,
  });

  await backfillClaudeMonitors(taskId);
  const rows = await db.select().from(monitors).where(eq(monitors.taskId, taskId));
  check(rows.length === 2, "④两个历史来源 ⇒ 两张卡（不是合成一张）",
    rows.map((r) => `${r.cliSessionId}/${r.toolUseId}/${r.status}`).join(" , "));
  const old = rows.find((r) => r.id === "m-old");
  check(old?.status !== "exited" && old?.toolUseId !== "tu-new",
    "④旧那张卡没有被新一轮的事实改写", `${old?.status} / ${old?.toolUseId} / ${old?.cliSessionId}`);
  check(old?.cliSessionId === "cli-old",
    "④而且它被**它自己那个 run** 认领了（归属补成 cli-old，不是当前的 cli-new）",
    String(old?.cliSessionId));
  // **每张卡的三样东西必须是同一个来源的**：归属、起它的那个 tool_use、它的描述。
  // 合成一张的那种坏法正是在这里露馅：旧卡的描述配上新一轮的 tool_use 和终态。
  const shape = rows
    .map((r) => `${r.cliSessionId}|${r.toolUseId}|${r.description}`).sort().join(" , ");
  check(shape === "cli-new|tu-new|cli-new 的监听 , cli-old|tu-old|cli-old 的监听",
    "④两张卡各自的归属/tool_use/描述都来自同一个来源（没有张冠李戴）", shape);
  check(rows.some((r) => r.cliSessionId === "cli-new" && r.status === "exited"),
    "④新来源有自己的卡，终态也在",
    rows.map((r) => `${r.cliSessionId}:${r.status}`).join(","));
}

try {
  await main();
} finally {
  releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
}
