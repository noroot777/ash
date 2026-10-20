// **收尾交接的那一族回归** —— 第 21、22、23 轮审查钉下来的那几幕,从
// `test-monitor-intent-handover.ts` 拆出来(全局约定:单文件不超过 700 行)。
//
// 共同判据只有一条:**库里还是运行态,就必须有人盯;库里已经是终态,就一个字都不许再改**。
// 它在两个方向上各有一堆现场:
//  · 点停/删除赢了之后,在途的旧回调(认领、判掉、到期)不许改写结局、不许补通知、更不许把
//    运行时重新接上去;
//  · 终态还没落盘之前撤掉的监督(撤必须排在读日志之前),失败时必须交回来 —— 否则行留在
//    running 而日志、期限、探活全没了,结果送不出去、到点也没有结束通知。
//
// 台子在 `monitor-intent-fixture.ts`。幕号接着原来那一份往下排(⑨ 起),审查证据里引的就是
// 这套号,别重编。
import assert from "node:assert/strict";
import { appendFileSync, writeFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import {
  db, detachAllMonitors, insertMonitorRow, isPidAlive, makeTask, monitors, pendingOf, stopMonitor,
  teardown, until,
} from "./monitors-fixture.js";
import {
  failSidecarRead, intentRow, markedProcess, readRow, reapStrays, withLedgerReadFailure,
} from "./monitor-intent-fixture.js";
import { invalidateMonitorUnitScan } from "../src/monitor-unit-scan.js";

const { killTree } = await import("../src/platform.js");
const { dbClient } = await import("../src/db/index.js");
const { monitorSpawnIdentityPath } = await import("../src/monitor-spawn.js");
const {
  attach, finish, finishOffline, isSupervised, pendingSupervisionHandovers, reattachMonitors,
  serialize,
  supervisionComplete, supervisionOf,
} = await import("../src/monitors.js");

try {

  // ⑨ **后台认领不许越过已经完成的停止**(第 21 轮审查 F2)。审查实测:点停已经成功返回
  //    (stopped、待发 0 条、理由是用户明确点停),在途的那次认领回调照旧把行写成 expired
  //    并补推一条结束通知 —— 「await 之前读到的 running」被当成了「await 之后的所有权」。
  const taskId9 = await makeTask({ status: "running" });
  const token9 = `intent-stoprace-${process.pid}-${Date.now()}`;
  const pid9 = markedProcess(token9);
  const mon9 = await intentRow(taskId9, token9, pid9);
  const [first9, injected9] = await withLedgerReadFailure(() => reattachMonitors());
  assert.equal(injected9, 1);
  assert.equal(first9.pending, 1, "台子前提:启动那一问被挡住,梯子挂上了");
  // 把梯子下一跳**挂住**(不是失败):停在反证账本那一问的 await 上,好让点停插到中间 ——
  // 这正是审查复现用的同一个位置。
  let release: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let gated = 0;
  const realExecute = dbClient.execute;
  dbClient.execute = (async function (statement: unknown, ...rest: unknown[]) {
    const sql = String(typeof statement === "string" ? statement : (statement as { sql?: string })?.sql);
    if (gated === 0 && /^\s*select\s+"identity_disproved_at"\s+from/i.test(sql)) {
      gated += 1;
      await gate;
    }
    return (realExecute as (...a: unknown[]) => unknown).call(dbClient, statement, ...rest);
  }) as typeof dbClient.execute;
  try {
    await until("梯子走到了被挂住的那一问", async () => gated === 1, 15_000);
    // 点停:它的第一步(条件落「我停过」)**不排队**,所以这一步立刻落盘;第二步排在梯子后面。
    const stopping = stopMonitor(mon9, "用户点停：不想再被它叫醒");
    await until("点停的第一步已经落盘", async () => (await readRow(mon9))?.status === "stopped");
    const before9 = (await pendingOf(taskId9)).length;
    release!();
    const stopped = await stopping;
    // 排一个空活在同一条队列尾上:轮到它就说明梯子那一跳已经整跳跑完。
    await serialize(`task:${taskId9}`, async () => {});
    assert.equal(stopped?.status, "stopped", "点停的返回值就是最终事实");
    const after9 = (await readRow(mon9))!;
    assert.equal(after9.status, "stopped",
      "**停止赢了就是赢了** —— 在途的旧回调不许把它改写成 expired");
    assert.match(after9.endedReason ?? "", /用户点停/, "卡片上留的是用户点停那句话,不是到期");
    assert.equal((await pendingOf(taskId9)).length, before9,
      "**一条新通知都不许排出去**:用户点停就是为了不再被它叫醒");
    assert.equal(isSupervised(mon9), false,
      "**更不许把运行时重新接上去**:用户停掉的那一行不该再有 tail、期限和探活挂在它身上");
  } finally {
    dbClient.execute = realExecute;
    if (release) release();
  }

  // ⑩ **梯子某一跳自己抛了错,身份这一问不许因此整条掐掉**(第 21 轮审查 F1 的另一半)。
  //    上一版那个 catch 只打印一行日志 —— 库忙了一下、ps 抖了一下都会走到这里,而这一行的
  //    号还没认回来。日志和期限现在另有人管(⑧),但「再问一遍」这件事也得接着做。
  const taskId10 = await makeTask({ status: "running" });
  const token10 = `intent-retry-throw-${process.pid}-${Date.now()}`;
  const pid10 = markedProcess(token10);
  const mon10 = await intentRow(taskId10, token10, pid10);
  const [first10, injected10] = await withLedgerReadFailure(() => reattachMonitors());
  assert.equal(injected10, 1);
  assert.equal(first10.pending, 1, "台子前提:这一行落在「这一刻认不回来」那一档,梯子挂上了");
  // 梯子第一档排在 1 秒后。把**它那一跳读这一行**打掉一次(启动那一遍已经跑完,所以下一条
  // 读 monitors 的语句就是它)。
  let thrown = 0;
  const realExec10 = dbClient.execute;
  dbClient.execute = (async function (statement: unknown, ...rest: unknown[]) {
    const sql = String(typeof statement === "string" ? statement : (statement as { sql?: string })?.sql);
    if (thrown === 0 && /^\s*select\b[\s\S]*from "monitors" where/i.test(sql)) {
      thrown += 1;
      dbClient.execute = realExec10;   // 只打一次:下一跳要读到真东西
      throw new Error("fixture: transient monitors read failure inside the ladder");
    }
    return (realExec10 as (...a: unknown[]) => unknown).call(dbClient, statement, ...rest);
  }) as typeof dbClient.execute;
  // 探针自己**不许**撞上注入条件(它也读 monitors):改成不带 where 的全表读再在 JS 里挑,
  // 否则这一次性故障会被台子自己的那一问吃掉,梯子那一跳反而读到真东西。
  const scanRow = async (id: string) => (await db.select().from(monitors)).find((r) => r.id === id);
  try {
    await until("抛错之后还有下一跳，号最终被认回来", async () => (await scanRow(mon10))?.pid === pid10, 25_000);
    assert.equal(thrown, 1, "台子前提:梯子那一跳真的抛了一次");
  } finally { dbClient.execute = realExec10; }
  assert.equal(isPidAlive(pid10), true, "这一圈里一个信号都没发");

  // ⑪ **写掉那一刻用户点停了** —— 给 `finishOffline` 那条条件更新立一颗牙(第 21 轮审查 F2)。
  //    判 lost 这一路把「这一行还是 running」读在 await 之前,真正的 UPDATE 和那条【哨兵结束】
  //    通知都排在 await 之后;而点停的第一步**不排任何队**(见 stopMonitor 的 ①),所以它恰好
  //    插得进这中间。上一版那条 UPDATE 无条件,于是用户点停的事实被改写成 lost,还补一条通知。
  const taskId11 = await makeTask({ status: "running" });
  const token11 = `intent-writeoff-stoprace-${process.pid}-${Date.now()}`;
  const gone11 = markedProcess(token11);
  killTree(gone11, "SIGKILL");
  await until("台子先把 ⑪ 的进程收掉", async () => !isPidAlive(gone11));
  invalidateMonitorUnitScan();
  const mon11 = await intentRow(taskId11, token11, gone11);
  // 只挂住「写掉」那一条 UPDATE:认它靠绑定参数里的 lost —— 点停落的是 stopped,不会被挂住。
  let release11: (() => void) | null = null;
  const gate11 = new Promise<void>((resolve) => { release11 = resolve; });
  let gated11 = 0;
  const realExec11 = dbClient.execute;
  dbClient.execute = (async function (statement: unknown, ...rest: unknown[]) {
    const sql = String(typeof statement === "string" ? statement : (statement as { sql?: string })?.sql);
    const args = ((statement as { args?: unknown[] })?.args ?? []) as unknown[];
    if (gated11 === 0 && /^\s*update\s+"monitors"\s+set/i.test(sql) && args.includes("lost")) {
      gated11 += 1;
      await gate11;
    }
    return (realExec11 as (...a: unknown[]) => unknown).call(dbClient, statement, ...rest);
  }) as typeof dbClient.execute;
  try {
    const booting = reattachMonitors();
    await until("写掉那一条 UPDATE 已经排在闸门上", async () => gated11 === 1, 15_000);
    const before11 = (await pendingOf(taskId11)).length;
    const stopping11 = stopMonitor(mon11, "用户点停：这条我自己处理");
    await until("点停的第一步已经落盘", async () => (await readRow(mon11))?.status === "stopped");
    release11!();
    await booting;
    await stopping11;
    await serialize(`task:${taskId11}`, async () => {});
    const after11 = (await readRow(mon11))!;
    assert.equal(after11.status, "stopped",
      "**停止赢了就是赢了** —— 在途的那次写掉不许把它改写成 lost");
    assert.match(after11.endedReason ?? "", /用户点停/, "卡片上留的是用户点停那句话,不是「没有真正开工」");
    assert.equal((await pendingOf(taskId11)).length, before11,
      "**一条结束通知都不许补推**:用户点停就是为了不再被它叫醒");
  } finally {
    dbClient.execute = realExec11;
    if (release11) release11();
  }

  // ⑫ **到期收尾走到一半,用户点停了** —— `finish` 那条路的同一颗牙(第 21 轮审查 F2 点名的
  //    「判 expired 与输出/结束通知」)。它把「这一行还是 running」读在 `reclaimMonitorProcess`
  //    之前,而那一步要问状态、下刀、等确认(有界,秒级);上一版紧随其后那条 UPDATE 无条件、
  //    通知还排在它后面照推,于是点停的事实被改写成 expired 并补推一条【哨兵结束】。
  const taskId12 = await makeTask({ status: "running" });
  const token12 = `expire-stoprace-${process.pid}-${Date.now()}`;
  const pid12 = markedProcess(token12);
  const mon12 = await insertMonitorRow(taskId12, { pid: pid12, unitToken: token12 });
  // 把收尾路上**记责任那一笔**挂住:它排在那条 UPDATE 之前,正是审查说的「await 之后」。
  let release12: (() => void) | null = null;
  const gate12 = new Promise<void>((resolve) => { release12 = resolve; });
  let gated12 = 0;
  const realExec12 = dbClient.execute;
  dbClient.execute = (async function (statement: unknown, ...rest: unknown[]) {
    const sql = String(typeof statement === "string" ? statement : (statement as { sql?: string })?.sql);
    if (gated12 === 0 && /^\s*insert\s+into\s+"monitor_reclaim_debts"/i.test(sql)) {
      gated12 += 1;
      await gate12;
    }
    return (realExec12 as (...a: unknown[]) => unknown).call(dbClient, statement, ...rest);
  }) as typeof dbClient.execute;
  try {
    const expiring = finish(mon12, "expired", "盯满了约定的时长（台子直接叫的）", null);
    await until("到期收尾已经走到记责任那一笔", async () => gated12 === 1, 15_000);
    const before12 = (await pendingOf(taskId12)).length;
    // 点停整跳跑完:它自己那一趟记责任不被挂住(闸门只拦第一笔)。
    const stopped12 = await stopMonitor(mon12, "用户点停：不想再被它叫醒");
    assert.equal(stopped12?.status, "stopped", "台子前提:点停这一跳已经整跳落定");
    release12!();
    await expiring;
    const after12 = (await readRow(mon12))!;
    assert.equal(after12.status, "stopped",
      "**停止赢了就是赢了** —— 在途的到期收尾不许把它改写成 expired");
    assert.match(after12.endedReason ?? "", /用户点停/, "卡片上留的是用户点停那句话,不是「盯满了」");
    assert.equal((await pendingOf(taskId12)).length, before12,
      "**一条结束通知都不许补推**:点停那一路本来就不推,在途的到期更不该替它推一条");
  } finally {
    dbClient.execute = realExec12;
    if (release12) release12();
  }

  // ⑬ **接回某一条时出错,不许把整批监督一起带走**(第 22 轮审查 F1-A)。出口资格那一问(读
  //    任务行)是接管的第一步;上一版它一抛就从整个循环里窜出去 —— 它后面那些行连 tail 都
  //    没接上,而启动侧只打一行日志就继续启动(index.ts),于是这一次启动期间它们完全没人管
  //    (审查实测:两条哨兵都 `supervised=false`、期限早就过了、结果已经写进日志)。
  // 两条行分开建:夹具的 id 只随 `makeTask` 换序号(`uniq` 用的是 seq + 毫秒),同一毫秒连着
  // 插两条会撞主键 —— 建完一条再建下一个任务,顺带把序号带过去。
  const taskId13 = await makeTask({ status: "done" });        // 终态任务 ⇒ 出口资格判「没出口」
  const token13 = `boot-isolate-a-${process.pid}-${Date.now()}`;
  const pid13 = markedProcess(token13);
  const mon13 = await insertMonitorRow(taskId13, { pid: pid13, unitToken: token13 });
  const taskId13b = await makeTask({ status: "running" });
  const token13b = `boot-isolate-b-${process.pid}-${Date.now()}`;
  const pid13b = markedProcess(token13b);
  const mon13b = await insertMonitorRow(taskId13b, { pid: pid13b, unitToken: token13b });
  for (const id of [mon13, mon13b]) writeFileSync((await readRow(id))!.logPath, "");
  let thrown13 = 0;
  const realExec13 = dbClient.execute;
  dbClient.execute = (async function (statement: unknown, ...rest: unknown[]) {
    const sql = String(typeof statement === "string" ? statement : (statement as { sql?: string })?.sql);
    if (thrown13 === 0 && /^\s*select\b[\s\S]*from "tasks" where/i.test(sql)) {
      thrown13 += 1;
      dbClient.execute = realExec13;   // 只打一次:它后面那一条要走到真东西
      throw new Error("fixture: transient tasks read failure inside takeOver");
    }
    return (realExec13 as (...a: unknown[]) => unknown).call(dbClient, statement, ...rest);
  }) as typeof dbClient.execute;
  let boot13: Awaited<ReturnType<typeof reattachMonitors>>;
  try {
    boot13 = await reattachMonitors();
  } finally { dbClient.execute = realExec13; }
  assert.equal(thrown13, 1, "台子前提:出口资格那一问真的抛了一次");
  assert.equal(boot13.failed, 1,
    "那一条照实记成「这一次没接管成功」—— 混进接回或判没任何一边都是撒谎");
  assert.equal(supervisionComplete({ id: mon13, pid: pid13 }), true,
    "**抛错的那一条自己也不许失管**:tail、期限、探活都在身份与资格之前就立好了");
  assert.equal(supervisionComplete({ id: mon13b, pid: pid13b }), true,
    "**它后面那一条更不许被带走**:上一版整批窜出去,这一条连 tail 都没有");
  // 监督是真的在盯,不是一个布尔:进程退了就收得到。
  killTree(pid13b, "SIGKILL");
  await until("后面那一条照常收尾", async () => (await readRow(mon13b))?.status === "exited", 20_000);
  // 抛错的那一条:接管那一趟由恢复重试补完 —— 它的任务已终态,结论就是「没出口,收掉」。
  await until("抛错的那一条由重试把接管补完", async () => (await readRow(mon13))?.status === "stopped", 25_000);
  assert.match((await readRow(mon13))!.endedReason ?? "", /server 重启期间发生的/,
    "补完的是**接管那一趟的结论**(出口资格),不只是把监督挂上");

  // ⑭ **号认回来了、接管那一步抛了错:退出检查不许就此永久缺位**(第 22 轮审查 F1-B)。
  //    上一版这一支拿 `isSupervised` 当闸,而 pending 那一刻已经有 tail 了 —— 于是唯一能补装
  //    探活的那一句被永久挡在门外(审查实测:pid 已回填、进程真的退了,行还停在 running、
  //    `events=1` 有输出、却一条【哨兵结束】都没有,只能白等到原期限)。
  const taskId14 = await makeTask({ status: "running" });
  const token14 = `retry-liveness-${process.pid}-${Date.now()}`;
  const pid14 = markedProcess(token14);
  const mon14 = await intentRow(taskId14, token14, pid14);
  const [first14, injected14] = await withLedgerReadFailure(() => reattachMonitors());
  assert.equal(injected14, 1);
  assert.equal(first14.pending, 1, "台子前提:这一行落在「这一刻认不回来」那一档");
  assert.deepEqual(supervisionOf(mon14), { watching: true, exitWatched: false },
    "台子前提:pending 这一刻只有 tail 和期限 —— 探活问的是「这个号还是它吗」,空号问不出");
  // 出口资格那一问**一直抛**(不是只打一次):这样「探活装上了」就只可能来自认回号那一刻的
  // 当场补装,不可能来自某一次接管成功 —— 审查给的修复落点原话就是「能力修复不该押在完成
  // 接管先成功上」。
  let thrown14 = 0;
  const realExec14 = dbClient.execute;
  dbClient.execute = (async function (statement: unknown, ...rest: unknown[]) {
    const sql = String(typeof statement === "string" ? statement : (statement as { sql?: string })?.sql);
    if (/^\s*select\b[\s\S]*from "tasks" where/i.test(sql)) {
      thrown14 += 1;
      throw new Error("fixture: tasks read keeps failing after the pid landed");
    }
    return (realExec14 as (...a: unknown[]) => unknown).call(dbClient, statement, ...rest);
  }) as typeof dbClient.execute;
  try {
    await until("梯子把号认回来了", async () => (await readRow(mon14))?.pid === pid14, 25_000);
    await until("退出检查当场就补上了", async () => supervisionOf(mon14).exitWatched, 25_000);
    assert.ok(thrown14 >= 1, "台子前提:出口资格那一问这期间一直在抛");
    assert.equal((await readRow(mon14))!.status, "running",
      "接管那一趟确实还没成功过 —— 所以上面那一份能力不是它带来的");
  } finally { dbClient.execute = realExec14; }
  killTree(pid14, "SIGKILL");
  await until("进程退了就收得到结束", async () => (await readRow(mon14))?.status === "exited", 25_000);

  // ⑮ **离线收尾的终态没落上,监督必须交回来**(第 23 轮审查 F1)。撤运行时排在读日志之前
  //    (自己那条 tail 不停下来就会边收尾边继续推),所以「监督已撤、终态未落」是真实的一瞬;
  //    上一版那一瞬里抛错就彻底失管 —— 审查实测:行留在 running、tail 与期限全没了,之后产出
  //    的结果一条都送不出去,期限过了也没有结束通知,只能等下一次启动。
  const taskId15 = await makeTask({ status: "running" });
  const token15 = `offline-commit-fail-${process.pid}-${Date.now()}`;
  const gone15 = markedProcess(token15);
  killTree(gone15, "SIGKILL");
  await until("台子先把 ⑮ 的进程收掉", async () => !isPidAlive(gone15));
  invalidateMonitorUnitScan();
  const mon15 = await intentRow(taskId15, token15, gone15);
  // 期限压到 2 秒:到期这件事必须在那次失败**之后**照旧发生(审查实测里它没发生)。
  await db.update(monitors)
    .set({ expiresAt: new Date(Date.now() + 2_000).toISOString() })
    .where(eq(monitors.id, mon15));
  const fault15 = failSidecarRead(monitorSpawnIdentityPath((await readRow(mon15))!.logPath), { once: true });
  const first15 = await reattachMonitors();
  assert.equal(fault15.reads(), 1, "台子前提:边条那一次读真的失败了");
  assert.equal(first15.pending, 1, "台子前提:第一问被那次读失败挡住,梯子挂上了");
  // 让离线收尾那条终态 UPDATE 抛一次(绑定参数里带 lost 的就是它)。
  let thrown15 = 0;
  const realExec15 = dbClient.execute;
  dbClient.execute = (async function (statement: unknown, ...rest: unknown[]) {
    const sql = String(typeof statement === "string" ? statement : (statement as { sql?: string })?.sql);
    const args = ((statement as { args?: unknown[] })?.args ?? []) as unknown[];
    if (thrown15 === 0 && /^\s*update\s+"monitors"\s+set/i.test(sql) && args.includes("lost")) {
      thrown15 += 1;
      dbClient.execute = realExec15;   // 只打一次:之后的每一步都要走到真东西
      throw new Error("fixture: terminal UPDATE fails once inside finishOffline");
    }
    return (realExec15 as (...a: unknown[]) => unknown).call(dbClient, statement, ...rest);
  }) as typeof dbClient.execute;
  try {
    await until("离线收尾那一次提交真的失败了", async () => thrown15 === 1, 25_000);
  } finally { dbClient.execute = realExec15; }
  assert.equal((await readRow(mon15))!.status, "running",
    "台子前提:那条终态没落上,这一行还是运行态");
  await until("提交失败之后监督被交回来了", async () => supervisionOf(mon15).watching, 10_000,
  );
  // 不靠下一次启动:**结果照旧送得到、到点照旧收得掉**。
  appendFileSync((await readRow(mon15))!.logPath, "AFTER_FAILURE_RESULT\n");
  await until("失败之后产出的那一行照旧推得出去",
    async () => ((await readRow(mon15))?.events ?? 0) > 0, 20_000);
  await until("到点照旧收得掉(不管是到期还是下一跳把它判掉)",
    async () => (await readRow(mon15))?.status !== "running", 25_000);

  // ⑯ **没有梯子的那条路也要交回来**。到期和探活走的是 `finish`,而它跑在一条已经认回来的
  //    行上 —— 这里没有任何恢复梯子会来补,收尾层那一处 `finally` 是唯一的接回点(⑮ 那条行
  //    身上还挂着梯子,所以它证不出这一档)。
  const taskId16 = await makeTask({ status: "running" });
  const token16 = `finish-commit-fail-${process.pid}-${Date.now()}`;
  const pid16 = markedProcess(token16);
  const mon16 = await insertMonitorRow(taskId16, { pid: pid16, unitToken: token16 });
  writeFileSync((await readRow(mon16))!.logPath, "");
  attach((await readRow(mon16))!);   // 生产里由接回/创建装上,这里直接装
  assert.equal(supervisionComplete({ id: mon16, pid: pid16 }), true, "台子前提:监督是齐的");
  let thrown16 = 0;
  const realExec16 = dbClient.execute;
  dbClient.execute = (async function (statement: unknown, ...rest: unknown[]) {
    const sql = String(typeof statement === "string" ? statement : (statement as { sql?: string })?.sql);
    const args = ((statement as { args?: unknown[] })?.args ?? []) as unknown[];
    if (thrown16 === 0 && /^\s*update\s+"monitors"\s+set/i.test(sql) && args.includes("expired")) {
      thrown16 += 1;
      dbClient.execute = realExec16;
      throw new Error("fixture: terminal UPDATE fails once inside finish");
    }
    return (realExec16 as (...a: unknown[]) => unknown).call(dbClient, statement, ...rest);
  }) as typeof dbClient.execute;
  try {
    await finish(mon16, "expired", "盯满了约定的时长（台子直接叫的）", null).catch(() => undefined);
  } finally { dbClient.execute = realExec16; }
  assert.equal(thrown16, 1, "台子前提:到期那次终态提交真的抛了一次");
  assert.equal((await readRow(mon16))!.status, "running",
    "那条终态没落上,所以这一行还是运行态 —— 它必须还有人盯");
  await until("提交失败之后监督被交回来了(连探活那一根)",
    async () => supervisionComplete({ id: mon16, pid: pid16 }), 10_000);
  // 交回来的那几根**真的在干活**:把进程杀掉,探活那一根应当自己判出「已经不在了」并收尾 ——
  // 不靠下一次启动。只断言 `watching` 就只证到「注册表里有个对象」。
  killTree(pid16, "SIGKILL");
  await until("进程退了照旧收得掉", async () => (await readRow(mon16))?.status !== "running", 25_000);

  // ⑰ **交接那一趟自己失败时,责任不许就地丢掉**(第 24 轮审查 F1)。⑮⑯ 里接回那一次读都
  //    是成功的;而审查实测的现场是**同一场故障**把收尾那次读和交接那次读一起打掉 —— 那时
  //    的兜底只打一行日志,于是行留在 running、监督一样也没有,命令还在跑、结果已经写在磁盘
  //    上,却再也没有人读出去,期限也再没人算。一次 700ms 的抖动换永久失联。
  const taskId17 = await makeTask({ status: "running" });
  const token17 = `handover-retry-${process.pid}-${Date.now()}`;
  const pid17 = markedProcess(token17);
  const mon17 = await insertMonitorRow(taskId17, { pid: pid17, unitToken: token17 });
  const log17 = (await readRow(mon17))!.logPath;
  writeFileSync(log17, "");
  attach((await readRow(mon17))!);
  assert.equal(supervisionComplete({ id: mon17, pid: pid17 }), true, "台子前提:监督是齐的");
  // 这一阵**整张监听表都读不出来**(审查注的就是这个:到期那次读和 finally 那次读同源)。
  let outage17 = true;
  let reads17 = 0;
  const realExec17 = dbClient.execute;
  dbClient.execute = (async function (statement: unknown, ...rest: unknown[]) {
    const sql = String(typeof statement === "string" ? statement : (statement as { sql?: string })?.sql);
    if (outage17 && /^\s*select\b/i.test(sql) && /\bfrom\s+"monitors"/i.test(sql)) {
      reads17 += 1;
      throw new Error("fixture: monitors 表这一阵读不出来");
    }
    return (realExec17 as (...a: unknown[]) => unknown).call(dbClient, statement, ...rest);
  }) as typeof dbClient.execute;
  try {
    await finish(mon17, "expired", "盯满了约定的时长（台子直接叫的）", null).catch(() => undefined);
    assert.ok(reads17 >= 2, `台子前提:收尾那次读和交接那次读都撞上同一场故障（实到 ${reads17} 次）`);
    assert.equal(isSupervised(mon17), false, "故障里确实接不回来 —— 这一刻监督是真没有的");
    // **但责任不许丢**:排着下一跳,而且最后一档会一直续约(不是「等下一次启动」)。
    assert.deepEqual(pendingSupervisionHandovers(), [mon17],
      "交接失败之后必须留下一个会自己重试的接管者");
  } finally { outage17 = false; dbClient.execute = realExec17; }
  await until("故障过去之后它自己把监督接回来了(没有人再碰过它)",
    async () => supervisionComplete({ id: mon17, pid: pid17 }), 20_000);
  appendFileSync(log17, "RESULT_AFTER_OUTAGE\n");
  await until("故障之后产出的那一行照旧推得出去",
    async () => ((await readRow(mon17))?.events ?? 0) > 0, 20_000);
  killTree(pid17, "SIGKILL");
  await until("进程退了照旧收得掉", async () => (await readRow(mon17))?.status !== "running", 25_000);
  assert.deepEqual(pendingSupervisionHandovers(), [], "收完之后不留排着的重试");

  // ⑱ **反过来那一半:终态落定了就不许还有人盯**(第 24 轮审查 N1)。两笔收尾交错进来 ——
  //    第一笔落终态失败,它的 finally 把运行时挂回来(那一刻行确实还是 running,挂回来是对的);
  //    第二笔随后把它写成 stopped。那条已经停掉的行此前还占着文件句柄、还在算自己的期限。
  const taskId18 = await makeTask({ status: "running" });
  const absent18 = 999_999;
  assert.equal(isPidAlive(absent18), false, "台子前提:这个号上没有进程(不会给无关进程发信号)");
  const mon18 = await insertMonitorRow(taskId18, { pid: absent18 });
  writeFileSync((await readRow(mon18))!.logPath, "");
  attach((await readRow(mon18))!);
  const gate18 = () => { let open!: () => void; const p = new Promise<void>((r) => { open = r; }); return { p, open }; };
  const firstAtUpdate = gate18(), secondAtUpdate = gate18(), failFirst = gate18(), commitSecond = gate18();
  let failures18 = 0;
  const realExec18 = dbClient.execute;
  dbClient.execute = (async function (statement: unknown, ...rest: unknown[]) {
    const sql = String(typeof statement === "string" ? statement : (statement as { sql?: string })?.sql);
    const args = ((statement as { args?: unknown[] })?.args ?? []) as unknown[];
    if (/^\s*update\s+"monitors"\s+set/i.test(sql) && args.includes("expired")) {
      failures18 += 1;
      firstAtUpdate.open();
      await failFirst.p;
      throw new Error("fixture: 在途的那笔到期提交失败一次");
    }
    if (/^\s*update\s+"monitors"\s+set/i.test(sql) && args.includes("stopped")) {
      secondAtUpdate.open();
      await commitSecond.p;
    }
    return (realExec18 as (...a: unknown[]) => unknown).call(dbClient, statement, ...rest);
  }) as typeof dbClient.execute;
  try {
    const first18 = finish(mon18, "expired", "并发的旧到期回调", null).catch(() => undefined);
    await firstAtUpdate.p;
    const second18 = stopMonitor(mon18, "用户点停");
    await secondAtUpdate.p;
    failFirst.open();
    await first18;
    assert.equal(isSupervised(mon18), true,
      "台子前提:第一笔失败之后把运行时挂回来了(那一刻行还是 running)");
    commitSecond.open();
    await second18;
  } finally { failFirst.open(); commitSecond.open(); dbClient.execute = realExec18; }
  assert.equal(failures18, 1, "台子前提:第一笔的终态提交确实失败了一次");
  assert.equal((await readRow(mon18))!.status, "stopped", "后落定的那一笔赢了");
  assert.equal(isSupervised(mon18), false,
    "终态已经落定,就不许还有人盯 —— 否则文件轮询、期限和探活都留在一条停掉的行上");

  // ⑲ **离线收尾那条路要单独钉住**。⑮ 那一行身上还挂着恢复梯子,梯子的 catch 也会把监督
  //    接回去 —— 所以 ⑮ 证不出「`finishOffline` 自己那一处 `finally`」有没有用(实测:把它
  //    摘掉 ⑮ 照旧绿)。这里直接叫它,行是台子插的、从没进过接回那一趟,身上没有梯子。
  const taskId19 = await makeTask({ status: "running" });
  const token19 = `offline-commit-fail-${process.pid}-${Date.now()}`;
  const pid19 = markedProcess(token19);
  const mon19 = await insertMonitorRow(taskId19, { pid: pid19, unitToken: token19 });
  const row19 = (await readRow(mon19))!;
  writeFileSync(row19.logPath, "");
  attach(row19);
  assert.equal(supervisionComplete({ id: mon19, pid: pid19 }), true, "台子前提:监督是齐的");
  let thrown19 = 0;
  const realExec19 = dbClient.execute;
  dbClient.execute = (async function (statement: unknown, ...rest: unknown[]) {
    const sql = String(typeof statement === "string" ? statement : (statement as { sql?: string })?.sql);
    const args = ((statement as { args?: unknown[] })?.args ?? []) as unknown[];
    if (thrown19 === 0 && /^\s*update\s+"monitors"\s+set/i.test(sql) && args.includes("lost")) {
      thrown19 += 1;
      dbClient.execute = realExec19;
      throw new Error("fixture: terminal UPDATE fails once inside finishOffline");
    }
    return (realExec19 as (...a: unknown[]) => unknown).call(dbClient, statement, ...rest);
  }) as typeof dbClient.execute;
  try {
    await finishOffline(row19, "lost", "台子直接叫的离线收尾").catch(() => undefined);
  } finally { dbClient.execute = realExec19; }
  assert.equal(thrown19, 1, "台子前提:那次终态提交真的抛了一次");
  assert.equal((await readRow(mon19))!.status, "running", "那条终态没落上,这一行还是运行态");
  assert.deepEqual(pendingSupervisionHandovers(), [],
    "台子前提:没有排着的重试在兜 —— 接回来的只能是它自己那一处 finally");
  assert.equal(supervisionComplete({ id: mon19, pid: pid19 }), true,
    "出这个函数时监督就该是齐的(它在自己那条队列里当场接回来,不用等下一跳)");
  killTree(pid19, "SIGKILL");
  await until("进程退了照旧收得掉", async () => (await readRow(mon19))?.status !== "running", 25_000);

  console.log(
    "✓ 收尾交接：点停赢了之后在途的旧回调一个字都不写、一条通知都不推、更不重新接上运行时 /"
    + " 重问那一跳自己抛错也还有下一跳 / 判掉与到期这两条收尾路在点停插进来之后都不许改写它 /"
    + " 接回某一条时出错既不带走它自己的监督、也不带走后面那些行,接管那一趟由重试补完 /"
    + " 号认回来而接管抛错时退出检查当场补上（进程退了收得到）/"
    + " 终态没落上时监督交得回来（有梯子的那条、没梯子的那条都算,交回来的那几根真的在干活）/"
    + " 交接那一趟自己撞上同一场故障时留下会重试的接管者、故障过去自己接回来 /"
    + " 反过来那一半:终态落定之后不许还有人盯（并发收尾那一笔挂回来的也要撤）/"
    + " 离线收尾那条路自己那一处 finally 单独钉住（行上没有梯子在兜时它是唯一的接回点）"
    + " 均受回归保护",
  );
} finally {
  detachAllMonitors();   // 连恢复梯子一起撤:库马上要关了,别让它醒过来对着关了的库发问
  await reapStrays();
  await teardown();
}
