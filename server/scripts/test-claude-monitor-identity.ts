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

/** 一条 claude 投影行（只有身份那几列有讲究，其余是占位）。 */
const projectionOf = (
  id: string, taskId: string, toolUseId: string, cli: string | null, sourceRun: string | null,
) => ({
  id, taskId, command: "tail -f c.log", description: "它自己的投影", cwd: root,
  status: "running", pid: null, pidStartedAt: null, logPath: "", offset: 0, events: 0,
  exitCode: null, startedAt: now(), expiresAt: now(), endedAt: null, endedReason: null,
  ownerUserId: null, kind: "claude", nativeId: `b${toolUseId}`, cliSessionId: cli,
  toolUseId, sourceLifetime: "unknown", sourceRun,
});

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
    // 新会话里还悬着的调用（入参只存在于这一行），记着自己是从哪个 run 读出来的。
    await db.insert(monitorPendingCalls).values({
      taskId, sessionKey: "s-b", toolUseId: "tu-same", command: "tail -f b.log",
      description: "乙的调用", at: now(), cliSessionId: "cli-b",
      sourceRun: join(root, "runs", "s-b-20261015T010000000Z.agent-out.jsonl"),
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
    const runC = join(root, "runs", "s-c-20261015T010000000Z.agent-out.jsonl");
    // 三条都该销掉,各走一条正向路:归属对得上(跨 run 也算,同一条 CLI 会话里号不重复)、
    // 两边都不知道归属但**同一个 run 文件**、以及我这条不知道归属、库里那行知道。
    await db.insert(monitorPendingCalls).values([
      { taskId, sessionKey: "s-c", toolUseId: "tu-done", command: "tail -f c.log",
        description: "已经成行的调用", at: now(), cliSessionId: "cli-c", sourceRun: runC },
      { taskId, sessionKey: "s-c", toolUseId: "tu-run", command: "tail -f run.log",
        description: "归属不明、但 run 对得上", at: now(), cliSessionId: null, sourceRun: runC },
      { taskId, sessionKey: "s-c", toolUseId: "tu-half", command: "tail -f half.log",
        description: "我不知道归属、库里那行知道", at: now(), cliSessionId: null, sourceRun: runC },
    ]);
    await db.insert(monitors).values([
      // 归属一样、run 是后一个文件（回执/终态落在下一个 run 里的那种形状）。
      projectionOf("m-same", taskId, "tu-done", "cli-c",
        join(root, "runs", "s-c-20261016T010000000Z.agent-out.jsonl")),
      projectionOf("m-run", taskId, "tu-run", null, runC),
      projectionOf("m-half", taskId, "tu-half", "cli-c", runC),
    ]);
    const loaded = await loadPendingCalls(taskId);
    check(!loaded.get("s-c")?.length, "①(b) 同来源的证据照常销账（三条正向路都通）",
      JSON.stringify(loaded.get("s-c")?.map((c) => c.toolUseId) ?? []));
    const left = await db.select().from(monitorPendingCalls)
      .where(eq(monitorPendingCalls.taskId, taskId));
    check(left.length === 0, "①(b) 而且是就地清掉，不会越积越多", `${left.length} 行`);
  }

  // ── ①(c) 旧 pending 属于**历史 run**、当前 session 已经换号 ─────────────────────
  //
  // 销账原先拿**当前** `sessions.cli_session_id` 反推旧调用的归属：resume 之后它是新号，于是
  // 旧 run 里那条调用被认成「新一轮的」，被新一轮同号那一行销了账 —— 而那一行是它入参的唯一
  // 出处（新一轮第 1 轮审查 F1）。
  {
    const taskId = "t-settle-resumed";
    const oldRun = join(root, "runs", "s-r-20261014T010000000Z.agent-out.jsonl");
    const newRun = join(root, "runs", "s-r-20261015T010000000Z.agent-out.jsonl");
    await db.insert(tasks).values({ id: taskId, projectId: "p", title: "t", body: "", status: "running",
      agentType: "claude", mode: "single", createdAt: now(), updatedAt: now() });
    await db.insert(sessions).values({
      id: "s-r", taskId, role: "single", agentType: "claude", executor: "claude@x",
      cliSessionId: "cli-new", cwd: root, startedAt: now(), agentOutPath: newRun,
    });
    await db.insert(monitorPendingCalls).values([
      // 旧一轮那条还悬着的调用（来源明确是旧号）。
      { taskId, sessionKey: "s-r", toolUseId: "tu-twin", command: "printf old",
        description: "旧一轮的调用", at: now(), cliSessionId: "cli-old", sourceRun: oldRun },
      // 同一个号、同一条 ash 会话，两边来源都**未知**，只有 run 文件不同。
      { taskId, sessionKey: "s-r", toolUseId: "tu-blind", command: "printf blind",
        description: "来源未知的旧调用", at: now(), cliSessionId: null, sourceRun: oldRun },
    ]);
    await db.insert(monitors).values([
      projectionOf("m-twin", taskId, "tu-twin", "cli-new", newRun),
      projectionOf("m-blind", taskId, "tu-blind", null, newRun),
    ]);
    const loaded = await loadPendingCalls(taskId);
    check(loaded.get("s-r")?.length === 2,
      "①(c) 换号之后旧 run 的那条调用不许被新一轮的同号行销掉（两个未知也不算同源）",
      JSON.stringify(loaded.get("s-r")?.map((c) => c.toolUseId) ?? []));
    const left = await db.select().from(monitorPendingCalls)
      .where(eq(monitorPendingCalls.taskId, taskId));
    check(left.length === 2, "①(c) 库里那两行也都还在", `${left.length} 行`);
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
  // 三遍：后续记录**每条都带**来源；**只有 init 带**（来源侧的兼容形状，第 7 轮审查 N2）；
  // 以及「只有 init 带 + 分几轮才读完、每轮之间内存状态全丢」——那时 init 行早就读过去了，
  // 来源只剩游标上那一份。
  await twoHistoricalSources(true);
  await twoHistoricalSources(false);
  await twoHistoricalSources(false, 300);
  // 再两遍：来源**一次都没报**，以及只有最后那条通知才报（第 8 轮审查 N2）。
  await unknownSourcesEachGetACard(false);
  await unknownSourcesEachGetACard(true);
  // ⑥ 未决调用那条链的同一个判据（新一轮第 1 轮审查 F1）：读取窗口正好切在 `tool_use` 和
  // `task_started` 之间，入参于是只剩未决表那一份；下一轮的同号调用不许把它销掉。
  // 三组只差一处：号不撞（对照）/ 号撞、两边来源各自明确 / 号撞、两边来源都未知。
  await pendingSurvivesNextRound("control", "old-cli", "new-cli", false);
  await pendingSurvivesNextRound("changed-session", "old-cli", "new-cli", true);
  await pendingSurvivesNextRound("unknown-sources", null, null, true);
  // ⑥(b) 内存那一侧的同一维：一轮里就读到两个 run 的同号调用，后一个不许覆盖前一个。
  await pendingKeepsBothRunsInOneRound();
  // 存量那一侧（旧代确认过位置的那些任务）归 test-claude-monitor-upgrade.ts —— 判据不在
  // 「认哪一行」这一层，而在「一份旧位置凭什么可以接着用」（第 10 轮审查 F1）。

  // 收尾：库里那两条任务的卡各是各的（没被上面的判据串掉）。
  check((await listMonitors("t-settle")).length === 1, "③甲的旧投影自己那张卡还在");

  if (failures === 0) {
    console.log("✓ 内置 Monitor 的归属判据：空归属不当通配符（销账与认行都要可重验的同来源证据）"
      + " / 同来源照常销账 / 存量行按 run 文件升级 / 认不下来就另起一行"
      + " / 同一条 ash 会话换过号时两个历史来源各是各的（只有 init 行带来源、"
      + "甚至分几轮才读完也一样）"
      + " / 来源一次都没报时两个 run 文件也各有各的卡（持久身份按 run 分）"
      + " / 未决调用按 (会话,来源,号) 分区：窗口切在入参和身份之间时，"
      + "下一轮的同号调用销不掉上一轮那条（换过号、两边来源都未知都一样）"
      + " 均受回归保护");
  }
  process.exit(failures ? 1 : 0);
}

/**
 * 读取窗口切在 `tool_use` 和 `task_started` 之间时，**这一轮的同号调用不许销掉上一轮那条**。
 *
 * 形状（和新一轮第 1 轮审查的反例同一个）：一条 ash 会话两个 run 文件，旧文件里那条 Monitor
 * 调用的入参落在窗口里、`task_started` 落在窗口外；库里已经有新一轮正常成行的那张卡，它和
 * 旧调用用的是**同一个 tool_use 号**（来源侧只承诺号在一条 CLI 会话内唯一）。
 *
 * 坏法：销账拿当前 `sessions.cli_session_id` 反推旧调用的归属、把两个「来源未知」当成同源，
 * 于是旧调用被新一轮那一行销了账。它的入参只存在于被销掉的那一行（窗口已经越过 `tool_use`，
 * 不会再读到），所以旧那张卡永久缺失 —— 而读取位置照常被确认成「读完了」。
 *
 * 每组之间只差 `collide`/来源明不明；`collide=false` 是对照组（号不撞，怎么判都该两张卡）。
 */
async function pendingSurvivesNextRound(
  name: string, oldCli: string | null, newCli: string | null, collide: boolean,
): Promise<void> {
  const { backfillClaudeMonitors, forgetTaskMonitorScan } = await import("../src/claude-monitor-backfill.js");
  const taskId = `t-pending-${name}`;
  const sessionKey = `sesspend${name.replace(/[^a-z]/g, "")}`;
  const dir = join(root, "runs", taskId);
  mkdirSync(dir, { recursive: true });
  const runOf = (stamp: string) => join(dir, `${sessionKey}-${stamp}.agent-out.jsonl`);
  const oldRun = runOf("20261014T010000000Z");
  const newRun = runOf("20261015T010000000Z");
  const ev = (o: unknown) => JSON.stringify(o) + "\n";
  const owner = oldCli ? { session_id: oldCli } : {};
  const WINDOW = 4096;
  // 窗口正好停在 `tool_use` 之后、`task_started` 之前：用一条长 text 把前缀撑到整整 4096。
  let prefix = ev({ type: "system", subtype: "init", ...owner })
    + ev({ type: "assistant", timestamp: "2026-10-14T01:00:00.000Z", message: { model: "m", content: [
      { type: "tool_use", name: "Monitor", id: "tu-twin",
        input: { command: "printf old", description: "旧一轮监听", timeout_ms: 600_000 } },
    ] } });
  const padBase = ev({ type: "assistant", message: { content: [{ type: "text", text: "" }] } });
  const fill = WINDOW - Buffer.byteLength(prefix) - Buffer.byteLength(padBase);
  if (fill <= 0) throw new Error(`夹具的前缀已经超过窗口（${fill}）`);
  prefix += ev({ type: "assistant", message: { content: [{ type: "text", text: "x".repeat(fill) }] } });
  if (Buffer.byteLength(prefix) !== WINDOW) throw new Error(`前缀没有正好等于窗口：${Buffer.byteLength(prefix)}`);
  writeFileSync(oldRun, prefix
    + ev({ type: "system", subtype: "task_started", task_id: "old-native", tool_use_id: "tu-twin",
      task_type: "local_bash", ...owner })
    + ev({ type: "user", timestamp: "2026-10-14T01:00:00.040Z", message: { content: [
      { type: "tool_result", tool_use_id: "tu-twin",
        content: "Monitor started (task old-native, expires in 5m unless the source ends first)." },
    ] } })
    + ev({ type: "system", subtype: "task_notification", task_id: "old-native", status: "completed",
      summary: "旧一轮已完成", ...owner }));
  writeFileSync(newRun, ev({ type: "system", subtype: "init", ...(newCli ? { session_id: newCli } : {}) }));

  await db.insert(tasks).values({ id: taskId, projectId: "p", title: `未决调用（${name}）`, body: "",
    status: "running", agentType: "claude", mode: "single", createdAt: now(), updatedAt: now() });
  await db.insert(sessions).values({
    id: sessionKey, taskId, role: "single", agentType: "claude", executor: "claude@x",
    cliSessionId: newCli, cwd: root, startedAt: now(), agentOutPath: newRun,
  });
  // 新一轮那张卡已经正常成行（它用的号跟旧调用撞不撞由 `collide` 决定）。
  await db.insert(monitors).values({
    ...projectionOf(`m-new-${name}`, taskId, collide ? "tu-twin" : "tu-other", newCli, newRun),
    command: "printf new", description: "新一轮监听", status: "exited", endedAt: now(),
    nativeId: "new-native",
  });

  const before = process.env.ASH_MONITOR_SCAN_MAX_BYTES;
  process.env.ASH_MONITOR_SCAN_MAX_BYTES = String(WINDOW);
  try {
    await backfillClaudeMonitors(taskId);          // 第一轮:只读到窗口为止
  } finally {
    if (before === undefined) delete process.env.ASH_MONITOR_SCAN_MAX_BYTES;
    else process.env.ASH_MONITOR_SCAN_MAX_BYTES = before;
  }
  const parked = await db.select().from(monitorPendingCalls)
    .where(eq(monitorPendingCalls.taskId, taskId));
  check(parked.length === 1 && parked[0]?.sourceRun === oldRun,
    `⑥${name}：前提 —— 旧调用落在未决表里，记着自己的 run`,
    JSON.stringify(parked.map((r) => [r.toolUseId, r.sourceRun?.slice(-28), r.cliSessionId])));
  check(parked[0]?.cliSessionId === oldCli,
    `⑥${name}：而且记的是**调用发生时**那个归属，不是当前会话的`,
    `${parked[0]?.cliSessionId} ≠ ${newCli}`);

  // **把进程内状态抹掉**：入参此后只剩未决表那一份（位置已经越过 `tool_use`，不会再读到它）。
  forgetTaskMonitorScan(taskId);
  for (let i = 0; i < 4; i += 1) await backfillClaudeMonitors(taskId);

  const rows = await listMonitors(taskId);
  check(rows.length === 2, `⑥${name}：两轮各有各的卡（旧那张没丢）`,
    rows.map((r) => `${r.nativeId}/${r.description}/${r.status}`).join(" , "));
  const old = rows.find((r) => r.nativeId === "old-native");
  check(old?.description === "旧一轮监听" && old?.command === "printf old",
    `⑥${name}：旧卡的入参来自未决表那一行（唯一出处）`,
    `${old?.description} / ${old?.command}`);
  check(old?.status === "exited", `⑥${name}：旧卡自己的终态也落上了`, String(old?.status));
  const leftover = await db.select().from(monitorPendingCalls)
    .where(eq(monitorPendingCalls.taskId, taskId));
  check(leftover.length === 0, `⑥${name}：配上之后未决表就地销账（不会越积越多）`,
    JSON.stringify(leftover.map((r) => r.toolUseId)));
}

/**
 * **一轮里**读到两个 run 文件的同号调用：内存里也得各占一条。
 *
 * 形状：甲 run 那条调用的进程在 `tool_use` 之后被杀（没有 `task_started`、连回执都没有，所以
 * 它会长期悬着）；乙 run 用了同一个 tool_use 号，并且正常成行。`pending` 原先是
 * `Map<号, 单条>`，于是乙那条**覆盖**掉甲的 —— 甲的入参（唯一出处）当轮就没了，连落盘的机会
 * 都没有。配对链上的来源分区就是为这个（新一轮第 1 轮审查 F1 列的同类位置）。
 */
async function pendingKeepsBothRunsInOneRound(): Promise<void> {
  const { backfillClaudeMonitors } = await import("../src/claude-monitor-backfill.js");
  const taskId = "t-pending-one-round";
  const sessionKey = "sesspendoneround";
  const dir = join(root, "runs", taskId);
  mkdirSync(dir, { recursive: true });
  const runOf = (stamp: string) => join(dir, `${sessionKey}-${stamp}.agent-out.jsonl`);
  const runA = runOf("20261014T030000000Z");
  const runB = runOf("20261015T030000000Z");
  const ev = (o: unknown) => JSON.stringify(o) + "\n";
  /** 一个 run 文件的开头：init + 一条悬着的 `tu-twin` + 一条两个文件都有的悬着的 `tu-ghost`。 */
  const call = (cli: string, text: string) =>
    ev({ type: "system", subtype: "init", session_id: cli })
    + ev({ type: "assistant", timestamp: "2026-10-14T03:00:00.000Z", message: { model: "m", content: [
      { type: "tool_use", name: "Monitor", id: "tu-twin",
        input: { command: `printf ${text}`, description: `${text} 的监听`, timeout_ms: 600_000 } },
    ] } })
    // 两个 run 文件里的**同号**调用都悬着：它们必须在库里各占一行（持久键里有来源那一维），
    // 否则第二条被唯一冲突吞掉，它的入参就只剩别人那一份。
    + ev({ type: "assistant", timestamp: "2026-10-14T03:00:01.000Z", message: { model: "m", content: [
      { type: "tool_use", name: "Monitor", id: "tu-ghost",
        input: { command: `printf ghost-${text}`, description: `${text} 的幽灵`, timeout_ms: 600_000 } },
    ] } });
  writeFileSync(runA, call("cli-a", "jia"));     // 进程在这一行之后被杀：永远不会完结
  writeFileSync(runB, call("cli-b", "yi")
    + ev({ type: "system", subtype: "task_started", task_id: "yi-native", tool_use_id: "tu-twin",
      task_type: "local_bash", session_id: "cli-b" })
    + ev({ type: "system", subtype: "task_notification", task_id: "yi-native", status: "completed",
      summary: "乙跑完了", session_id: "cli-b" }));

  await db.insert(tasks).values({ id: taskId, projectId: "p", title: "一轮两个 run", body: "",
    status: "running", agentType: "claude", mode: "single", createdAt: now(), updatedAt: now() });
  await db.insert(sessions).values({
    id: sessionKey, taskId, role: "single", agentType: "claude", executor: "claude@x",
    cliSessionId: "cli-b", cwd: root, startedAt: now(), agentOutPath: runB,
  });
  await backfillClaudeMonitors(taskId);

  const rows = await listMonitors(taskId);
  check(rows.length === 1 && rows[0]?.nativeId === "yi-native",
    "⑥(b) 乙那条正常成卡", rows.map((r) => `${r.nativeId}/${r.description}`).join(","));
  const parked = await db.select().from(monitorPendingCalls)
    .where(eq(monitorPendingCalls.taskId, taskId));
  const twin = parked.filter((r) => r.toolUseId === "tu-twin");
  check(twin.length === 1 && twin[0]?.sourceRun === runA && twin[0]?.cliSessionId === "cli-a",
    "⑥(b) 甲那条还悬着的调用没被乙覆盖掉（入参连同它的来源一起落了盘）",
    JSON.stringify(parked.map((r) => [r.toolUseId, r.cliSessionId, r.sourceRun?.slice(-28)])));
  check(twin[0]?.command === "printf jia",
    "⑥(b) 而且留下来的入参是甲自己的，不是乙的", String(twin[0]?.command));
  // 同号、不同 run、都还悬着 ⇒ 库里各占一行（这一条打在**新库的 bootstrap DDL** 上：
  // 唯一键少了来源那一维，第二条就被 onConflictDoNothing 吞掉）。
  const ghosts = parked.filter((r) => r.toolUseId === "tu-ghost");
  check(ghosts.length === 2 && new Set(ghosts.map((r) => r.sourceRun)).size === 2,
    "⑥(b) 两个 run 里的同号悬着调用在库里各占一行",
    JSON.stringify(ghosts.map((r) => [r.sourceRun?.slice(-28), r.command])));
  check(ghosts.every((r) => r.command === `printf ghost-${r.sourceRun === runA ? "jia" : "yi"}`),
    "⑥(b) 而且两行各自记着自己那份入参",
    JSON.stringify(ghosts.map((r) => r.command)));
}

/**
 * 来源**完全未知**时，两个 run 文件的同号监听仍然各有各的卡。
 *
 * 持久身份原先是 `(task_id, COALESCE(cli_session_id,''), native_id)`：归属认不出来的行全挤
 * 在同一个空串上，于是第二张卡插不进去（唯一冲突被当成「已经有归宿了」），而读取位置照常
 * 推到文件末尾 —— 那张卡再也不会出现（第 8 轮审查 N2）。现在未知归属按 `source_run` 入键。
 *
 * `onlyNoticeCarries=true` 是另一种形状：前面都不报，只有最后那条完成通知报了 session_id。
 */
async function unknownSourcesEachGetACard(onlyNoticeCarries: boolean): Promise<void> {
  const { backfillClaudeMonitors } = await import("../src/claude-monitor-backfill.js");
  const tag = onlyNoticeCarries ? "只有通知带来源" : "来源一次都没报";
  const suffix = onlyNoticeCarries ? "-notice-only" : "-no-source";
  const taskId = `t-unknown${suffix}`;
  const dir = join(root, "runs", taskId);
  mkdirSync(dir, { recursive: true });
  const sessionKey = `sessunknown${suffix}`;
  const runOf = (stamp: string) => join(dir, `${sessionKey}-${stamp}.agent-out.jsonl`);
  const oldRun = runOf("20261014T000000000Z");
  const newRun = runOf("20261015T000000000Z");
  const ev = (o: unknown) => JSON.stringify(o) + "\n";
  const story = (tu: string, done: boolean) =>
    ev({ type: "assistant", timestamp: "2026-10-14T00:00:01.000Z", message: { model: "m", content: [
      { type: "tool_use", name: "Monitor", id: tu,
        input: { command: `tail -F /tmp/${tu}`, description: `${tu} 的监听`, timeout_ms: 600_000 } },
    ] } })
    + ev({ type: "system", subtype: "task_started", task_id: "bshared", tool_use_id: tu,
      task_type: "local_bash" })
    + (done
      ? ev({ type: "system", subtype: "task_notification", task_id: "bshared", status: "completed",
        summary: "跑完了", ...(onlyNoticeCarries ? { session_id: "cli-late" } : {}) })
      : "");
  writeFileSync(oldRun, story("tu-a", false));
  writeFileSync(newRun, story("tu-b", true));

  await db.insert(tasks).values({ id: taskId, projectId: "p", title: `无来源（${tag}）`, body: "",
    status: "running", agentType: "claude", mode: "single", createdAt: now(), updatedAt: now() });
  await db.insert(sessions).values({
    id: sessionKey, taskId, role: "single", agentType: "claude", executor: "claude@x",
    cliSessionId: null, cwd: root, startedAt: now(), agentOutPath: newRun,
  });

  await backfillClaudeMonitors(taskId);
  const rows = await db.select().from(monitors).where(eq(monitors.taskId, taskId));
  check(rows.length === 2, `⑤${tag}：两个 run 文件各有各的卡（不是第二张被唯一键挡掉）`,
    rows.map((r) => `${r.sourceRun?.slice(-30)}/${r.toolUseId}/${r.status}`).join(" , "));
  check(new Set(rows.map((r) => r.sourceRun)).size === 2,
    `⑤${tag}：两张卡记着各自的 run 文件`, rows.map((r) => String(r.sourceRun)).join(","));
  const fresh = rows.find((r) => r.sourceRun === newRun);
  check(fresh?.status === "exited" && fresh?.toolUseId === "tu-b",
    `⑤${tag}：带完成通知那一轮是它自己的卡收到终态`, `${fresh?.status} / ${fresh?.toolUseId}`);
  const stale = rows.find((r) => r.sourceRun === oldRun);
  check(stale?.status !== "exited" && stale?.toolUseId === "tu-a",
    `⑤${tag}：另一轮没被那条终态改写`, `${stale?.status} / ${stale?.toolUseId}`);
}

/**
 * 同一条 ash 会话换过 CLI 号：两个历史来源各自成卡。
 *
 * `repeatSource=false` 时**只有文件开头那条 init 行**带 `session_id`，后续记录都不带 ——
 * 这是来源侧确实存在的形状，而归属判据原先在这种输入上退回 `sessions.cli_session_id`
 * （当前身份），于是旧 run 的监听被改姓、两轮又合成一张卡（第 7 轮审查 N2）。
 */
async function twoHistoricalSources(repeatSource: boolean, window = 0): Promise<void> {
  const { backfillClaudeMonitors, forgetTaskMonitorScan } = await import("../src/claude-monitor-backfill.js");
  const tag = window ? "只有 init 带来源 + 分几轮读完且丢快照"
    : repeatSource ? "每条都带来源" : "只有 init 带来源";
  const suffix = window ? "-resumed" : repeatSource ? "" : "-init-only";
  const taskId = `t-history${suffix}`;
  const dir = join(root, "runs", taskId);
  mkdirSync(dir, { recursive: true });
  // 文件名前缀必须是**会话 id**：run 文件就是按这个前缀枚举的（claude-monitor-read.ts 的
  // `streamFilesOf`），对不上就只剩 `agentOutPath` 那一个文件被读到。
  const sessionKey = `sesshist${suffix}`;
  const runOf = (stamp: string) => join(dir, `${sessionKey}-${stamp}.agent-out.jsonl`);
  const oldRun = runOf("20261014T000000000Z");
  const newRun = runOf("20261015T000000000Z");
  const ev = (o: unknown) => JSON.stringify(o) + "\n";
  /** 后续记录带不带来源：不带的时候这一行就只能靠「这个 run 文件的来源」认人。 */
  const src = (cli: string) => (repeatSource ? { session_id: cli } : {});
  const story = (cli: string, tu: string, done: boolean) =>
    ev({ type: "system", subtype: "init", session_id: cli })
    + ev({ type: "assistant", timestamp: "2026-10-14T00:00:01.000Z", message: { model: "m", content: [
      { type: "tool_use", name: "Monitor", id: tu,
        input: { command: `tail -F /tmp/${tu}`, description: `${cli} 的监听`, timeout_ms: 600_000 } },
    ] } })
    + ev({ type: "system", subtype: "task_started", task_id: "bshared", tool_use_id: tu,
      task_type: "local_bash", ...src(cli) })
    + (done
      ? ev({ type: "system", subtype: "task_notification", task_id: "bshared",
        status: "completed", summary: "新这一轮跑完了", ...src(cli) })
      : "");
  writeFileSync(oldRun, story("cli-old", "tu-old", false));
  writeFileSync(newRun, story("cli-new", "tu-new", true));

  await db.insert(tasks).values({ id: taskId, projectId: "p", title: `换过号（${tag}）`, body: "", status: "running",
    agentType: "claude", mode: "single", createdAt: now(), updatedAt: now() });
  // 一条 ash 会话，两代 run 文件；库里只记得**当前**那个 cli 身份。
  await db.insert(sessions).values({
    id: sessionKey, taskId, role: "single", agentType: "claude", executor: "claude@x",
    cliSessionId: "cli-new", cwd: root, startedAt: now(), agentOutPath: newRun,
  });
  // 旧来源那张卡（升级前落下的：没有归属，但记着自己是从哪个 run 读出来的）。
  await db.insert(monitors).values({
    id: `m-old${suffix}`, taskId, command: "tail -F /tmp/tu-old", description: "cli-old 的监听", cwd: root,
    status: "running", pid: null, pidStartedAt: null, logPath: "", offset: 0, events: 0,
    exitCode: null, startedAt: now(), expiresAt: now(), endedAt: null, endedReason: null,
    ownerUserId: null, kind: "claude", nativeId: "bshared", cliSessionId: null,
    toolUseId: null, sourceLifetime: "unknown", sourceRun: oldRun,
  });

  if (!window) await backfillClaudeMonitors(taskId);
  else {
    // 读取窗口调小 ⇒ 一轮读不完；每轮之间把进程内快照丢掉 ⇒ 下一轮只能从**落盘的游标**接着
    // 读，文件开头那条 init 行再也不会被读到。来源这件事此后只有一个依据：游标上的 `source`。
    const before = process.env.ASH_MONITOR_SCAN_MAX_BYTES;
    process.env.ASH_MONITOR_SCAN_MAX_BYTES = String(window);
    try {
      for (let i = 0; i < 20; i += 1) {
        await backfillClaudeMonitors(taskId);
        forgetTaskMonitorScan(taskId);
      }
    } finally {
      if (before === undefined) delete process.env.ASH_MONITOR_SCAN_MAX_BYTES;
      else process.env.ASH_MONITOR_SCAN_MAX_BYTES = before;
    }
  }
  const rows = await db.select().from(monitors).where(eq(monitors.taskId, taskId));
  check(rows.length === 2, `④${tag}：两个历史来源 ⇒ 两张卡（不是合成一张）`,
    rows.map((r) => `${r.cliSessionId}/${r.toolUseId}/${r.status}`).join(" , "));
  const old = rows.find((r) => r.id === `m-old${suffix}`);
  check(old?.status !== "exited" && old?.toolUseId !== "tu-new",
    `④${tag}：旧那张卡没有被新一轮的事实改写`, `${old?.status} / ${old?.toolUseId} / ${old?.cliSessionId}`);
  check(old?.cliSessionId === "cli-old",
    `④${tag}：而且它被**它自己那个 run** 认领了（归属补成 cli-old，不是当前的 cli-new）`,
    String(old?.cliSessionId));
  // **每张卡的三样东西必须是同一个来源的**：归属、起它的那个 tool_use、它的描述。
  // 合成一张的那种坏法正是在这里露馅：旧卡的描述配上新一轮的 tool_use 和终态。
  const shape = rows
    .map((r) => `${r.cliSessionId}|${r.toolUseId}|${r.description}`).sort().join(" , ");
  check(shape === "cli-new|tu-new|cli-new 的监听 , cli-old|tu-old|cli-old 的监听",
    `④${tag}：两张卡各自的归属/tool_use/描述都来自同一个来源（没有张冠李戴）`, shape);
  check(rows.some((r) => r.cliSessionId === "cli-new" && r.status === "exited"),
    `④${tag}：新来源有自己的卡，终态也在`,
    rows.map((r) => `${r.cliSessionId}:${r.status}`).join(","));
}

try {
  await main();
} finally {
  releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
}
