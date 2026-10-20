// **创建意图行的责任接管** —— 第 19 轮审查 F2 的回归。
//
// 现场:身份先落库、进程后起、pid 回填(创建协议见 monitor-create.ts 文件头)。ash 恰好死在
// 「落了身份」和「回填 pid」之间时,库里剩下的就是一行 `running` + `pid IS NULL` + 一份身份
// 边条。那一行的**结局从没被确认过** —— 命令可能正在跑。
//
// 上一版把「这一刻认不回来」(反证账本那一句 SELECT 失败)和「当初那个壳一定不在了」写成了同一
// 个终态:行落成 `lost`、pid 留空。而**那一档此后谁都不会再问第二遍**:启动只选 `running`、
// 回收层见 pid 空就返回「没有进程、也没有责任」、删除按 pid 非空过滤。于是审查实测到:
// 第二次启动 `attached=0`、开机清扫 0 条、债表为空,把任务删掉之后诊断进程仍然活着 ——
// 而卡片上那句「下一次启动会再问一遍」是假话。
//
// 所以这里钉三件事:
//  ① **「这一刻认不回来」不是终态**:行原样留着(`running`、pid 仍空、话写在卡片上),既不算
//     接回来、也不算没了(`pending` 那一档),而且**一个信号都不发** —— 边条上那个候选号没通过
//     认领,它只是线索,不是下刀授权;
//  ② 故障撤掉之后**同一条路自己认得回来**:不许靠手工把状态改回 `running` 来补上生产缺的那
//     一步(上一版的回归正是这么写的,于是缺陷被台子遮住了);
//  ③ 销毁与开机清扫**按意图责任枚举**:pid 还空着的行是最该核的一档 —— 删除之前那一问要问
//     得到它,责任落不下来就不许删;「创建没走完」那种 `lost` + pid 空 + 边条还在的行,开机
//     也要重新问一遍。
//
// 收尾交接那一族(点停插进来、终态没落上)在 `test-monitor-settle-handover.ts`,台子共用
// `monitor-intent-fixture.ts`。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { closeSync, openSync, writeFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import {
  db, detachAllMonitors, insertMonitorRow, isPidAlive, makeTask, monitors, tasks, teardown, until,
} from "./monitors-fixture.js";
import {
  EXACT_MARKS, failSidecarRead, intentRow, markedProcess, readRow, reapStrays, strays,
  withLedgerReadFailure,
} from "./monitor-intent-fixture.js";
import { debtRow } from "./monitor-reclaim-fixture.js";
import { processUnitEvidence } from "../src/proc.js";
import { invalidateMonitorUnitScan } from "../src/monitor-unit-scan.js";

const { deleteTaskCompletely } = await import("../src/task-delete-routes.js");
const { reclaimUnconfirmedStops } = await import("../src/monitor-reclaim.js");
const { killTree } = await import("../src/platform.js");
const { dbClient } = await import("../src/db/index.js");
const { monitorSpawnIdentityPath } = await import("../src/monitor-spawn.js");
const { isSupervised, reattachMonitors } = await import("../src/monitors.js");

try {
  // ① 这一刻认不回来 ⇒ **创建意图原样留着**,不是终态。
  const taskId = await makeTask({ status: "running" });
  const token = `intent-pending-${process.pid}-${Date.now()}`;
  const pid = markedProcess(token);
  assert.notEqual(processUnitEvidence(token, { fresh: true }).verdict, "none",
    "台子前提:记号那一问看得见这个进程(它真的带着这条记号)");
  const mon = await intentRow(taskId, token, pid);
  const [first, injected] = await withLedgerReadFailure(() => reattachMonitors());
  assert.equal(injected, 1, "台子前提:那一句 SELECT 真的失败了一次");
  const pendingRow = (await readRow(mon))!;
  assert.equal(pendingRow.status, "running",
    "**「这一刻核实不了」不许落成终态** —— 落成 lost + pid 空就再没人问第二遍了");
  assert.equal(pendingRow.pid, null, "更不许把一个没通过认领的候选号写上去");
  assert.match(pendingRow.endedReason ?? "", /核实不了/,
    "话要留在卡片上:running 的行也显示这一列,所以刷新页面仍看得出「它卡在认领这一步」");
  // `handoff` 三项分列而不是一个计数：「补发了几条」证不出「有没有没送出去的」——
  // 把 dropped/failed 混进同一个数字，失败就会被成功的条数盖掉（第 2 轮审查 N2）。
  assert.deepEqual(
    first,
    { attached: 0, lost: 0, pending: 1, failed: 0, handoff: { delivered: 0, dropped: 0, failed: 0 } },
    "既不算接回来、也不算没了:混进任何一边都是撒谎（这里刻意逐项列全,新开一类计数就得"
    + "在这儿现身,免得「接不回来」被悄悄算进别的格子）");
  assert.equal(await debtRow(mon), undefined,
    "这一刻不记回收债:债是补刀授权,而这一行的进程多半正常跑着");
  assert.equal(isPidAlive(pid), true, "候选号一个信号都不授权");

  // ② 故障撤掉 ⇒ **ash 自己把它认回来**(第 20 轮审查 F2)。上一版这里是台子再跑一次
  //    `reattachMonitors()`,那只能证明「下一次启动还会问」,证不出产品在这一次启动周期里
  //    自己会问 —— 而审查实测到的正是后者:等 31 秒结果早就出来了,行还停在「在等」。
  await until("恢复梯子自己把身份认回来", async () => (await readRow(mon))?.pid === pid, 20_000);
  const adopted = (await readRow(mon))!;
  assert.equal(adopted.pid, pid, "「它自己会再问一遍」不是一句空话");
  assert.equal(adopted.status, "running", "认回来之后它照旧在盯");
  assert.equal(adopted.endedReason, null,
    "**受阻那句话要跟着撤掉**(第 21 轮审查 N1):等待条已经恢复「有事件会叫醒」,面板还写着"
    + "「这一刻认不回它、正在重问」就是两句话打架");
  if (!EXACT_MARKS) {
    assert.equal(adopted.pidStartedAt, null, "**只认号、不认启动时刻** —— 猜出来的身份不配当下刀凭证");
  }
  assert.equal(isPidAlive(pid), true, "认下号这件事本身不发任何信号");
  killTree(pid, "SIGKILL");
  await until("台子自己把 ① 的进程收掉", async () => !isPidAlive(pid));

  // ③ 销毁之前那一问**问得到 pid 还空着的意图行**:行删了,责任还在盘上。
  const taskId2 = await makeTask({ status: "running" });
  const token2 = `intent-delete-${process.pid}-${Date.now()}`;
  const pid2 = markedProcess(token2);
  const mon2 = await intentRow(taskId2, token2, pid2);
  // 写成「创建没走完」那一档(`settleIntentRow` 的 lost:pid 还空着、边条照旧留着)。**不是**
  // running,否则销毁那条路会先走一遍点停(`signalStop` → `finish` 里也有同一问),就量不到
  // 「销毁前核对」这一关自己有没有看见它。
  await db.update(monitors)
    .set({ status: "lost", endedReason: "创建还没完成，这条哨兵已经被停掉了" })
    .where(eq(monitors.id, mon2));
  await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, taskId2));
  await deleteTaskCompletely(taskId2);
  assert.equal(await readRow(mon2), undefined, "台子前提:哨兵行跟着任务一起删掉了");
  const debt = await debtRow(mon2);
  assert.ok(debt, "**删除之前要先拿到持久交接** —— 上一版这里按 pid 非空过滤,整条跳过了它");
  assert.equal(debt!.pid, pid2, "落点是边条上那个号:行删掉之后它是这次创建唯一的线索");
  assert.equal(debt!.unitToken, token2, "记号也得跟着这一笔落盘,不然整项退出再也证不出来");
  if (EXACT_MARKS) {
    await until("记号读得到真实环境项 ⇒ 删除顺手把它收掉", async () => !isPidAlive(pid2));
  } else {
    assert.equal(isPidAlive(pid2), true, "粗档证不出排他归属 ⇒ 只记责任、不下刀(第 19 轮审查 F1)");
  }

  // ④ 开机清扫也问得到它:「创建没走完」写成 lost 时并不撤边条(见 `settleIntentRow`)。
  const taskId3 = await makeTask({ status: "running" });
  const token3 = `intent-sweep-${process.pid}-${Date.now()}`;
  const pid3 = markedProcess(token3);
  const mon3 = await intentRow(taskId3, token3, pid3);
  await db.update(monitors)
    .set({ status: "lost", endedReason: "创建还没完成，这条哨兵已经被停掉了" })
    .where(eq(monitors.id, mon3));
  await reclaimUnconfirmedStops();
  assert.ok(await debtRow(mon3),
    "**pid 空着不等于没有责任**:上一版这一问按 `pid IS NOT NULL` 过滤,它一条都捞不到");

  // ⑤ **接回来之后真的在盯**:tail 接上了、期限也有人管(第 20 轮审查 F2)。
  //    审查实测的现场:日志里早就有结果、约定期限也过了,行却停在 `running/offset=0/events=0`,
  //    一条待发消息都没有 —— 「保留运行态」被当成了「恢复了监听」。
  const taskId5 = await makeTask({ status: "running" });
  const token5 = `intent-supervise-${process.pid}-${Date.now()}`;
  const mon5 = await insertMonitorRow(taskId5, {
    status: "running", pidStartedAt: null, command: process.execPath, unitToken: token5,
  });
  const row5 = (await readRow(mon5))!;
  // 被盯进程照生产的样子把输出写进这一行自己的日志文件。
  const logFd = openSync(row5.logPath, "a");
  const child5 = spawn(
    process.execPath,
    ["-e", 'setTimeout(() => console.log("READY_FROM_REAL_PROCESS"), 300); setInterval(() => {}, 1000)'],
    { detached: true, stdio: ["ignore", logFd, logFd], env: { PATH: process.env.PATH!, ASH_MONITOR_UNIT: token5 } },
  );
  closeSync(logFd);
  child5.unref();
  invalidateMonitorUnitScan();
  strays.push(child5.pid!);
  writeFileSync(monitorSpawnIdentityPath(row5.logPath), JSON.stringify({ pid: child5.pid!, spawnedAtMs: Date.now() }));
  // 期限贴近:梯子第一档(1 秒)认回来之后,到期这件事该由接上的运行时自己兜住。
  await db.update(monitors)
    .set({ timeoutMs: 2_500, expiresAt: new Date(Date.now() + 2_500).toISOString() })
    .where(eq(monitors.id, mon5));
  await dbClient.execute(`UPDATE monitors SET status = 'stopped' WHERE id <> '${mon5}'`);
  const [first5, injected5] = await withLedgerReadFailure(() => reattachMonitors());
  assert.equal(injected5, 1, "台子前提:那一句 SELECT 真的失败了一次");
  assert.equal(first5.pending, 1, "台子前提:这一行落在「这一刻认不回来」那一档");
  await until("到期这件事自己兜住了（不靠用户再重启一次）", async () => {
    const row = await readRow(mon5);
    return row?.status === "expired";
  }, 25_000);
  const supervised = (await readRow(mon5))!;
  assert.ok(supervised.offset > 0, "**日志要真的被读过**:接回来不接 tail,等于结果永远到不了任务头上");
  assert.ok(supervised.events > 0, "产出的那几行照常算事件");

  // ⑥ 梯子问出来的是**反证**时,它照实把这一行写掉,不会无限「在等」。
  const taskId6 = await makeTask({ status: "running" });
  const token6 = `intent-disproved-${process.pid}-${Date.now()}`;
  const gone = markedProcess(token6);
  killTree(gone, "SIGKILL");
  await until("台子先把它收掉", async () => !isPidAlive(gone));
  invalidateMonitorUnitScan();
  assert.equal(processUnitEvidence(token6, { fresh: true }).verdict, "none",
    "台子前提:记号那一问现在是反证(这一次创建的记号在谁身上都找不到)");
  const mon6 = await intentRow(taskId6, token6, gone);
  // 故障源用「边条这一次读不出来」:记号那一问已经反证了这个号,反证账本那一句 SELECT
  // 根本走不到(authorizeRecoveredIdentity 先问记号),拿它当故障源第一问就直接出结论了。
  const fault6 = failSidecarRead(monitorSpawnIdentityPath((await readRow(mon6))!.logPath), { once: true });
  const first6 = await reattachMonitors();
  assert.equal(fault6.reads(), 1, "台子前提:那一个文件的读真的失败了一次");
  assert.equal(first6.pending, 1, "台子前提:第一问被那次读失败挡住了");
  await until("梯子拿到反证之后照实写掉", async () => {
    const row = await readRow(mon6);
    return row?.status === "lost";
  }, 25_000);
  assert.match((await readRow(mon6))!.endedReason ?? "", /反证|没有真正开工/,
    "措辞照实:这一档是「那个号不是它」,不是「核实不了」");
  assert.equal(isSupervised(mon6), false,
    "**判掉的同时把运行时交接掉**(第 22 轮审查 N2):接回层给每条运行行都先立了 tail 和期限,"
    + "判完还留着它就是让一条已经写成终态的行继续占文件句柄、继续算自己的期限");

  // ⑦ **身份边条这一刻读不出来 ≠ 没有边条**(第 20 轮审查 F1)。审查实测:注入一次 EIO,
  //    删除照样返回成功,任务行、哨兵行、债表同时为 0,而那条命令还在后台跑着。
  const taskId7 = await makeTask({ status: "running" });
  const token7 = `intent-unreadable-${process.pid}-${Date.now()}`;
  const pid7 = markedProcess(token7);
  const mon7 = await intentRow(taskId7, token7, pid7);
  const row7 = (await readRow(mon7))!;
  const sidecar7 = monitorSpawnIdentityPath(row7.logPath);
  let eioReads = 0;
  /** 这一段里那一个文件一直读不出来(⑥ 那边是只失败一次)。 */
  const withSidecarEIO = async <T>(run: () => Promise<T>): Promise<T> => {
    const fault = failSidecarRead(sidecar7);
    try { return await run(); } finally { eioReads += fault.reads(); fault.restore(); }
  };

  // ⑦-a 接回:读不出来 ⇒ 落「这一刻认不回来」那一档,**不是** lost。
  const first7 = await withSidecarEIO(() => reattachMonitors());
  assert.ok(eioReads > 0, "台子前提:那一个文件的读真的失败了");
  assert.equal(first7.pending, 1, "读不出来 ⇒ 什么都不许声称,行原样留着");
  assert.match((await readRow(mon7))!.endedReason ?? "", /读不出来/, "措辞要说清是读不出来");
  // 下面三关量的是**判据本身**(删除、开机清扫各自怎么读这一档),所以把恢复梯子摘掉 ——
  // 故障一撤它 1 秒后就会把号认回来,那条路由 ②/⑥ 自己的台子负责。
  detachAllMonitors();

  // ⑦-b 删除:读不出来时**不许放行** —— 删除整笔中止,任务和行都留着。
  await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, taskId7));
  await withSidecarEIO(async () => {
    await assert.rejects(
      () => deleteTaskCompletely(taskId7),
      /不能销毁它们的身份记录/,
      "**读失败不许被折成「没有责任」**:销毁前拿不到持久交接就要整笔中止（删除可以重试，"
      + "留下一个谁都找不到的后台进程不可逆）",
    );
  });
  assert.ok(await readRow(mon7), "行留着");
  assert.equal((await db.select().from(tasks).where(eq(tasks.id, taskId7))).length, 1, "任务也留着");
  assert.equal(isPidAlive(pid7), true, "一个信号都没发");

  // ⑦-c 开机清扫:非运行态 + pid 空 + 边条读不出来 ⇒ 照旧要被重新问一遍(上一版按
  //      `readSpawnIdentity(...) !== null` 过滤,这一类行一条都捞不到)。
  await db.update(monitors).set({ status: "lost" }).where(eq(monitors.id, mon7));
  // 只留这一行给清扫去数 —— 前面几节留下的行也有「退出没确认」的,`>= 1` 那种写法无论这一行
  // 有没有被看见都成立(实测:把过滤改回「边条读得出来才算」,那条断言照旧绿)。
  await dbClient.execute(`DELETE FROM monitors WHERE id <> '${mon7}'`);
  const swept = await withSidecarEIO(() => reclaimUnconfirmedStops());
  assert.equal(swept, 1, "**读不出来也算「结局没确认」**:开机这一问必须看得见它");

  // ⑦-d 故障过去 ⇒ 同一条删除路照旧走得通,而且责任真的落盘。
  await deleteTaskCompletely(taskId7);
  assert.equal(await readRow(mon7), undefined, "这一次行跟着任务删掉了");
  const debt7 = await debtRow(mon7);
  assert.ok(debt7, "责任落在盘上(行删掉之后它是唯一的线索)");
  assert.equal(debt7!.pid, pid7, "落点是边条上那个号");

  // ⑧ **认领可以有界,监听寿命不行**(第 21 轮审查 F1)。审查实测的现场:梯子是这一行唯一的
  //    监督者,于是某一跳 await 抛错、或者五档问完仍认不回来,日志和期限就一起没人管了 ——
  //    故障早就过去、结果早就写进日志、期限也过了,行还停在 `running/offset=0/events=0`,
  //    待发 0 条。这里把边条**一直**读不出来(= 每一跳都认不回来)摆出来,钉的是:到期照样
  //    收得掉、日志照样补读补推,而且**一个信号都不因此多发**。
  const taskId8 = await makeTask({ status: "running" });
  const token8 = `intent-lifetime-${process.pid}-${Date.now()}`;
  const mon8 = await insertMonitorRow(taskId8, {
    status: "running", pidStartedAt: null, command: process.execPath, unitToken: token8,
  });
  const row8 = (await readRow(mon8))!;
  const fd8 = openSync(row8.logPath, "a");
  const child8 = spawn(
    process.execPath,
    ["-e", 'setTimeout(() => console.log("READY_FROM_REAL_PROCESS"), 300); setInterval(() => {}, 1000)'],
    { detached: true, stdio: ["ignore", fd8, fd8], env: { PATH: process.env.PATH!, ASH_MONITOR_UNIT: token8 } },
  );
  closeSync(fd8);
  child8.unref();
  invalidateMonitorUnitScan();
  strays.push(child8.pid!);
  writeFileSync(monitorSpawnIdentityPath(row8.logPath), JSON.stringify({ pid: child8.pid!, spawnedAtMs: Date.now() }));
  await db.update(monitors)
    .set({ timeoutMs: 2_500, expiresAt: new Date(Date.now() + 2_500).toISOString() })
    .where(eq(monitors.id, mon8));
  await dbClient.execute(`UPDATE monitors SET status = 'stopped' WHERE id <> '${mon8}'`);
  const fault8 = failSidecarRead(monitorSpawnIdentityPath(row8.logPath));
  try {
    const first8 = await reattachMonitors();
    assert.equal(first8.pending, 1, "台子前提:这一行落在「这一刻认不回来」那一档");
    await until("**到期这件事不归认领管**：号一次都没认回来，期限照样有人兜住", async () => {
      const row = await readRow(mon8);
      return row?.status === "expired";
    }, 25_000);
    const expired = (await readRow(mon8))!;
    assert.ok(fault8.reads() >= 2, "台子前提:启动那一问 + 梯子至少又问了一次,每次都读不出来");
    assert.ok(expired.offset > 0 && expired.events > 0,
      "日志照常补读补推 —— 结果已经在文件里,认不回号不是让它烂在那儿的理由");
    assert.match(expired.endedReason ?? "", /盯满了约定的时长/, "到期就照实说到期");
    assert.doesNotMatch(expired.endedReason ?? "", /一个信号都没发/,
      "**不许凭上一份拒绝推断这一刻的事实**(第 21 轮审查 N3):到期那一问会重新取证,"
      + "发没发信号只能按真实回收结果说 —— 所以这一句干脆不写进文案");
    assert.equal(isPidAlive(child8.pid!), true, "认不回号 ⇒ 一个信号都不发(下刀资格在取证层)");
  } finally { fault8.restore(); }

  console.log(
    "✓ 创建意图的责任接管：认不回来时行原样留着且一刀不发 / 故障撤掉后 ash 自己认得回来、"
    + "接上日志与期限 / 问出反证就照实写掉(并把运行时一起交接掉) /"
    + " 删除前那一问问得到 pid 还空着的意图行、责任落盘才许删 / 开机清扫按边条把它重新问一遍 /"
    + " 边条读不出来既不算没有边条也不算没有责任（接回、删除、开机三处同判）/"
    + " 认领有界而监听寿命不随它耗尽（号一次都没认回来也照样到期、照样补读）"
    + " 均受回归保护",
  );
} finally {
  detachAllMonitors();   // 连恢复梯子一起撤:库马上要关了,别让它醒过来对着关了的库发问
  await reapStrays();
  await teardown();
}
