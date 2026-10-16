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
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { eq } from "drizzle-orm";
import {
  db, insertMonitorRow, isPidAlive, makeTask, monitors, schema, startMonitor, stopMonitor,
  tasks, teardown, until,
} from "./monitors-fixture.js";
import { STUBBORN, debtRow } from "./monitor-reclaim-fixture.js";
import { processUnitEvidence } from "../src/proc.js";
import { monitorUnitProofGrade } from "../src/monitor-unit-scan.js";

const { stopMonitorsForTask } = await import("../src/monitor-reclaim.js");
const { deleteTaskCompletely } = await import("../src/task-delete-routes.js");
const { sweepMonitorReclaimDebts } = await import("../src/monitor-reclaim-debts.js");
const { reclaimState } = await import("../src/monitor-reclaim-evidence.js");
const { isProcessGroupAlive, killTree } = await import("../src/platform.js");
const { invalidateMonitorUnitScan } = await import("../src/monitor-unit-scan.js");
const { dbClient } = await import("../src/db/index.js");

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

await teardown();
console.log("✓ 另一个变量值里的记号文字既不签发凭证也不让陌生进程挨刀（两种证据等级各按自己的事实判）/ 销毁前留档失败时任务与身份都保留、删除整笔失败，故障撤掉后留档真的落盘 / 第一刀记下的成员名单带代次，两秒后核代次再补刀，忽略 TERM 的后代照样收掉 均受回归保护");
