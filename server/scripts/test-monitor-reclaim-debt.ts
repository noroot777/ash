// **撤销是一段时间,而「停止函数正常返回」不等于资源已经回收。**
//
// 这一份从 `test-monitor-result-lifecycle.ts` 分出来(那边到了 700 行上限),钉的是回收这一侧:
//
// ① **撤销期不许再创建**。删除从关闸到任务行真的没了之间有十几条语句,这中间 `startMonitor`
//    曾照旧返回成功 —— 新起的那条行被紧随其后的删除批次连 pid 一起抹掉,进程却还在后台跑着
//    (第 3 轮审查 F1)。
// ② **销毁持久身份之前,每一条要么已确认退出、要么回收责任已经可靠落盘。** `killByPid` 是
//    SIGTERM + 两秒后一把 `unref` 的补刀,server 在这两秒里退出它就永远不会落下(第 4 轮
//    审查 F1)。
// ③ **这一圈归运行时收尾层(`finish`),不归删除/审查收尾那两个包装函数。** 装在包装函数上时,
//    用户点停、到期、推满上限、启动接回判无出口、创建后登记失败全都绕过了它(第 5 轮审查 F1)。
//    配套的两条判据:删除按**资源责任**核对而不是按卡片状态;组长退出不等于整组后代已退出。
// ④ **「问不出来」不是「已经退了」。** `ps` 短暂不可用时,身份这一问失败 —— 那一刻什么都不许
//    声称:不许写「这个进程已经不在了」,更不许据此放弃回收责任(第 6 轮审查 F1 实测:接回写
//    lost → 删除放行 → 任务/哨兵/债表三处全空,命令还在后台跑着)。「确认是另一个进程」是
//    另一档,两者必须分别测。
//
// 身份这一问**本身**的判定(只许查一次、问不出来与「确认是别人」怎么分档、孤儿组有没有下刀
// 资格、卡片上那句话由谁决定)归 test-monitor-reclaim-identity.ts,台子两边共用
// monitor-reclaim-fixture.ts。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { eq } from "drizzle-orm";
import {
  db, insertMonitorRow, isPidAlive, makeTask, monitors, reattachMonitors, reviewInFlight,
  detachAllMonitors, root, schema, startMonitor, stopMonitor, tasks, teardown, until,
} from "./monitors-fixture.js";
import { STUBBORN, assertDebtClosed, debtRow, withPsOutage } from "./monitor-reclaim-fixture.js";
import { inspectProcess } from "../src/proc.js";

const { stopMonitorsForTask, reclaimUnconfirmedStops } = await import("../src/monitor-reclaim.js");
const { monitorWakeGate } = await import("../src/monitor-session.js");
const { beginTaskRevocation, isTaskRevoked, releaseTaskRevocation } = await import("../src/claude-monitor-revoked.js");
const { deleteTaskCompletely } = await import("../src/task-delete-routes.js");
const { sweepMonitorReclaimDebts } = await import("../src/monitor-reclaim-debts.js");
const { isProcessGroupAlive, killTree } = await import("../src/platform.js");
const { invalidateMonitorUnitScan, monitorUnitProofGrade } = await import("../src/monitor-unit-scan.js");

// ── ⑨ 撤销是一段时间:撤销期不许再创建、停不掉必须留下回收责任（第 3 轮审查 F1）──────
//
// 「扫完一遍哨兵」不等于这一生命周期已经被撤销。删除从关闸到任务行真的没了之间有十几条
// 语句,而这中间 `startMonitor` 曾照旧返回成功 —— 新起的那条行被紧随其后的删除批次连 pid
// 一起抹掉,进程却还在后台跑着(实测 lateCreationAccepted=true + aliveAfterDelete=true)。
{
  // ⑨-1 撤销期:创建与出口读同一份资格,而且**不吃审查豁免**。
  const taskId = await makeTask({ status: "done" });
  await reviewInFlight(taskId, "run-revoke"); // 审查还在进行 ⇒ 平时这是豁免放行的那一路
  beginTaskRevocation(taskId);                // = `deleteTaskRows` 的第一条语句
  const late = await startMonitor({ taskId, command: "sleep 120", description: "删除期补挂" });
  assert.equal(late.ok, false, "撤销期不许再挂哨兵（删除批次会把它的 pid 线索一起抹掉）");
  assert.equal(late.ok === false && late.status, 409);
  assert.match(late.ok === false ? late.error : "", /正在被删除/);
  const exit = await monitorWakeGate({ id: taskId, status: "done" }, { reviewRun: "run-revoke", reviewRound: 1 });
  assert.match(exit ?? "", /正在被删除/, "出口也读同一份资格：任务马上就不存在了，推出去没有意义");

  // 闸开了就照旧能挂 —— 证明拦住它的是撤销资格,不是别的门禁顺手拦的。
  releaseTaskRevocation(taskId);
  const ok = await startMonitor({ taskId, command: "sleep 120", description: "闸开之后" });
  assert.equal(ok.ok, true, "撤销解除后照旧能挂（审查豁免仍然有效）");
  await stopMonitorsForTask(taskId, "测试收尾", "destroy");
}

{
  // ⑨-2 **连枚举都失败 ⇒ 整笔删除不许往下走**。那时根本不知道有几个进程在跑,再删就是把
  // pid 线索连同任务一起抹掉;删除失败是可重试的,留下无主进程不可逆。
  const taskId = await makeTask({ status: "done" });
  const monId = await insertMonitorRow(taskId);
  const original = db.select;
  db.select = ((fields?: Record<string, unknown>) => {
    if (fields && "sourceReviewRound" in fields) throw new Error("库忙：枚举失败");
    return (original as (f?: unknown) => unknown).call(db, fields);
  }) as typeof db.select;
  await assert.rejects(() => deleteTaskCompletely(taskId), /枚举失败/,
    "回收层枚举失败必须把删除整笔挡回去，而不是吞掉异常继续删行");
  db.select = original;
  assert.equal((await db.select().from(tasks).where(eq(tasks.id, taskId))).length, 1, "任务行必须还在");
  assert.equal((await db.select().from(monitors).where(eq(monitors.id, monId))).length, 1, "哨兵行也必须还在");
  assert.equal(isTaskRevoked(taskId), false,
    "闸要按「任务行还在不在」收口：任务还在却一直关着，它的监听就再也写不进来了");
}

{
  // ⑩-1 **正常停止也要走「落责任 → 发信号 → 追到线索空 → 收档」这一圈**(第 4 轮审查 F1)。
  // 追空了就收档:返回时进程确认不在了,那一行**留着并盖上收档戳**(第 13 轮审查 F1-B:
  // 删行等于声称整项退出已证明,而那件事在这个平台上证不出来)。
  const taskId = await makeTask({ status: "running" });
  const started = await startMonitor({ taskId, command: "sleep 120", description: "正常收掉的" });
  assert.equal(started.ok, true);
  const row = (await db.select().from(monitors).where(eq(monitors.taskId, taskId))).at(0)!;
  await stopMonitorsForTask(taskId, "任务已删除", "destroy");
  assert.equal(isPidAlive(row.pid!), false,
    "`stopMonitorsForTask` 返回时必须已经确认退出 —— 发完信号就返回的话,补刀那两秒里 server 一退出它就永远留下了（F1）");
  await assertDebtClosed(row.id, "追到线索空就收档");
}

{
  // ⑩-2 **追不空线索 ⇒ 责任留下来**,而且只认「能追的线索都追空了」才收档。
  //
  // 这里的现场是「身份问不出来」:进程组里明明有人,而 `pid_started_at` 对不上(locale 变了、
  // pid 被复用、ps 不可用都会这样)。那时既不敢杀(杀错人不可逆),更不许收档 —— 旧写法拿
  // `isSameProcess=false` 直接销账删行,等于把最后一份责任丢掉(第 4 轮审查 F1 的并条之一)。
  const taskId = await makeTask({ status: "done" });
  const stray = spawn("sleep", ["300"], { detached: true, stdio: "ignore" });
  stray.unref();
  const pid = stray.pid!;
  const realStartedAt = inspectProcess(pid)?.startedAt ?? null;
  const monId = await insertMonitorRow(taskId, { pid, pidStartedAt: "Thu Jan  1 00:00:00 2020" });

  await stopMonitorsForTask(taskId, "任务已删除", "destroy"); // 责任落下了 ⇒ 不该抛
  const debtOf = async () => (await db.select().from(schema.monitorReclaimDebts)
    .where(eq(schema.monitorReclaimDebts.monitorId, monId))).at(0);
  const debt = await debtOf();
  assert.ok(debt, "确认不了退出就必须把回收责任留下来（正常停止路径也要记,不只是抛异常那一支）");
  assert.equal(debt.pid, pid, "责任上带着 pid");
  assert.equal(debt.command, "sleep 120", "以及命令原文");
  assert.equal(isPidAlive(pid), true, "身份对不上就不敢杀它 —— 那个号可能已经是别人的了");

  // 任务行删掉也不许把责任一起删掉 —— 它的全部意义就是活得比那个任务久。
  await deleteTaskCompletely(taskId);
  assert.equal((await db.select().from(monitors).where(eq(monitors.taskId, taskId))).length, 0, "哨兵行跟着任务没了");
  assert.ok(await debtOf(), "回收责任必须活过任务删除（跟着删等于把唯一线索再丢一次）");

  // 开机清扫:身份还是问不出来 ⇒ 照旧不杀、不收档。
  await sweepMonitorReclaimDebts();
  assert.ok(await debtOf(), "「查不出身份」不等于「它已经退了」,不许据此收档");
  assert.equal(isPidAlive(pid), true, "也不许在身份不明时下刀");

  // 身份又对上了(ps 恢复 / 换回原 locale)。**但这是一条存量行(没有记号)**,而秒级读数是
  // 粗判据:同一秒里起来的两个进程读数逐字相同,所以「对上了」证不出排他归属(第 19 轮审查
  // F1 实测 `coarse-identity-risk.log`)。于是这一档的兑现方式是**责任留着、一刀不发** ——
  // 带记号的行才补得出第二份独立证据(⑩-3/⑩-4 那两条走的就是那条路)。
  await db.update(schema.monitorReclaimDebts).set({ pidStartedAt: realStartedAt })
    .where(eq(schema.monitorReclaimDebts.monitorId, monId));
  await sweepMonitorReclaimDebts();
  assert.equal(isPidAlive(pid), true, "存量行的粗档认不出排他归属 ⇒ 补刀一律不发");
  assert.ok(await debtOf(), "责任照旧留着:记号那一问哪天答得出来就哪天收它");
  killTree(pid, "SIGKILL");                       // 台子自己清场
  await until("台子把这个陌生进程收掉", async () => !isProcessGroupAlive(pid));
  await sweepMonitorReclaimDebts();               // 线索真追空了,这一遍才收得了档
  await assertDebtClosed(monId, "追到线索空才收档");
}

{
  // ⑩-3 **连责任都落不下来、又确认不了退出 ⇒ 销毁身份整笔中止**。
  // 删除失败可重试,留下一个谁都找不到的后台进程不可逆 —— 跟枚举失败那一条同一个判据。
  const taskId = await makeTask({ status: "done" });
  const stray = spawn("sleep", ["300"], { detached: true, stdio: "ignore" });
  stray.unref();
  const pid = stray.pid!;
  await insertMonitorRow(taskId, { pid, pidStartedAt: "Thu Jan  1 00:00:00 2020" });
  const originalInsert = db.insert;
  db.insert = ((table: unknown) => {
    if (table === schema.monitorReclaimDebts) throw new Error("库忙：责任落不下来");
    return (originalInsert as (t: unknown) => unknown).call(db, table);
  }) as typeof db.insert;
  await assert.rejects(() => deleteTaskCompletely(taskId), /不能销毁它们的身份记录/,
    "责任没落盘、退出也没确认时,不许把 pid 这最后一份线索连任务一起抹掉");
  db.insert = originalInsert;
  assert.equal((await db.select().from(tasks).where(eq(tasks.id, taskId))).length, 1, "任务行必须还在（可重试）");
  // 库恢复之后那一笔要**自己补记上**:落盘失败挂的是补记梯子,不是收档梯子 —— 收档梯子读
  // 债表,读到空就当「别人已经销了」返回成功,一笔从没落盘的责任正好被它静静吃掉。
  const monId = (await db.select().from(monitors).where(eq(monitors.taskId, taskId))).at(0)!.id;
  await until("库恢复后回收责任要补记上", async () => await debtRow(monId) !== undefined);
  killTree(pid, "SIGKILL"); // 测试自己收场
  await until("收掉旁路进程", async () => !isPidAlive(pid));
}

{
  // ⑨-4 **启动恢复也是一道资格判断**。审查结束已经落库、回收那一刀还没落下去 server 就没了:
  // 照着「同代还活着 + 没到期」接回来的是一条已经失去出口的命令,它推的每一条都被出口闸拒
  // 回,一直烧到自己到期。
  const taskId = await makeTask({ status: "done" });
  await reviewInFlight(taskId, "run-gone");
  const started = await startMonitor({ taskId, command: "sleep 120", description: "审查者挂的" });
  assert.equal(started.ok, true);
  const row = (await db.select().from(monitors).where(eq(monitors.taskId, taskId))).at(0)!;
  assert.equal(row.sourceReviewRun, "run-gone", "审查者挂的哨兵要记下是哪次审查");
  await db.update(schema.freeReviewRuns).set({ status: "passed" })
    .where(eq(schema.freeReviewRuns.id, "run-gone"));

  detachAllMonitors();            // = server 进程没了(哨兵进程本来就不跟着死)
  await reattachMonitors();
  const after = (await db.select().from(monitors).where(eq(monitors.id, row.id))).at(0)!;
  assert.equal(after.status, "stopped",
    "来源审查已经结束的，重启不许再接回来（接回要问跟创建、出口同一份资格）");
  assert.equal(isPidAlive(row.pid!), false,
    "接回判无出口而停掉的,返回时就得确认退出 —— 发完信号就返回的话,补刀那两秒里退一次 server 它就留下了（第 5 轮审查 F1）");
}

{
  // ⑩-4 接回那道资格问的是**出口资格本身**(`monitorWakeGate`),不是「审查来源」这一种:
  // 任务已经落终态、回收那一刀还没落下去就崩了的话,重启照旧不许把它接回来(第 4 轮审查 F1)。
  const taskId = await makeTask({ status: "running" });
  const started = await startMonitor({ taskId, command: "sleep 120", description: "执行者挂的" });
  assert.equal(started.ok, true);
  const row = (await db.select().from(monitors).where(eq(monitors.taskId, taskId))).at(0)!;
  await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, taskId));

  detachAllMonitors();
  await reattachMonitors();
  const after = (await db.select().from(monitors).where(eq(monitors.id, row.id))).at(0)!;
  assert.equal(after.status, "stopped",
    "任务已经终态、它的输出再也唤不醒谁,重启不许接回来继续烧（接回与创建、出口同一份资格）");
  assert.equal(isPidAlive(row.pid!), false, "同上:接回那条停止路径也要确认退出才返回");
}

{
  // ⑩-5 **这一圈归运行时收尾层,不归包装函数**(第 5 轮审查 F1)。
  //
  // 第 4 轮把「落责任 → 发信号 → 追到线索空 → 收档」装在了删除/审查收尾那两个入口上,于是
  // 用户点停、到期、推满上限、启动接回判无出口、创建后登记失败全都绕过了它:发完信号就写
  // stopped 返回 —— 紧接着删除、重启,这个进程就永远留在后台了(审查实测:先点停再删除,
  // taskRows=0、monitors=[]、debtRows=0、命令仍活)。
  const taskId = await makeTask({ status: "running" });
  const started = await startMonitor({ taskId, command: STUBBORN, description: "用户点停的" });
  assert.equal(started.ok, true);
  const row = (await db.select().from(monitors).where(eq(monitors.taskId, taskId))).at(0)!;

  const stopping = stopMonitor(row.id, "用户点停"); // 故意不 await:要在这一圈**中间**看一眼
  await until("点停期间责任必须已经在册", async () => await debtRow(row.id) !== undefined);
  assert.equal(isProcessGroupAlive(row.pid!), true,
    "责任是在**发信号之前**落的 —— 这一刻命令还活着就是证据;顺序一反,中间崩一下这一行就成了"
    + "「显示已停止、谁都不认它、pid 线索下一步被删除抹掉」");
  await stopping;
  assert.equal(isProcessGroupAlive(row.pid!), false,
    "点停这条路也要等到确认退出才返回（补刀在 +2 秒,`confirmReclaimed` 等它）");
  await assertDebtClosed(row.id, "追到线索空才收档");
}

{
  // ⑩-6 **删除按资源责任核对,不按卡片状态**:行早就是 stopped、进程却还活着的那条路
  //(上一辈子停的、或者停到一半崩的),照状态过滤就整条跳过了它。
  const taskId = await makeTask({ status: "done" });
  // 这一条的现场是**我们自己**上一辈子停下来的那条哨兵,所以台子跟生产一样带着这次创建的
  // 记号(`monitor-create.ts` 在起进程之前就种进环境):秒级读数只是粗判据,下刀要的第二份
  // 独立证据正是它(第 19 轮审查 F1)。
  const unitToken = `unit-stopped-${process.pid}-${Date.now()}`;
  const stray = spawn("sh", ["-lc", STUBBORN], {
    detached: true, stdio: "ignore", env: { PATH: process.env.PATH ?? "", ASH_MONITOR_UNIT: unitToken },
  });
  stray.unref();
  invalidateMonitorUnitScan();
  const pid = stray.pid!;
  await until("旁路进程起来了", async () => isProcessGroupAlive(pid));
  const monId = await insertMonitorRow(taskId, {
    status: "stopped", pid, pidStartedAt: inspectProcess(pid)?.startedAt ?? null, unitToken,
  });
  assert.equal(await debtRow(monId), undefined, "现场前提:账本上没人认它（旧版本停下来时不记责任）");

  await deleteTaskCompletely(taskId);
  assert.equal(isProcessGroupAlive(pid), false,
    "「已停止」只说明有人发过信号,不说明它退了。删除必须按责任核对全部归属行（第 5 轮审查 F1）");
  await assertDebtClosed(monId, "收掉之后收档");
}

{
  // ⑩-7 **「这个号现在是另一个进程」也要留责任**,只是不许下刀(第 6 轮审查 F1)。
  //
  // 第 5 轮这里写的是「认不出来就不记账」,理由是「没有证据说这一组是我们的」。那个理由只
  // 够支撑**不下刀**:ps 答出来的是「这个号上现在是别人」,证明不了**原来那个**已经退出 ——
  // 它可能带着后代留在这一组里,只是组长的号被占了。所以责任照记,账上写清是哪一档。
  const taskId = await makeTask({ status: "done" });
  const stray = spawn("sleep", ["300"], { detached: true, stdio: "ignore" });
  stray.unref();
  const pid = stray.pid!;
  const monId = await insertMonitorRow(taskId, {
    status: "stopped", pid, pidStartedAt: "Thu Jan  1 00:00:00 2020",
  });
  await deleteTaskCompletely(taskId);
  assert.equal(isPidAlive(pid), true, "身份对不上就不敢杀 —— 那个号可能已经是别人的了");
  const debt = await debtRow(monId);
  assert.ok(debt, "但责任一定要留下:能证明的只有「这个号现在是别人」,证不了原来那个已经退了");
  assert.match(debt.reason, /另一个进程/,
    "账上要写清是哪一种不确定 —— 跟「ps 问不出来」混成一句,事后就分不出该怎么收了");
  killTree(pid, "SIGKILL"); // 测试自己收场
  await until("收掉旁路进程", async () => !isPidAlive(pid));
}

{
  // ⑩-8 **起它的那个进程退出不等于整项资源已退出**。命令自己跑完、重启探活都是按根的身份判
  // 结束的,而外层壳退了、它派生的那个还活着才是最常见的泄漏形态。收尾那一层要按**整项资源**
  // 收,而「哪些算这一项」只认这一次创建独有的那条记号(第 12 轮审查 F1)。
  const taskId = await makeTask({ status: "done" });
  // 记号跟生产同源:创建入口在起进程之前生成它、随行落库,再作为 `ASH_MONITOR_UNIT` 种进环境
  // —— 环境随 exec 继承,所以根死了之后留下的后代仍然自证身份(它们的 argv 可能早就变了)。
  const unitToken = `unit-orphan-${process.pid}-${Date.now()}`;
  const leaderCommand = `(${STUBBORN}) & sleep 0.4; exit 0`;
  const leader = spawn("sh", ["-lc", leaderCommand], {
    detached: true, stdio: "ignore", env: { ...process.env, ASH_MONITOR_UNIT: unitToken },
  });
  leader.unref();
  // 生产里这一步由 `spawnMonitor` 做:起完就把上一次全表扫描作废,否则读到的可能是这个进程
  // 存在之前的那份快照 ⇒ 记号找不着 ⇒ 判出一个假的「整项已退」(见 monitor-unit-scan.ts)。
  invalidateMonitorUnitScan();
  const pid = leader.pid!;
  await until("根还活着时记下它的启动时刻", async () => !!inspectProcess(pid)?.startedAt);
  const leaderStartedAt = inspectProcess(pid)!.startedAt;
  await until("根退干净、后代还活着", async () => !isPidAlive(pid) && isProcessGroupAlive(pid));
  const monId = await insertMonitorRow(taskId, {
    pid, pidStartedAt: leaderStartedAt, command: leaderCommand, unitToken,
  });

  await stopMonitorsForTask(taskId, "任务已删除", "destroy");
  if (monitorUnitProofGrade() === "exact") {
    // 真实环境项读得出来(Linux 的 `/proc/<pid>/environ` 是 NUL 分隔的)⇒ 这些后代是**证明过**
    // 的「我们的」,隔多久都认得回来,所以收尾时必须把它们一起收掉。
    assert.equal(isProcessGroupAlive(pid), false,
      "根已经不在了,带着这条记号的后代是证明过的「我们的」—— 收尾时必须把它们一起收掉");
    await assertDebtClosed(monId, "带记号的后代都收掉、线索追空之后才收档");
  } else {
    // **这台机器只拿得到无边界的 ps 展示文本**(第 14 轮审查 F1 实测:别的变量的值里写着这段
    // 文字就够让陌生进程挨刀),所以记号这一问在这里只能答「看得见」—— 它推翻「已经退出」,
    // 但签不出杀进程的凭证。照实钉住:一刀不下、责任留着、不收档。
    //
    // 注意**不是这一类残留都收不掉了**:根还活着那一刻的停止照旧按整组收(⑬-3 钉的就是那条
    // 路 —— 第一刀那会儿把成员连代次一起记下来,两秒后核代次再补刀)。这里是「根早就死了、
    // 我们从没见过它活着」的那一种。
    assert.equal(isProcessGroupAlive(pid), true, "展示文本签不出下刀凭证 ⇒ 一刀都不许下");
    const debt = await debtRow(monId);
    assert.ok(debt, "照记责任:证不出归属恰恰最该留责任");
    assert.equal(debt.closedAt, null, "也不许收档:线索还看得见,远没有追空");
    assert.match(debt.reason, /证不出|记号/, "账上要写清是哪一种不确定");
    killTree(pid, "SIGKILL");   // 产品收不掉它,台子自己清
    await until("后代被台子收掉", async () => !isProcessGroupAlive(pid));
  }
}

{
  // ⑩-9 **启动恢复也要覆盖「已停止但退出未确认」**:接回只枚举 running,债务清扫只认账本上
  // 已有的那几笔,中间漏的正是这一类(上一辈子停了它、信号发出去了、命令没死、又没留责任)。
  const taskId = await makeTask({ status: "done" });
  // 这一条的现场是**我们自己**上一辈子停下来的那条哨兵,所以台子跟生产一样带着这次创建的
  // 记号(`monitor-create.ts` 在起进程之前就种进环境):秒级读数只是粗判据,下刀要的第二份
  // 独立证据正是它(第 19 轮审查 F1)。
  const unitToken = `unit-stopped-${process.pid}-${Date.now()}`;
  const stray = spawn("sh", ["-lc", STUBBORN], {
    detached: true, stdio: "ignore", env: { PATH: process.env.PATH ?? "", ASH_MONITOR_UNIT: unitToken },
  });
  stray.unref();
  invalidateMonitorUnitScan();
  const pid = stray.pid!;
  await until("旁路进程起来了", async () => isProcessGroupAlive(pid));
  const monId = await insertMonitorRow(taskId, {
    status: "stopped", pid, pidStartedAt: inspectProcess(pid)?.startedAt ?? null, unitToken,
  });

  await reclaimUnconfirmedStops();
  assert.equal(isProcessGroupAlive(pid), false, "开机这一遍要把它收掉（身份对得上,敢下刀）");
  await assertDebtClosed(monId, "收干净之后收档");
}

{
  // ⑩-10 **ps 短暂不可用的那条路**(第 6 轮审查 F1 实测的那一条,端到端):
  // 接回 → 删除 → 重启清扫,三步都在「身份问不出来」的前提下必须守住不变量。
  const taskId = await makeTask({ status: "running" });
  const started = await startMonitor({ taskId, command: STUBBORN, description: "查询不可用时收尾的" });
  assert.equal(started.ok, true);
  const row = (await db.select().from(monitors).where(eq(monitors.taskId, taskId))).at(0)!;
  // 任务已经落终态 ⇒ 接回时会判它没有出口、当场收掉它(⑩-4 那条路),这次叠加 ps 不可用。
  await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, taskId));
  detachAllMonitors(); // = server 进程没了,哨兵进程照旧活着

  await withPsOutage(row.pid!, async () => {
    await reattachMonitors();
    const after = (await db.select().from(monitors).where(eq(monitors.id, row.id))).at(0)!;
    assert.doesNotMatch(after.endedReason ?? "", /已经不在了/,
      "ps 问不出身份时不许声称「这个进程已经不在了」—— 它还在跑,而这句话会让用户再也不回头看它");
    const debt = await debtRow(row.id);
    assert.ok(debt, "问不出身份恰恰是最该留责任的一档（第 5 轮这里直接返回空,删除据此把唯一线索抹掉）");
    assert.match(debt.reason, /判不出归属|答不出来/, "账上写清这一档是「问不出来」,不是「别人的进程」");
    assert.equal(isProcessGroupAlive(row.pid!), true, "问不出归属就不许下刀 —— 这个号可能已经是别人的");

    // 删除:责任已经在册 ⇒ 允许销毁身份,但那一笔必须活过删除。
    await deleteTaskCompletely(taskId);
    assert.equal((await db.select().from(monitors).where(eq(monitors.taskId, taskId))).length, 0, "哨兵行跟着任务没了");
    assert.ok(await debtRow(row.id), "任务行、哨兵行都没了,责任是这个进程最后的线索");
  });

  // ps 恢复 = 下一次开机。这一刻才第一次能判出身份,于是补杀 + 收档。
  await sweepMonitorReclaimDebts();
  assert.equal(isProcessGroupAlive(row.pid!), false, "ps 恢复后开机清扫必须把它收掉");
  await assertDebtClosed(row.id, "ps 恢复、补杀之后才收档");
}

{
  // ⑩-11 **删除核对那一侧的「问不出来」**:行已经非运行态、账本上还没人认它,偏偏这一刻
  // ps 又不可用。第 5 轮这一格是「不记也不杀」(理由是「没有证据说这一组是我们的」)——
  // 可那是**唯一**能留下线索的时刻,删除紧接着就把哨兵行连 pid 一起抹掉(第 6 轮审查 F1)。
  const taskId = await makeTask({ status: "done" });
  // 这一条的现场是**我们自己**上一辈子停下来的那条哨兵,所以台子跟生产一样带着这次创建的
  // 记号(`monitor-create.ts` 在起进程之前就种进环境):秒级读数只是粗判据,下刀要的第二份
  // 独立证据正是它(第 19 轮审查 F1)。
  const unitToken = `unit-stopped-${process.pid}-${Date.now()}`;
  const stray = spawn("sh", ["-lc", STUBBORN], {
    detached: true, stdio: "ignore", env: { PATH: process.env.PATH ?? "", ASH_MONITOR_UNIT: unitToken },
  });
  stray.unref();
  invalidateMonitorUnitScan();
  const pid = stray.pid!;
  await until("旁路进程起来了", async () => isProcessGroupAlive(pid));
  const monId = await insertMonitorRow(taskId, {
    status: "stopped", pid, pidStartedAt: inspectProcess(pid)?.startedAt ?? null, unitToken,
  });
  assert.equal(await debtRow(monId), undefined, "现场前提:账本上还没人认它");

  await withPsOutage(pid, async () => {
    await deleteTaskCompletely(taskId);
    const debt = await debtRow(monId);
    assert.ok(debt, "删除之前问不出身份时,责任必须落下来 —— 这一行马上就没了,之后谁都查不到它");
    assert.equal(debt.pid, pid, "责任上带着 pid");
    assert.equal(isProcessGroupAlive(pid), true, "身份问不出来就不许下刀");
  });

  await sweepMonitorReclaimDebts();
  assert.equal(isProcessGroupAlive(pid), false, "ps 恢复后开机清扫把它收掉");
  await assertDebtClosed(monId, "ps 恢复、补杀之后才收档");
}

{
  // ⑩-12 **接回时问不出身份 ⇒ 照旧接回来,不许写成「它已经不在了」**。
  //
  // 这一档上我们什么都不知道,所以什么都不许声称:行留在 running、界面上还能点停、日志
  // 继续收;ps 恢复之后探活那一问会自己判出结果。原来按 `isSameProcess` 一刀切,ps 一抽
  // 就把一条还活着的哨兵写成终态 —— 既撒谎,又让它从此无法叫停。
  const taskId = await makeTask({ status: "running" }); // 任务还在跑 ⇒ 出口是通的
  const started = await startMonitor({ taskId, command: STUBBORN, description: "查询不可用时接回的" });
  assert.equal(started.ok, true);
  const row = (await db.select().from(monitors).where(eq(monitors.taskId, taskId))).at(0)!;
  detachAllMonitors(); // = server 进程没了

  await withPsOutage(row.pid!, async () => {
    const recovery = await reattachMonitors();
    assert.equal(recovery.attached, 1, "问不出身份 ≠ 它不在了:这一条要接回来");
    const after = (await db.select().from(monitors).where(eq(monitors.id, row.id))).at(0)!;
    assert.equal(after.status, "running", "不许在这一档上落终态");
    // 探活那一问也归同一个判据:每两秒问一次,问不出来就等下一次,不许据此收尾。
    await new Promise((r) => setTimeout(r, 2600));
    const probed = (await db.select().from(monitors).where(eq(monitors.id, row.id))).at(0)!;
    assert.equal(probed.status, "running",
      "探活问不出身份时不许收尾 —— 那会在卡片上写「命令已经不在了」,而它还在跑");
  });

  // ps 恢复:它确实还是我们那个,所以照旧在跑;点停才收掉它。
  const alive = (await db.select().from(monitors).where(eq(monitors.id, row.id))).at(0)!;
  assert.equal(alive.status, "running", "ps 恢复后认出来还是它,照旧在盯");
  await stopMonitor(row.id, "测试收尾");
  assert.equal(isProcessGroupAlive(row.pid!), false, "点停要确认退出");
}

await teardown();
console.log("✓ 撤销期不许创建 / 枚举失败整笔不走 / 停止返回前确认退出或留下持久回收责任 / 接回问同一份出口资格 / 点停也走记责那一圈 / 删除按资源责任核对而非卡片状态 / 另一个进程与问不出来分档记责、都不下刀 / 组长退出按整组收 / 开机重收「已停止但没确认退出」/ ps 不可用时接回不撒谎、删除不丢责任、恢复后收掉 / 落盘失败走补记梯子 均受回归保护");
