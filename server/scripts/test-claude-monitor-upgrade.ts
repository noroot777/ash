// **跨「消费语义」升级的持久确认**（第 10 轮审查 F1 的类问题）。
//
// 一份落盘的读取位置承诺的是：它之前读过的每一条事实，都已经按**那一代**的身份判据与
// 合并/消费规则，被某一行已提交的状态包含。两代旧代码已经被实测证明做不到这句话：
//
// - 第 1 代（≤ `41f857c3`）：未知归属的行全挤在一个空串唯一键上 ⇒ 两个 run 文件里的同号
//   监听只留得下第一张卡；撞键之后只要身份对得上就算消费 ⇒ 这一次读到的终态和时长一个字
//   都没合并进去。两样都发生在「位置已经推到文件末尾」之后，所以**没有任何重建路径**。
// - 第 2 代（`6f8537c4`）：键和合并都修好了，**但采用旧位置的规则还是错的** —— 它拿「这个
//   文件最后报过来源」当成「这一段事实当时都正确入库了」。来源非空只说明文件里某一处报过
//   身份：更早那些启动记录当时可能根本没有归属（晚到身份那种形状），而一次没落地的状态
//   更新跟来源空不空毫无关系。于是上面两种存量错误在**已知来源**的任务上照旧不自愈，还
//   可能把没核验过的旧前缀重新盖成 v2。
//
// - 第 3 代（`492e2a75`）：位置的采用规则也对了，**但未决调用那条链还是另一套身份判据** ——
//   它拿当前 `sessions.cli_session_id` 反推旧调用的归属、把两个「来源未知」当成同源。两轮
//   撞同一个 tool_use 号时，新一轮成行就把旧一轮还悬着的那条调用销了账，而那一行是它入参的
//   唯一出处 ⇒ 旧卡永久缺失，这一代照常给那个前缀盖上「读完了」。
//
// 所以判据收成一句：**只接回带当代戳的位置**，其余的那个文件从零重放一遍（见
// claude-monitor-cursors.ts 的 `MONITOR_CHECKPOINT_SEMANTICS`）。这份测试把两种存量错误
// 各钉一遍，再钉两条反向约束：带当代戳的不许白重读，这一轮没读到的文件不许被盖戳。
//
// 夹具播种的是**真旧代码跑出来的那个状态**（审查用 `git archive` 跑旧提交生成库实测过）：
// 一张错卡 / 少一张卡 + 已经推到末尾的位置。这里不复跑旧代码，只复现它留下的库。
import { rmSync, statSync, writeFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import {
  LIMIT, root, db, schema, monitors, projects,
  backfillClaudeMonitors, listMonitors, releaseTmpDb, check, failureCount,
  stopAllMonitorRecovery, now, line, fixture, padLines, call, started, receipt, notice,
} from "./monitor-checkpoint-harness.js";

let CURRENT = 0;

/**
 * 老一代留下的那份位置：戳是 `semantics`（null = 第 1 代），默认已经读到末尾。
 *
 * `offset` 可以指定成半路 —— ④ 要的正是「这个文件还得往下读、另一个已经到末尾」这种组合。
 */
const seedCursor = (
  taskId: string, path: string, source: string | null, semantics: number | null, offset?: number,
) => db.insert(schema.monitorScanCursors).values({
  taskId, path, fileSize: statSync(path).size, readOffset: offset ?? statSync(path).size,
  probe: 0, gaps: "[]", source, semantics,
});

const cursorsOf = (taskId: string) => db.select().from(schema.monitorScanCursors)
  .where(eq(schema.monitorScanCursors.taskId, taskId));

async function main(): Promise<void> {
  await db.insert(projects).values({ id: "p", name: "p", repoPath: root, createdAt: now() });
  ({ MONITOR_CHECKPOINT_SEMANTICS: CURRENT } = await import("../src/claude-monitor-cursors.js"));

  // ① 旧一代把**终态和时长**丢了（第 9 轮审查 F1 的存量形状），而位置的来源是已知的。
  //    两个戳各来一遍：第 1 代（NULL）和「采用规则还错着」的第 2 代 —— v2 的戳同样不可信。
  await legacyLostStatus(null);
  await legacyLostStatus(2);
  // 每一代作废的戳都要有一遍：v3 盖的戳同样不可信（它也能确认一个少卡的前缀），所以这里
  // 跟着 CURRENT 走 —— **当代号一加，上一代就自动进这个清单**。
  for (let stamp = 3; stamp < CURRENT; stamp += 1) await legacyLostStatus(stamp);
  // ② 旧粗身份把**整张卡**挤掉了。两种形状：来源从头到尾没报过，以及只有最后那条通知报了
  //    （后者正是上一版放过的那种 —— 位置的 source 非空，而更早的行当时并没有归属）。
  await legacyDroppedCard(false);
  await legacyDroppedCard(true);
  await legacyDroppedCard(false, CURRENT - 1);
  // ③④ 反向约束：别把「全部作废」当成修法。
  await currentStampIsAdopted();
  await unreadFileIsNotStamped();

  if (failureCount() === 0) {
    console.log("✓ 内置 Monitor 的跨语义升级：没有当代戳的位置一律重放（旧代丢掉的终态补回来、"
      + "被挤掉的卡补回来，来源已知/晚到身份/从未报过三种形状都一样，上一代的戳也不例外）/ "
      + "带当代戳的位置照常接着读（不每次全量重读）/ "
      + "这一轮没读到的文件不会被盖上当代戳 均受回归保护");
  }
}

/**
 * ① 旧一代留下一张**错卡**：实时投影那一行还写着「进程已不在」、期限未知，而文件里的完成
 * 通知和 90 秒回执当年撞键之后被丢掉了，位置却已经到了末尾（来源已知）。
 *
 * 升级之后必须自愈 —— 这正是审查用真旧代码 + 真页面复现的那条：打开旧任务，已经完成的监听
 * 仍显示「进程已不在」，刷新也不纠正。
 */
async function legacyLostStatus(stamp: number | null): Promise<void> {
  const tag = stamp === null ? "第 1 代" : `v${stamp}`;
  const f = await fixture(`legacy-status-${stamp ?? "null"}`);
  let body = line({ type: "system", subtype: "init", session_id: f.cli });
  body += call(f.cli, "tu-blost", "旧一代丢了终态的那条", "2026-10-15T10:00:00.000Z");
  body += started(f.cli, "tu-blost", "blost");
  body += receipt("tu-blost", "blost", "2026-10-15T10:00:00.040Z");
  body += notice(f.cli, "blost");
  writeFileSync(f.file, body);
  await db.insert(monitors).values({
    id: `m-${f.taskId}`, taskId: f.taskId, command: "sleep 1800",
    description: "旧一代丢了终态的那条", cwd: root, status: "lost", pid: null, pidStartedAt: null,
    logPath: "", offset: 0, events: 0, exitCode: null, startedAt: "2026-10-15T10:00:00.020Z",
    expiresAt: "2026-10-15T10:00:00.020Z", endedAt: null,
    endedReason: "agent 进程已经不在了，它跟着一起没了", ownerUserId: null, kind: "claude",
    nativeId: "blost", cliSessionId: f.cli, toolUseId: "tu-blost", sourceLifetime: "unknown",
    lifetimeEvidence: null, startEvidence: "observed", startAnchorWidthMs: 20, timeoutMs: null,
    sourcePid: null, sourcePidStartedAt: null, sourceRun: f.file,
    startLowAt: "2026-10-15T10:00:00.020Z",
  });
  await seedCursor(f.taskId, f.file, f.cli, stamp);

  await backfillClaudeMonitors(f.taskId);
  const row = (await listMonitors(f.taskId)).find((r) => r.kind === "claude");
  check(row?.status === "exited",
    `①${tag}：旧位置重放，**那张卡的终态补回来了**`, String(row?.status));
  check(row?.timeoutMs === 90_000 && row?.lifetime === "bounded",
    `①${tag}：来源给的时长也补上了（不再是「期限未知」）`, `${row?.lifetime}/${row?.timeoutMs}`);
  check((await listMonitors(f.taskId)).filter((r) => r.kind === "claude").length === 1,
    "①重放是幂等的：还是同一张卡，没有多出一行");
  const saved = (await cursorsOf(f.taskId)).at(0);
  check(saved?.semantics === CURRENT && saved?.readOffset === saved?.fileSize,
    `①${tag}：位置带着当代戳重新落盘（重放只发生一次）`,
    `${saved?.semantics}:${saved?.readOffset}/${saved?.fileSize}`);
}

/**
 * ② 旧粗身份把第二张卡挤掉了：两个 run 文件里有同一个 native_id，旧键把未知归属的行全算成
 * 同一个，于是第二张插不进去，而两个文件的位置都推到了末尾。
 *
 * `onlyNoticeCarries=true` 是上一版明确放过的那种：位置的 `source` 非空（最后那条通知报了
 * 身份），可当年的启动记录读到时还没有任何归属 —— 「来源非空 ⇒ 当时都正确入库」不成立。
 */
async function legacyDroppedCard(onlyNoticeCarries: boolean, stamp: number | null = null): Promise<void> {
  const tag = `${onlyNoticeCarries ? "只有通知报了来源" : "来源从未报过"}`
    + `${stamp === null ? "" : `·v${stamp} 的戳`}`;
  const f = await fixture(`legacy-card-${onlyNoticeCarries}-${stamp ?? "null"}`);
  const oldRun = f.runFile("20261014T000000000Z");
  const newRun = f.runFile("20261015T000000000Z");
  const ev = (o: unknown) => JSON.stringify(o) + "\n";
  const story = (tu: string) =>
    ev({ type: "assistant", timestamp: "2026-10-14T00:00:01.000Z", message: { model: "m", content: [
      { type: "tool_use", name: "Monitor", id: tu,
        input: { command: `tail -F /tmp/${tu}`, description: `${tu} 的监听`, timeout_ms: 600_000 } },
    ] } })
    + ev({ type: "system", subtype: "task_started", task_id: "bdropped", tool_use_id: tu,
      task_type: "local_bash" })
    + ev({ type: "system", subtype: "task_notification", task_id: "bdropped", status: "completed",
      summary: "跑完了", ...(onlyNoticeCarries ? { session_id: "cli-late" } : {}) });
  writeFileSync(oldRun, story("tu-a"));
  writeFileSync(newRun, story("tu-b"));
  // 旧一代留下的那一张（第一个 run 的那条）。
  await db.insert(monitors).values({
    id: `m-${f.taskId}`, taskId: f.taskId, command: "tail -F /tmp/tu-a", description: "tu-a 的监听",
    cwd: root, status: "exited", pid: null, pidStartedAt: null, logPath: "", offset: 0, events: 0,
    exitCode: null, startedAt: now(), expiresAt: now(), endedAt: now(), endedReason: null,
    ownerUserId: null, kind: "claude", nativeId: "bdropped", cliSessionId: null,
    toolUseId: "tu-a", sourceLifetime: "unknown", sourceRun: oldRun,
  });
  const source = onlyNoticeCarries ? "cli-late" : null;
  for (const path of [oldRun, newRun]) await seedCursor(f.taskId, path, source, stamp);

  await backfillClaudeMonitors(f.taskId);
  const rows = await db.select().from(monitors).where(eq(monitors.taskId, f.taskId));
  check(rows.length === 2, `②${tag}：旧位置重放，**被挤掉的那张卡补回来了**`,
    `${rows.length} 张：${rows.map((r) => `${r.toolUseId}/${r.status}`).join(" , ")}`);
  check(rows.some((r) => r.toolUseId === "tu-b" && r.sourceRun === newRun),
    `②${tag}：补回来的那张记着自己的 run 和 tool_use`,
    rows.map((r) => `${r.toolUseId}/${String(r.sourceRun).slice(-30)}`).join(" , "));
  const saved = await cursorsOf(f.taskId);
  check(saved.length === 2 && saved.every((c) => c.semantics === CURRENT),
    `②${tag}：两份位置都带上了当代戳`, saved.map((c) => String(c.semantics)).join(","));
}

/** ③ 反向约束：**带当代戳的位置照常接着读** —— 修法不是「旧的全作废、每次全量重读」。 */
async function currentStampIsAdopted(): Promise<void> {
  const f = await fixture("current-stamp");
  let body = line({ type: "system", subtype: "init", session_id: f.cli });
  body += call(f.cli, "tu-bkeep", "当代已经读过的那条", "2026-10-15T11:00:00.000Z");
  body += started(f.cli, "tu-bkeep", "bkeep");
  body += receipt("tu-bkeep", "bkeep", "2026-10-15T11:00:00.040Z");
  writeFileSync(f.file, body);
  // 库里一张卡都没有：位置被当真就什么都不读，被白重读就会冒出一张来。
  await seedCursor(f.taskId, f.file, f.cli, CURRENT);

  await backfillClaudeMonitors(f.taskId);
  const rows = await db.select().from(monitors).where(eq(monitors.taskId, f.taskId));
  check(rows.length === 0, "③带当代戳的位置照常采用（没有把历史白读一遍）",
    `${rows.length} 张：${rows.map((r) => String(r.toolUseId)).join(",")}`);
}

/**
 * ④ 反向约束：**这一轮没读到的文件不许被盖上当代戳**。
 *
 * 第一个文件撑过单轮字节上限 ⇒ 扫描在它里面就停下，后面那个文件这一轮根本没碰。上一版
 * 「采用旧位置 + 落盘时统一盖当代戳」的组合会把没核验过的旧前缀一起晋升，于是它再也不会
 * 被重放（第 10 轮审查 F1 的后一半）。
 */
async function unreadFileIsNotStamped(): Promise<void> {
  const f = await fixture("unread-not-stamped");
  const first = f.runFile("20261014T000000000Z");
  const second = f.runFile("20261015T000000000Z");
  let body = line({ type: "system", subtype: "init", session_id: f.cli });
  body += call(f.cli, "tu-bbig", "撑过一个窗口的那条", "2026-10-15T12:00:00.000Z");
  body += started(f.cli, "tu-bbig", "bbig");
  body += receipt("tu-bbig", "bbig", "2026-10-15T12:00:00.040Z");
  writeFileSync(first, padLines(body, LIMIT + 5_000));
  writeFileSync(second, line({ type: "system", subtype: "init", session_id: f.cli }));
  // 第一个文件的位置停在开头（还得往下读），第二个已经到末尾 —— 旧规则一旦把它们接回来，
  // 读过第一个之后落盘会把**没碰过**的第二个一起盖成当代戳。
  await seedCursor(f.taskId, first, f.cli, null, 0);
  await seedCursor(f.taskId, second, f.cli, null);

  await backfillClaudeMonitors(f.taskId);
  const saved = await cursorsOf(f.taskId);
  const head = saved.find((c) => c.path === first);
  const tail = saved.find((c) => c.path === second);
  check(head?.semantics === CURRENT && (head?.readOffset ?? 0) < (head?.fileSize ?? 0),
    "④读过的那一段盖当代戳（位置停在半路也算数：那一段确实按当代规则消费过了）",
    `${head?.semantics}:${head?.readOffset}/${head?.fileSize}`);
  check(tail?.semantics === null && tail?.readOffset === tail?.fileSize,
    "④**这一轮没读到的那个文件没被晋升**（它的旧位置仍然等着重放）",
    `${tail?.semantics}:${tail?.readOffset}/${tail?.fileSize}`);
}

try {
  await main();
} finally {
  stopAllMonitorRecovery();
  releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
}
process.exit(failureCount() === 0 ? 0 : 1);
