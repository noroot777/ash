// **记号这一问答得有多实,以及最后那份身份有没有真的落盘** —— 第 14 轮审查两条拦验收项的回归。
//
// 跟 test-monitor-reclaim-identity.ts 分开是因为那份已经 665 行(单文件 700 行的约定),而这两条
// 各自是一个独立的不变量:
//
// ⑬-1 **「展示文本里看得见这段文字」不是凭证**(F1 实测 `risk.log:1`)。审查起了一个自己的
//     诊断进程:**根本没有 `ASH_MONITOR_UNIT` 这个环境键**,只是另一个变量的**值**里写着
//     `saved old monitor: ASH_MONITOR_UNIT=<旧记号> end`。上一版的取证答 `ours`,真实的重复点停
//     入口当场把它杀了(`actualUnitVariablePresent=false`、`diagnosticAliveAfter=false`)。
//     第 13 轮「把 argv 和环境切开」修不掉这一条:**环境段自己也没有边界**(`ps -E` 把各项用
//     空格拼起来,值里有空格、有 `KEY=` 都看不出区别)。所以现在按证据等级分档:
//     Linux 的 `/proc/<pid>/environ` 是 NUL 分隔的真实环境项 ⇒ 这一问答「没有这一项」;
//     macOS 只拿得到展示文本 ⇒ 答「看得见」(`suspected`),**它只授权「不许说已经没了」**。
//     两档的共同结论是同一句:**一刀都不许下**。
//
// ⑬-2 **留档失败不许放行销毁**(F2 实测 `risk.log:33`)。`traceless` 是资源观测,「账本上有这条
//     创建的身份」是持久记录事实 —— 上一版把两者合成一个 `closed`:留档 insert 失败只 `catch`
//     一句日志、追空分支照样返回 `closed`,于是销毁前核对放行,任务行、哨兵行、债行同时为 0,
//     而那条命令可能还在后台跑着。现在三档分开(`existing`/`written`/`failed`),销毁那条路只要
//     有一条没拿到持久交接就整笔抛回去 —— **任务和身份都留着,用户再点一次即可**。
//
// ⑬-4/⑬-5 **强凭证被拒绝之后不许退回弱判据**(第 16 轮审查 F1-B)。「这个号已经不是记号
//     证明过的那一代了」是**反证**,不是「这次没拿到值」。上一版两处身份恢复都只看有没有拿到
//     值,拿不到就退回「时间邻近 + 命令包含」—— 于是一个在那两秒窗口里起来、命令文本又恰好
//     对得上的陌生进程被授信,它真实的启动时刻被写成旧哨兵的身份,随后按这条身份被关掉
//     (`identity-fallback.log`:`persistedStartedAt` 就是新进程的启动时刻、
//     `diagnosticAliveAfter=false`)。两处共用同一条规矩:反证 ⇒ 什么都不补、什么都不认。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import {
  db, insertMonitorRow, isPidAlive, makeTask, monitors, schema, startMonitor, stopMonitor,
  tasks, teardown, until,
} from "./monitors-fixture.js";
import { STUBBORN, debtRow } from "./monitor-reclaim-fixture.js";
import { install as fakeProc, restore as realProc, type FakeAnswers } from "./fake-proc-fixture.js";
import { processUnitEvidence } from "../src/proc.js";
import { monitorUnitProofGrade } from "../src/monitor-unit-scan.js";

const { stopMonitorsForTask } = await import("../src/monitor-reclaim.js");
const { deleteTaskCompletely } = await import("../src/task-delete-routes.js");
const { sweepMonitorReclaimDebts } = await import("../src/monitor-reclaim-debts.js");
const { reclaimState } = await import("../src/monitor-reclaim-evidence.js");
const { isProcessGroupAlive, killTree, inspectProcessSync } = await import("../src/platform.js");
const { invalidateMonitorUnitScan } = await import("../src/monitor-unit-scan.js");
const { dbClient } = await import("../src/db/index.js");
const { monitorSpawnIdentityPath } = await import("../src/monitor-spawn.js");
const { reclaimMonitorProcess } = await import("../src/monitor-reclaim-debts.js");
const { reattachMonitors } = await import("../src/monitors.js");

const EXACT_MARKS = monitorUnitProofGrade() === "exact";

/** 一个**确定已经退干净、组也空了**的号:历史行要的就是这种 pid。 */
async function deadPid(): Promise<number> {
  const gone = spawn("sh", ["-lc", "exit 0"], { detached: true, stdio: "ignore" });
  gone.unref();
  const pid = gone.pid!;
  await until("那个号退干净、组也空了", async () => !isPidAlive(pid) && !isProcessGroupAlive(pid));
  return pid;
}

{
  // ⑬-1 **另一个变量的值里含有这段文字 ⇒ 绝不许挨刀**(第 14 轮审查 F1 的实测复现)。
  const taskId = await makeTask({ status: "done" });
  const unitToken = `unit-valuetext-${process.pid}-${Date.now()}`;
  const historical = await deadPid();
  // 诊断进程:**没有 `ASH_MONITOR_UNIT` 这个键**,只有另一个变量的值里写着这段文字。
  const diagnostic = spawn("sh", ["-lc", STUBBORN], {
    detached: true,
    stdio: "ignore",
    env: {
      PATH: process.env.PATH ?? "",
      MONITOR_DIAGNOSTIC: `saved old monitor: ${"ASH_MONITOR_UNIT"}=${unitToken} end`,
    },
  });
  diagnostic.unref();
  invalidateMonitorUnitScan();   // 台子在替 `spawnMonitor` 起进程(见那边的注释)
  const pid = diagnostic.pid!;
  await until("诊断进程起来了", async () => isPidAlive(pid));

  const evidence = processUnitEvidence(unitToken, { fresh: true });
  assert.notEqual(evidence.verdict, "ours",
    "**值里的那段文字不是凭证** —— 这个进程根本没有 ASH_MONITOR_UNIT 这一项");
  assert.equal(evidence.verdict, EXACT_MARKS ? "none" : "suspected",
    EXACT_MARKS
      ? "真实环境项读得出来 ⇒ 这一问答「没有这一项」"
      : "只有无边界展示文本 ⇒ 只能答「看得见」,而那一档签不出任何下刀凭证");
  assert.equal(reclaimState(historical, null, { unitToken }),
    EXACT_MARKS ? "traceless" : "suspected",
    EXACT_MARKS
      ? "精确档:根退了、组空了、真实环境项里也没有这一项 ⇒ 线索追到此为止"
      : "展示文本档:看得见那段文字 ⇒ 证不出在谁身上,但绝不许当成已经退出");

  // 端到端走审查实测的那个入口:对一条非运行态的历史行再点一次停止。
  const monId = await insertMonitorRow(taskId, {
    status: "stopped", pid: historical, pidStartedAt: null, unitToken, command: "sleep 300",
  });
  await stopMonitor(monId, "再点一次停止");
  assert.equal(isPidAlive(pid), true,
    "**一刀都不许下** —— 那是别人的进程,它只是在某个变量的值里提到过这段文字");

  if (!EXACT_MARKS) {
    const debt = await debtRow(monId);
    assert.ok(debt, "照记责任:证不出恰恰最该留责任");
    assert.equal(debt.closedAt, null, "也不许收档:这一刻线索还看得见");
    assert.match(debt.reason, /证不出|记号/, "账上要写清是哪一种不确定");
  }

  killTree(pid, "SIGKILL");   // 台子自己收场
  await until("诊断进程被收掉", async () => !isPidAlive(pid));
  await db.delete(schema.monitorReclaimDebts).where(eq(schema.monitorReclaimDebts.monitorId, monId));
}

{
  // ⑬-2 **留档写不进去 ⇒ 销毁必须整笔失败**(第 14 轮审查 F2 的实测复现)。
  //
  //    故障注入跟审查同一种:一条**只拒绝这张表、只针对这一个任务**的真实 SQLite trigger,
  //    别的表照常可写。这是明确的失败注入,不是宣称真实磁盘故障。
  const taskId = await makeTask({ status: "done" });
  const historical = await deadPid();
  const monId = await insertMonitorRow(taskId, {
    status: "stopped", pid: historical, pidStartedAt: null, command: "sleep 300",
  });
  assert.equal(reclaimState(historical, null, { unitToken: null }), "traceless",
    "台子前提:这一行的线索确实追空了(所以走的是留档那一支)");

  await dbClient.execute(
    "CREATE TRIGGER fixture_block_archive BEFORE INSERT ON monitor_reclaim_debts"
    + ` WHEN NEW.task_id='${taskId}' BEGIN SELECT RAISE(ABORT, 'fixture archive failure'); END`,
  );
  let threw: unknown = null;
  try { await deleteTaskCompletely(taskId); } catch (err) { threw = err; }
  assert.ok(threw, "**留档落不下来就不许删** —— 删除可重试,留一个谁都找不到的后台进程不可逆");
  assert.match(String(threw), /身份/, "错误里要说清是「最后一份身份没留下」这一种");
  assert.equal((await db.select().from(tasks).where(eq(tasks.id, taskId))).length, 1,
    "任务行原样留着(所以用户还能点开它、再点一次删除)");
  assert.equal((await db.select().from(monitors).where(eq(monitors.id, monId))).length, 1,
    "**哨兵行也原样留着** —— 没有持久交接的时候它自己就是最后一份身份");
  assert.equal((await db.select().from(schema.monitorReclaimDebts)
    .where(eq(schema.monitorReclaimDebts.monitorId, monId))).length, 0,
    "台子前提:那一行确实没写进去(不是「写进去了但我们没看见」)");

  // 故障撤掉之后照样删得掉,而且这一次身份真的留下来了。
  await dbClient.execute("DROP TRIGGER fixture_block_archive");
  await deleteTaskCompletely(taskId);
  assert.equal((await db.select().from(tasks).where(eq(tasks.id, taskId))).length, 0, "这次删成了");
  const archived = await debtRow(monId);
  assert.ok(archived, "**销毁之前那一行档留下来了** —— 命令、pid 都在上面");
  assert.ok(archived.closedAt, "而且直接是收档态:线索已经追空,没有可下刀的落点");
  assert.equal(archived.pid, historical, "行上还留着 pid");
  await sweepMonitorReclaimDebts();
  assert.ok((await debtRow(monId))?.closedAt, "也要活过开机清扫(收档的行不再追,但也不删)");
}

{
  // ⑬-3 **根被第一刀收走之后,忽略 TERM 的那个后代也要死** —— 两秒后那一刀的落点是
  //     **第一刀那一刻记下的成员名单,连代次一起**(第 14 轮审查 F1:不许给下层一份可跨等待
  //     复用的裸 pid 数组,也不许靠「两秒里 pid 不会被复用」这种推断)。
  //
  //     这是生产里最常见的泄漏形态(`executors/spawn.ts` 的补刀注释说的是同一件事):外层壳
  //     老老实实退了,它派生的那个 `trap '' TERM` 的东西还留在组里。这条路**不依赖记号的证据
  //     等级** —— 第一刀那会儿组长自己证明过、而且活着,所以那一刻组里的成员都是它的
  //     (外人要进来得 `setpgid` 到同一个会话,而那个会话的头正是这条哨兵)。
  const taskId = await makeTask({ status: "running" });
  const started = await startMonitor({
    taskId,
    // 后代忽略 TERM;根自己不 trap,所以第一刀就把根收走了。
    command: `( ${STUBBORN} ) & wait`,
    description: "忽略 TERM 的后代",
  });
  assert.equal(started.ok, true);
  const row = (await db.select().from(monitors).where(eq(monitors.taskId, taskId))).at(0)!;
  const pid = row.pid!;
  await until("组起来了、根还活着", async () => isPidAlive(pid) && isProcessGroupAlive(pid));

  await stopMonitor(row.id, "用户点停");
  await until("根被 TERM 收走了", async () => !isPidAlive(pid), 10_000);
  await until("忽略 TERM 的后代也被两秒后那一刀收掉", async () => !isProcessGroupAlive(pid), 20_000);
  await sweepMonitorReclaimDebts();   // 线索追空可能慢到上一步之后,收档由梯子补上
  const debt = await debtRow(row.id);
  assert.ok(debt?.closedAt, "整项都收干净、线索追空之后才收档");
}

{
  // ⑬-4 **记号证明过的那一代已经换掉 ⇒ 身份一个字都不许补**(第 16 轮审查 F1-B 实测的那条路)。
  //     台子:库里这一行 `pid_started_at` 还空着、边条上有时间锚;记号那一问先在 `j:111` 这一
  //     代上证明过这个号,随后这个号变成 `j:999` —— 现实里就是「原进程退了、号被别人接手」
  //     (所以记号也跟着没了)。而那个接手的陌生进程**真的**在两秒窗口里起来、命令文本**真的**
  //     包含记录的那一段:弱判据这一刻完全成立,所以这一条测的就是「反证有没有压住弱判据」。
  const taskId = await makeTask({ status: "done" });
  const unitToken = `unit-disproved-${process.pid}-${Date.now()}`;
  const stranger = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true, stdio: "ignore", env: { PATH: process.env.PATH! },
  });
  stranger.unref();
  const pid = stranger.pid!;
  const anchorMs = Date.now();
  const monId = await insertMonitorRow(taskId, {
    status: "stopped", pid, pidStartedAt: null, command: process.execPath, unitToken,
  });
  const row = (await db.select().from(monitors).where(eq(monitors.id, monId))).at(0)!;
  writeFileSync(monitorSpawnIdentityPath(row.logPath!), JSON.stringify({ pid, spawnedAtMs: anchorMs }));
  const realStartedAt = inspectProcessSync(pid)?.startedAt ?? null;
  assert.ok(realStartedAt, "台子前提:那个陌生进程此刻真的在跑,ps 认得它");
  fakeProc(pid, {
    // 前两次(那一遍 fresh 扫描的两趟)读到记号;之后记号就没了 —— 跟换代同时发生。
    tokensOnEnvRead: (n) => (n <= 2 ? [unitToken] : []),
    // 那一遍扫描每趟夹两次 stat,两趟共四次;第五次起换代。
    genOnStatRead: (n) => (n <= 4 ? "111" : "999"),
  });
  assert.deepEqual(processUnitEvidence(unitToken, { fresh: true }), {
    verdict: "ours", members: [{ pid, gen: "j:111" }],
  }, "台子前提:记号那一问先在 j:111 这一代上证明过这个号");
  const outcome = await reclaimMonitorProcess(
    { ...row, command: row.command, logPath: row.logPath },
    "审查:换代恰好发生在身份换算当口",
  );
  // 台子留到延迟信号的窗口过完再撤(fake-proc-fixture.ts 纪律 ②)。
  await new Promise((done) => setTimeout(done, 2_500));
  const aliveAfter = isPidAlive(pid);
  realProc();
  const after = (await db.select().from(monitors).where(eq(monitors.id, monId))).at(0)!;
  assert.equal(after.pidStartedAt, null, "反证之后不许靠时间锚给这个号补一份身份");
  assert.notEqual(after.pidStartedAt, realStartedAt, "更不许把陌生进程真实的启动时刻写成旧哨兵的身份");
  assert.equal((await debtRow(monId))?.pidStartedAt ?? null, null, "债表那一份同样不许补");
  assert.notEqual(outcome.state, "closed", "身份补不上不等于线索追空,责任要留在表上");
  assert.equal(aliveAfter, true, "认不出身份就不许动手:陌生进程不能挨刀");
  killTree(pid, "SIGKILL");
}

{
  // ⑬-5 **边条认领走同一条规矩**(同一条不变量的第二个消费点)。台子:一行 pid 还空着的意图行
  //     —— ash 恰好死在「落了身份」和「回填 pid」之间;边条指着一个刚起来的陌生进程,时间锚
  //     与命令文本都对得上。而记号那一问是**精确可答**的那一档,它的回答是「这个号上没有这条
  //     记号」:那是反证,不是「问不出来」,所以这一行只能照实判成认不回来。
  const taskId = await makeTask();
  const unitToken = `unit-adopt-disproved-${process.pid}-${Date.now()}`;
  const stranger = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true, stdio: "ignore", env: { PATH: process.env.PATH! },
  });
  stranger.unref();
  const pid = stranger.pid!;
  const monId = await insertMonitorRow(taskId, {
    status: "running", pidStartedAt: null, command: process.execPath, unitToken,
  });
  const row = (await db.select().from(monitors).where(eq(monitors.id, monId))).at(0)!;
  assert.equal(row.pid, null, "台子前提:这一行的 pid 还空着");
  writeFileSync(monitorSpawnIdentityPath(row.logPath!), JSON.stringify({ pid, spawnedAtMs: Date.now() }));
  // 这一遍扫描只看得见这一个号,它身上没有任何记号 ⇒ 「这条记号不在任何活着的号上」。
  await dbClient.execute(`UPDATE monitors SET status = 'stopped' WHERE id <> '${monId}'`);
  fakeProc(pid, { tokensOnEnvRead: () => [], genOnStatRead: () => "111" });
  const result = await reattachMonitors();
  await new Promise((done) => setTimeout(done, 2_500));
  const aliveAfter = isPidAlive(pid);
  realProc();
  const adopted = (await db.select().from(monitors).where(eq(monitors.id, monId))).at(0)!;
  assert.equal(adopted.pid, null, "反证之后不许把这个号认成这条哨兵的身份");
  assert.equal(adopted.pidStartedAt, null, "也不许给它补一份启动时刻");
  assert.equal(result.attached, 0, "更不许把它当成接回来了");
  assert.equal(adopted.status, "lost", "照实写掉:认不回来");
  assert.equal(aliveAfter, true, "陌生进程不许被这一行牵连");
  killTree(pid, "SIGKILL");
}

await teardown();

console.log("✓ 另一个变量值里的记号文字既不签发凭证也不让陌生进程挨刀（两种证据等级各按自己的事实判）/ 销毁前留档失败时任务与身份都保留、删除整笔失败，故障撤掉后留档真的落盘 / 第一刀记下的成员名单带代次，两秒后核代次再补刀，忽略 TERM 的后代照样收掉 / 记号证明过的那一代已换掉时，实时回收与边条认领都不许退回时间锚把陌生进程认成旧身份 均受回归保护");
