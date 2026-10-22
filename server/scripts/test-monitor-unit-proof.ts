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
//
// ⑬-6/⑬-7 **反证要活过整条链**(第 17 轮审查 F1)。上一版把反证只放在一次函数调用的返回值
//     里,而且只认代次 `changed` 这一种;于是**首次拒绝成功、随后的 settle、产品自己的重试
//     梯子、开机清扫全都把它忘了** —— 记号这一问退化成 `none`(或 `ours` 名单里没有这个号)
//     时被当成「没答出来」,时间锚 + 命令包含那条弱判据照样放行,同号新进程真实的启动时刻
//     被写成旧哨兵的身份并收到真实 SIGKILL(`round-7/refutation-retry.log`、
//     `refutation-auto.log`)。所以这两条跑的是整条链,而不是加长第一次调用后的等待。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import {
  db, insertMonitorRow, isPidAlive, makeTask, monitors, schema, startMonitor, stopMonitor,
  tasks, teardown, until,
} from "./monitors-fixture.js";
import { STUBBORN, debtRow } from "./monitor-reclaim-fixture.js";
import { install as fakeProc, restore as realProc, skipWithoutProcWorld, type FakeAnswers } from "./fake-proc-fixture.js";
if (skipWithoutProcWorld("记号凭证回归")) process.exit(0);
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
const { noteReclaimDebt, reclaimMonitorProcess, settleReclaim } = await import("../src/monitor-reclaim-debts.js");
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

{
  // ⑬-6 **整条链上反证都在**:首次回收 → settle → 产品自己的 1 秒梯子 → 开机清扫,四段里
  //     陌生进程一直活着、库里一个字的假身份都没有。最后一段反过来钉住**反证只收走弱判据、
  //     不封死强凭证**:真实带着这次记号的后代落到同一个号上时,它自己的证据照旧能把它收掉。
  const taskId = await makeTask({ status: "done" });
  const unitToken = `unit-chain-${process.pid}-${Date.now()}`;
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
  assert.ok(realStartedAt, "台子前提:陌生进程此刻真的在跑,时间锚与命令文本都对得上它");
  const startedAtOf = async () => (await db.select().from(monitors)
    .where(eq(monitors.id, monId))).at(0)!.pidStartedAt;
  fakeProc(pid, {
    tokensOnEnvRead: (n) => (n <= 2 ? [unitToken] : []),
    genOnStatRead: (n) => (n <= 4 ? "111" : "999"),
  });
  assert.deepEqual(processUnitEvidence(unitToken, { fresh: true }), {
    verdict: "ours", members: [{ pid, gen: "j:111" }],
  }, "台子前提:记号那一问先在 j:111 这一代上证明过这个号");

  const first = await reclaimMonitorProcess(
    { ...row, logPath: row.logPath }, "审查:换代之后整条链",
  );
  assert.notEqual(first.state, "closed", "第一段:身份补不上不等于线索追空");
  assert.equal(await startedAtOf(), null, "第一段:不许靠时间锚补身份");
  assert.ok((await debtRow(monId))?.identityDisprovedAt, "第一段:反证要钉在盘上,不能只活在返回值里");

  // 之后记号就没了(换代同时发生),这一问从 `ours` 退化成 `none` —— 上一版正是在这里把反证
  // 忘掉的,所以后面三段都要重新确认它仍然被拒。
  assert.deepEqual(processUnitEvidence(unitToken, { fresh: true }), { verdict: "none" },
    "台子前提:记号已经不在任何活着的号上");
  await settleReclaim(first, 0);
  await new Promise((done) => setTimeout(done, 1_800));   // 产品自己那条 1 秒梯子跑一遍
  assert.equal(await startedAtOf(), null, "第二段(settle + 产品重试梯子):仍然不许补");
  assert.equal((await debtRow(monId))?.pidStartedAt ?? null, null, "第二段:债表那一份也不许补");
  assert.equal(isPidAlive(pid), true, "第二段:陌生进程不许挨刀");

  await sweepMonitorReclaimDebts();                        // 开机清扫走的是同一个补全入口
  assert.equal(await startedAtOf(), null, "第三段(开机清扫):重启之后反证照样在");
  assert.notEqual(await startedAtOf(), realStartedAt, "第三段:更不许把陌生进程的启动时刻写进来");
  assert.equal(isPidAlive(pid), true, "第三段:陌生进程仍然活着");

  // 第三段之二:记号这一问**退化成「答不出来」**(这份环境是哪一代读到的证不出来)。盘上那条
  // 反证正是为这一刻存在的 —— 没有它,弱判据会在这里重新授信,而「问不出来」照定义是允许走
  // 弱判据的那一档(第 10 轮 F2-B),单靠「每次重新问一遍」堵不住。
  fakeProc(pid, {
    tokensOnEnvRead: () => [unitToken],
    genOnStatRead: (n) => (n % 2 === 1 ? "111" : "222"),   // 前后两次戳对不上 ⇒ 这一代证不出来
  });
  assert.deepEqual(processUnitEvidence(unitToken, { fresh: true }), { verdict: "unprovable" },
    "台子前提:记号这一问已经退化成「答不出来」");
  await sweepMonitorReclaimDebts();
  assert.equal(await startedAtOf(), null, "第三段之二:退化成「答不出来」不许把已经确认的反证抹掉");
  assert.equal(isPidAlive(pid), true, "第三段之二:陌生进程仍然活着");

  // 第四段:这个号上现在真的有一个带着这次记号的进程(代次前后一致)⇒ 强凭证成立。
  // 盘上那条反证只收走弱判据,**不许连这一份独立证据一起封掉** —— 自有资源还得收得掉。
  fakeProc(pid, { tokensOnEnvRead: () => [unitToken], genOnStatRead: () => "777" });
  await sweepMonitorReclaimDebts();
  await until("第四段:自有资源照旧收得掉", async () => !isPidAlive(pid), 10_000);
  assert.equal(await startedAtOf(), realStartedAt, "第四段:签下来的身份就是强凭证那一问的读数");
  realProc();
}

{
  // ⑬-7 **`ours` 名单里没有这个号,也是反证**(第 17 轮审查点明「未单独实测,按代码推断」的
  //     那一支)。台子:记号确实在一个活着的号上(A),而这条记录指着另一个号(B);B 真的在
  //     两秒窗口里起来、命令文本也真的包含记录的那一段 —— 弱判据这一刻完全成立。
  const taskId = await makeTask({ status: "done" });
  const unitToken = `unit-missing-root-${process.pid}-${Date.now()}`;
  const born = () => spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true, stdio: "ignore", env: { PATH: process.env.PATH! },
  });
  const holder = born(); holder.unref();
  const other = born(); other.unref();
  const holderPid = holder.pid!;
  const pid = other.pid!;
  const anchorMs = Date.now();
  const monId = await insertMonitorRow(taskId, {
    status: "stopped", pid, pidStartedAt: null, command: process.execPath, unitToken,
  });
  const row = (await db.select().from(monitors).where(eq(monitors.id, monId))).at(0)!;
  writeFileSync(monitorSpawnIdentityPath(row.logPath!), JSON.stringify({ pid, spawnedAtMs: anchorMs }));
  // 台子只造 A 这一个「Linux 进程」,记号读在它身上 ⇒ 名单是 [A],里面没有 B。
  fakeProc(holderPid, { tokensOnEnvRead: () => [unitToken], genOnStatRead: () => "111" });
  assert.deepEqual(processUnitEvidence(unitToken, { fresh: true }), {
    verdict: "ours", members: [{ pid: holderPid, gen: "j:111" }],
  }, "台子前提:记号在 A 身上,名单里没有 B");
  const outcome = await reclaimMonitorProcess({ ...row, logPath: row.logPath }, "审查:名单里没有这个号");
  await new Promise((done) => setTimeout(done, 2_500));
  const aliveAfter = isPidAlive(pid);
  realProc();
  const after = (await db.select().from(monitors).where(eq(monitors.id, monId))).at(0)!;
  assert.equal(after.pidStartedAt, null, "名单里没有这个号 ⇒ 反证,不许靠时间锚补身份");
  assert.equal((await debtRow(monId))?.pidStartedAt ?? null, null, "债表那一份同样不许补");
  assert.notEqual(outcome.state, "closed", "认不出身份不等于线索追空");
  assert.equal(aliveAfter, true, "B 不许挨刀");
  killTree(pid, "SIGKILL");
  killTree(holderPid, "SIGKILL");
}

{
  // ⑬-8 **展示文本那一档 + 时间锚贴着 + 命令对得上,仍然一刀不发**(第 18 轮审查 F1 实测 A)。
  //
  //    跟 ⑬-1 的区别在**这一行指着谁**:⑬-1 的行指着一个早就退干净的历史号,所以那条路上
  //    本来就没有可打的对象;这里**行上的 pid 就是那个活着的陌生进程**,时间锚贴着它真实的
  //    启动时刻、记录的命令文本也真的包含它的命令 —— 弱判据这一刻全部成立。上一版于是把它
  //    真实的启动时刻补进 `pid_started_at`,而 `reclaimEvidence` 第 ② 步拿这一列当归属凭证
  //    (根活着 + 时刻对得上 ⇒ `ours-alive` ⇒ 可以下刀),它分不出这个值是 ash 自己 spawn 那
  //    一刻读来的还是事后猜出来的,于是产品真实的停止链把陌生进程杀了
  //    (`cgtxRDWnCNVp/round-1/identity-ambiguous.log`)。
  const taskId = await makeTask({ status: "done" });
  const unitToken = `unit-textonly-${process.pid}-${Date.now()}`;
  // 诊断进程:**没有 `ASH_MONITOR_UNIT` 这个键**,只是另一个变量的值里抄着这段文字。
  const stranger = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore",
    env: {
      PATH: process.env.PATH ?? "",
      MONITOR_DIAGNOSTIC: `saved old monitor: ${"ASH_MONITOR_UNIT"}=${unitToken} end`,
    },
  });
  stranger.unref();
  const pid = stranger.pid!;
  const anchorMs = Date.now();
  invalidateMonitorUnitScan();
  await until("陌生进程起来了", async () => isPidAlive(pid));
  const realStartedAt = inspectProcessSync(pid)?.startedAt ?? null;
  assert.ok(realStartedAt, "台子前提:它此刻真的在跑(所以弱判据那一问答得出来)");
  assert.equal(processUnitEvidence(unitToken, { fresh: true }).verdict,
    EXACT_MARKS ? "none" : "suspected",
    EXACT_MARKS ? "台子前提:真实环境项里没有这一项 ⇒ 反证" : "台子前提:只看得见展示文本 ⇒ 这一问没答出来");

  const monId = await insertMonitorRow(taskId, {
    status: "stopped", pid, pidStartedAt: null, command: process.execPath, unitToken,
  });
  const row = (await db.select().from(monitors).where(eq(monitors.id, monId))).at(0)!;
  writeFileSync(monitorSpawnIdentityPath(row.logPath!), JSON.stringify({ pid, spawnedAtMs: anchorMs }));
  assert.equal(reclaimState(pid, null, row), "unverifiable",
    "台子前提:启动时刻空着的时候这一档本来就一刀不发 —— 所以上一版必须先把它「补全」才打得出去");

  await stopMonitor(monId, "再点一次停止");
  await new Promise((done) => setTimeout(done, 2_500));   // 产品自己那条 1 秒梯子也跑一遍
  const after = (await db.select().from(monitors).where(eq(monitors.id, monId))).at(0)!;
  assert.equal(after.pidStartedAt, null,
    "**猜出来的启动时刻一律不许落库** —— 下游第 ② 步分不出它是读来的还是猜来的");
  assert.notEqual(after.pidStartedAt, realStartedAt, "更不许把陌生进程真实的启动时刻写成这条记录的身份");
  assert.equal((await debtRow(monId))?.pidStartedAt ?? null, null, "债表那一份同样不许补");
  assert.equal(isPidAlive(pid), true, "**一刀都不许下** —— 那是别人的进程");
  const owed = await debtRow(monId);
  assert.ok(owed && !owed.closedAt, "照记责任、不收档:证不出恰恰最该把责任留着");
  killTree(pid, "SIGKILL");
  await until("台子自己收场", async () => !isPidAlive(pid));
  await db.delete(schema.monitorReclaimDebts).where(eq(schema.monitorReclaimDebts.monitorId, monId));
}

{
  // ⑬-9/⑬-10 **反证账本读不出来 ⇒ 这一轮一律不认这个号,但不许把异常写成事实**
  //     (第 18 轮审查 F1 实测 B)。上一版 `readIdentityRefutation` 只有两档:`try` 里拿到值
  //     算「有反证」,`catch` 出一句日志之后**返回「没有反证」** —— 一次 SELECT 异常就把一笔
  //     已经落盘的拒绝洗掉,弱判据重新放行。
  //
  //     消费点选重启后认领那一支(`adoptSpawnIdentity`):它是「refuse」这一档唯一会改变结果的
  //     地方 —— 账本干净时弱判据认得下这个**号**(启动时刻照旧留空),账本上有反证时连号都不
  //     许认。所以读失败被洗成「干净」的后果是:一个被反证过的号重新成为这条记录的身份。
  const taskId = await makeTask({ status: "running" });
  const unitToken = `unit-ledger-${process.pid}-${Date.now()}`;
  const stranger = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true, stdio: "ignore", env: { PATH: process.env.PATH! },
  });
  stranger.unref();
  const pid = stranger.pid!;
  const monId = await insertMonitorRow(taskId, {
    status: "running", pidStartedAt: null, command: process.execPath, unitToken,
  });
  const row = (await db.select().from(monitors).where(eq(monitors.id, monId))).at(0)!;
  assert.equal(row.pid, null, "台子前提:这一行的 pid 还空着,所以走的是重启后认领那一支");
  writeFileSync(monitorSpawnIdentityPath(row.logPath!), JSON.stringify({ pid, spawnedAtMs: Date.now() }));
  await dbClient.execute(`UPDATE monitors SET status = 'stopped' WHERE id <> '${monId}'`);
  // 记号这一问**退化成「答不出来」**:既不授权也不反证,拦住它的只有盘上那一笔。
  fakeProc(pid, {
    tokensOnEnvRead: () => [unitToken],
    genOnStatRead: (n) => (n % 2 === 1 ? "111" : "222"),   // 前后两次戳对不上 ⇒ 这一代证不出来
  });
  assert.deepEqual(processUnitEvidence(unitToken, { fresh: true }), { verdict: "unprovable" },
    "台子前提:记号这一问答不出来(不是反证)");

  /** 只让**那一句** SELECT 抛一次(审查实测用的同一招),别的语句照常。 */
  const withLedgerReadFailure = async <T>(run: () => Promise<T>): Promise<[T, number]> => {
    const original = dbClient.execute;
    let injected = 0;
    dbClient.execute = (async function (statement: unknown, ...rest: unknown[]) {
      const sql = String(typeof statement === "string" ? statement : (statement as { sql?: string })?.sql);
      if (injected === 0 && /^\s*select\s+"identity_disproved_at"\s+from/i.test(sql)) {
        injected += 1;
        throw new Error("fixture: identity-ledger read failure");
      }
      return (original as (...a: unknown[]) => unknown).call(dbClient, statement, ...rest);
    }) as typeof dbClient.execute;
    try { return [await run(), injected]; } finally { dbClient.execute = original; }
  };

  // ⑬-9 盘上**有**一笔反证,而那一句 SELECT 恰好失败 ⇒ 仍然不认这个号。
  assert.equal(await noteReclaimDebt({
    monitorId: monId, taskId, pid, pidStartedAt: null, spawnAnchorMs: Date.now(),
    unitToken, command: process.execPath, reason: "审查:这个号先前被反证过", identityDisproved: true,
  }), true);
  const [first, injectedOnce] = await withLedgerReadFailure(() => reattachMonitors());
  assert.equal(injectedOnce, 1, "台子前提:那一句 SELECT 真的失败了一次");
  const refused = (await db.select().from(monitors).where(eq(monitors.id, monId))).at(0)!;
  assert.equal(refused.pid, null, "**读不出来就什么都不认** —— 一次异常不许把落盘的反证洗掉");
  assert.equal(refused.pidStartedAt, null, "更不许给它补一份启动时刻");
  assert.equal(first.attached, 0, "也不算接回来了");
  // 「这一刻核实不了」**不是终态**(第 19 轮审查 F2):行原样留着,下一次启动/点停/删除都会
  // 再问一遍 —— 整条链的回归在 test-monitor-intent-handover.ts,这里只钉这一行的去处。
  assert.equal(refused.status, "running", "读不出来 ⇒ 创建意图原样留着,不许落成一个再没人问的终态");
  assert.equal(first.pending, 1, "它既不算接回来、也不算没了");
  assert.match(refused.endedReason ?? "", /核实不了|再问一遍/,
    "**措辞也不许撒谎**:核实不了就说核实不了,不许说成「这个号现在是另一个进程」");
  assert.ok((await debtRow(monId))?.identityDisprovedAt, "盘上那一笔原样留着");

  // ⑬-10 盘上**没有**反证、只有那一句 SELECT 失败 ⇒ 这一轮不认,但**不许把读失败记成反证**。
  const taskId2 = await makeTask({ status: "running" });
  const mon2 = await insertMonitorRow(taskId2, {
    status: "running", pidStartedAt: null, command: process.execPath, unitToken,
  });
  const row2 = (await db.select().from(monitors).where(eq(monitors.id, mon2))).at(0)!;
  writeFileSync(monitorSpawnIdentityPath(row2.logPath!), JSON.stringify({ pid, spawnedAtMs: Date.now() }));
  await dbClient.execute(`UPDATE monitors SET status = 'stopped' WHERE id <> '${mon2}'`);
  const [second, injectedAgain] = await withLedgerReadFailure(() => reattachMonitors());
  assert.equal(injectedAgain, 1, "台子前提:这一遍也真的失败了一次");
  assert.equal((await db.select().from(monitors).where(eq(monitors.id, mon2))).at(0)!.pid, null,
    "读不出来 ⇒ 这一轮不认(fail-closed)");
  assert.equal(second.attached, 0, "同上");

  // 故障过去之后,同一条路照旧认得下这个号(只认号、不认启动时刻)。
  //
  // **台子一个字都不许帮它改**(第 19 轮审查 F2):上一版这里先 `UPDATE ... status='running'`
  // 把行扳回来,等于用手工补上生产缺的那一步 —— 而缺的恰恰是「认不回来时不要把行写成终态」,
  // 于是缺陷被台子遮住了。现在这一行本来就还是 running(见上面的 ⑬-9 断言)。
  assert.equal((await db.select().from(monitors).where(eq(monitors.id, mon2))).at(0)!.status, "running",
    "台子前提:上一遍没把它写成终态");
  const third = await reattachMonitors();
  await new Promise((done) => setTimeout(done, 2_500));
  const aliveAfter = isPidAlive(pid);
  realProc();
  const adopted = (await db.select().from(monitors).where(eq(monitors.id, mon2))).at(0)!;
  assert.equal(adopted.pid, pid, "账本读得出来、又没有反证 ⇒ 号还是认得下来(第 9 轮 F3 要的那半句)");
  assert.equal(adopted.pidStartedAt, null, "**只认号、不认启动时刻** —— 猜出来的身份不配当下刀凭证");
  assert.equal(third.attached, 1, "照实算接回来了");
  assert.equal(aliveAfter, true, "认下号这件事本身不发任何信号");
  killTree(pid, "SIGKILL");

  // ⑬-11 **读失败不许被记成一笔反证**。消费点换成实时回收那一侧:只有它会把反证随责任一起
  //     插进盘(`DebtInput.identityDisproved`)。把「读不出来」写成「反证过」是另一个方向的
  //     犯法 —— 它让一笔**从来没有发生过**的拒绝活过重启,此后连强凭证之外的认号都永久不许,
  //     而事实只是某一刻一句 SELECT 失败了。
  const taskId3 = await makeTask({ status: "running" });
  const unitToken3 = `unit-ledger-note-${process.pid}-${Date.now()}`;
  const stranger3 = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true, stdio: "ignore", env: { PATH: process.env.PATH! },
  });
  stranger3.unref();
  const pid3 = stranger3.pid!;
  const mon3 = await insertMonitorRow(taskId3, {
    status: "stopped", pid: pid3, pidStartedAt: null, command: process.execPath, unitToken: unitToken3,
  });
  const row3 = (await db.select().from(monitors).where(eq(monitors.id, mon3))).at(0)!;
  writeFileSync(monitorSpawnIdentityPath(row3.logPath!), JSON.stringify({ pid: pid3, spawnedAtMs: Date.now() }));
  fakeProc(pid3, {
    tokensOnEnvRead: () => [unitToken3],
    genOnStatRead: (n) => (n % 2 === 1 ? "111" : "222"),
  });
  assert.deepEqual(processUnitEvidence(unitToken3, { fresh: true }), { verdict: "unprovable" },
    "台子前提:记号这一问答不出来");
  const [, injectedThird] = await withLedgerReadFailure(() => reclaimMonitorProcess(
    { ...row3, logPath: row3.logPath }, "审查:账本这一刻读不出来",
  ));
  await new Promise((done) => setTimeout(done, 2_500));
  const alive3 = isPidAlive(pid3);
  realProc();
  assert.equal(injectedThird, 1, "台子前提:那一句 SELECT 真的失败了一次");
  const owed3 = await debtRow(mon3);
  assert.ok(owed3 && !owed3.closedAt, "照记责任、不收档");
  assert.equal(owed3!.identityDisprovedAt ?? null, null,
    "**别把异常写成事实** —— 读失败不是反证,不许替它在盘上落一笔");
  assert.equal(owed3!.pidStartedAt ?? null, null, "身份同样不许补");
  assert.equal(alive3, true, "这一轮一刀不发");
  killTree(pid3, "SIGKILL");
}

{
  // ⑬-12 **秒级时刻相等不是排他凭证**(第 19 轮审查 F1 实测 `coarse-identity-risk.log`)。
  //
  //     上一版的最终授权是:根活着 + `pid_started_at` 原文相等 ⇒ `ours-alive` ⇒ 可以下刀,
  //     **记号那一问答什么都不看**。而 POSIX 的 `ps -o lstart` 只到秒:审查起了两个自有诊断
  //     进程,两者的 `lstart` 读数**逐字相同**;库里存着其中一个的读数、pid 指向另一个(模拟
  //     那个号被复用),原进程退出后记号这一问答 `none` —— 产品真实的停止链照样给那个无关进程
  //     发了 SIGKILL。注意这不是把新进程的时刻伪装成旧的:存的就是从原进程读到的值。
  //
  //     现在粗档要**第二份独立证据**:`suspected`(这次的记号文字此刻还看得见)才算;`none`
  //     和「问不出来」一律记责任、不下刀。后半段顺带钉**存量行**(连记号都没有)的同一档。
  const taskId = await makeTask({ status: "done" });
  const unitToken = `unit-coarse-${process.pid}-${Date.now()}`;
  const born = (marked: boolean) => spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore",
    env: { PATH: process.env.PATH ?? "", ...(marked ? { ASH_MONITOR_UNIT: unitToken } : {}) },
  });
  // 两个背靠背起的进程,`lstart` 读数绝大多数时候落在同一秒;跨秒就重来(审查脚本同一招)。
  let original = born(true); original.unref();
  let stranger = born(false); stranger.unref();
  let recorded = inspectProcessSync(original.pid!)?.startedAt ?? null;
  for (let attempt = 0; attempt < 6 && recorded !== (inspectProcessSync(stranger.pid!)?.startedAt ?? null); attempt += 1) {
    killTree(original.pid!, "SIGKILL");
    killTree(stranger.pid!, "SIGKILL");
    original = born(true); original.unref();
    stranger = born(false); stranger.unref();
    recorded = inspectProcessSync(original.pid!)?.startedAt ?? null;
  }
  const pid = stranger.pid!;
  assert.ok(recorded, "台子前提:读得到启动时刻");
  assert.equal(inspectProcessSync(pid)?.startedAt, recorded,
    "台子前提:两个不同进程的 `lstart` 读数逐字相同(这正是粗档的含义)");
  killTree(original.pid!, "SIGKILL");
  await until("带记号的那个退了", async () => !isPidAlive(original.pid!));
  invalidateMonitorUnitScan();
  assert.deepEqual(processUnitEvidence(unitToken, { fresh: true }), { verdict: "none" },
    "台子前提:这次的记号在任何活进程上都读不到了");

  const monId = await insertMonitorRow(taskId, {
    status: "stopped", pid, pidStartedAt: recorded, command: process.execPath, unitToken,
  });
  const row = (await db.select().from(monitors).where(eq(monitors.id, monId))).at(0)!;
  assert.equal(reclaimState(pid, recorded, row), "unverifiable",
    "**粗档 + 记号读不到 ⇒ 记责任、不下刀**:秒级相等分不出「号被复用」和「命令自己清了环境」");
  await stopMonitor(monId, "再点一次停止");
  await new Promise((done) => setTimeout(done, 2_500));   // 产品自己那条 1 秒梯子也跑一遍
  assert.equal(isPidAlive(pid), true, "**一刀都不许下** —— 那是别人的进程,只是撞了同一秒");
  const owed = await debtRow(monId);
  assert.ok(owed && !owed.closedAt, "照记责任、不收档");

  // 后半段:**存量行**(没有记号)同样只到这一档 —— 它连第二份证据的来源都没有。
  const legacyId = await insertMonitorRow(taskId, {
    status: "stopped", pid, pidStartedAt: recorded, command: process.execPath, unitToken: null,
  });
  assert.equal(reclaimState(pid, recorded, { unitToken: null, command: process.execPath }),
    "unverifiable", "存量行的秒级读数同样不授权:旧数据保留责任、不发信号");
  await stopMonitor(legacyId, "再点一次停止");
  await new Promise((done) => setTimeout(done, 2_500));
  assert.equal(isPidAlive(pid), true, "存量行这一档也一刀不发");

  killTree(pid, "SIGKILL");
  await until("台子自己收场", async () => !isPidAlive(pid));
  await db.delete(schema.monitorReclaimDebts).where(eq(schema.monitorReclaimDebts.monitorId, monId));
  await db.delete(schema.monitorReclaimDebts).where(eq(schema.monitorReclaimDebts.monitorId, legacyId));
}

await teardown();

console.log("✓ 另一个变量值里的记号文字既不签发凭证也不让陌生进程挨刀（两种证据等级各按自己的事实判）/ 销毁前留档失败时任务与身份都保留、删除整笔失败，故障撤掉后留档真的落盘 / 第一刀记下的成员名单带代次，两秒后核代次再补刀，忽略 TERM 的后代照样收掉 / 记号证明过的那一代已换掉时，实时回收与边条认领都不许退回时间锚把陌生进程认成旧身份 / 反证活过 settle、产品重试梯子与开机清扫，且只收走弱判据不封死强凭证 / 展示文本那一档就算时间锚贴着、命令也对得上，启动时刻既不落库也一刀不发 / 反证账本读不出来时这一轮什么都不认、措辞照实、也不替它记一笔反证，故障过去后只认号不认启动时刻 / 两个进程撞同一秒时粗档不授权下刀:记号读不到、存量行没记号都只记责任 均受回归保护");
