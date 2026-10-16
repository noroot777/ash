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
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { eq } from "drizzle-orm";
import {
  db, insertMonitorRow, isPidAlive, makeTask, monitors, reattachMonitors, reviewInFlight,
  detachAllMonitors, schema, startMonitor, stopMonitor, tasks, teardown, until,
} from "./monitors-fixture.js";
import { inspectProcess } from "../src/proc.js";

const { stopMonitorsForTask, reclaimUnconfirmedStops } = await import("../src/monitor-reclaim.js");
const { monitorWakeGate } = await import("../src/monitor-session.js");
const { beginTaskRevocation, isTaskRevoked, releaseTaskRevocation } = await import("../src/claude-monitor-revoked.js");
const { deleteTaskCompletely } = await import("../src/task-delete-routes.js");
const { sweepMonitorReclaimDebts } = await import("../src/monitor-reclaim-debts.js");
const { isProcessGroupAlive, killTree } = await import("../src/platform.js");

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
  // ⑩-1 **正常停止也要走「落责任 → 发信号 → 确认退出 → 销账」这一圈**(第 4 轮审查 F1)。
  // 收干净了就不留垃圾:返回时进程确认不在了,债表上一条也没有。
  const taskId = await makeTask({ status: "running" });
  const started = await startMonitor({ taskId, command: "sleep 120", description: "正常收掉的" });
  assert.equal(started.ok, true);
  const row = (await db.select().from(monitors).where(eq(monitors.taskId, taskId))).at(0)!;
  await stopMonitorsForTask(taskId, "任务已删除", "destroy");
  assert.equal(isPidAlive(row.pid!), false,
    "`stopMonitorsForTask` 返回时必须已经确认退出 —— 发完信号就返回的话,补刀那两秒里 server 一退出它就永远留下了（F1）");
  assert.equal((await db.select().from(schema.monitorReclaimDebts)
    .where(eq(schema.monitorReclaimDebts.monitorId, row.id))).length, 0,
    "确认收干净了就销账,不留垃圾行");
}

{
  // ⑩-2 **确认不了退出 ⇒ 责任留下来**,而且只认「确认它不在了」才销账。
  //
  // 这里的现场是「身份问不出来」:进程组里明明有人,而 `pid_started_at` 对不上(locale 变了、
  // pid 被复用、ps 不可用都会这样)。那时既不敢杀(杀错人不可逆),更不许销账 —— 旧写法拿
  // `isSameProcess=false` 直接销账,等于把最后一份责任丢掉(第 4 轮审查 F1 的并条之一)。
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

  // 开机清扫:身份还是问不出来 ⇒ 照旧不杀、不销账。
  await sweepMonitorReclaimDebts();
  assert.ok(await debtOf(), "「查不出身份」不等于「它已经退了」,不许据此销账");
  assert.equal(isPidAlive(pid), true, "也不许在身份不明时下刀");

  // 身份又对上了(ps 恢复 / 换回原 locale):这才轮到补杀 + 销账。
  await db.update(schema.monitorReclaimDebts).set({ pidStartedAt: realStartedAt })
    .where(eq(schema.monitorReclaimDebts.monitorId, monId));
  await sweepMonitorReclaimDebts();
  assert.equal(isPidAlive(pid), false, "认出来了就必须把它收掉（SIGKILL,不再等第二个两秒）");
  assert.equal(await debtOf(), undefined, "确认不在了才销账");
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

// 忽略 TERM 的命令:壳自己 trap 掉,每轮重起一个 sleep —— TERM 打到整组时组里始终有人,
// 只有 +2 秒那把 SIGKILL 才收得掉它。(同一招在 test-project-commands.ts 里也用着)
const STUBBORN = "trap '' TERM HUP INT; while :; do sleep 0.2; done";

const debtRow = async (monId: string) => (await db.select().from(schema.monitorReclaimDebts)
  .where(eq(schema.monitorReclaimDebts.monitorId, monId))).at(0);

{
  // ⑩-5 **这一圈归运行时收尾层,不归包装函数**(第 5 轮审查 F1)。
  //
  // 第 4 轮把「落责任 → 发信号 → 确认退出 → 销账」装在了删除/审查收尾那两个入口上,于是
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
  assert.equal(await debtRow(row.id), undefined, "确认收干净了才销账,不留垃圾行");
}

{
  // ⑩-6 **删除按资源责任核对,不按卡片状态**:行早就是 stopped、进程却还活着的那条路
  //(上一辈子停的、或者停到一半崩的),照状态过滤就整条跳过了它。
  const taskId = await makeTask({ status: "done" });
  const stray = spawn("sh", ["-lc", STUBBORN], { detached: true, stdio: "ignore" });
  stray.unref();
  const pid = stray.pid!;
  await until("旁路进程起来了", async () => isProcessGroupAlive(pid));
  const monId = await insertMonitorRow(taskId, {
    status: "stopped", pid, pidStartedAt: inspectProcess(pid)?.startedAt ?? null,
  });
  assert.equal(await debtRow(monId), undefined, "现场前提:账本上没人认它（旧版本停下来时不记责任）");

  await deleteTaskCompletely(taskId);
  assert.equal(isProcessGroupAlive(pid), false,
    "「已停止」只说明有人发过信号,不说明它退了。删除必须按责任核对全部归属行（第 5 轮审查 F1）");
  assert.equal(await debtRow(monId), undefined, "确认收掉了就不留账");
}

{
  // ⑩-7 **认不出身份的那一档,删除时不记账也不下刀**(跟上一条配对的反面)。
  //
  // 这一行可能是上一辈子停下来的,`pid_started_at` 对不上就说明这个号可能已经是别人的了 ——
  // 下刀不可逆,而记一笔永远销不掉的账只会把账本变成噪音。所以只出声。`running` 的行不走
  // 这一档:那时进程是我们自己起的,照旧记责任（⑩-2）。
  const taskId = await makeTask({ status: "done" });
  const stray = spawn("sleep", ["300"], { detached: true, stdio: "ignore" });
  stray.unref();
  const pid = stray.pid!;
  const monId = await insertMonitorRow(taskId, {
    status: "stopped", pid, pidStartedAt: "Thu Jan  1 00:00:00 2020",
  });
  await deleteTaskCompletely(taskId);
  assert.equal(isPidAlive(pid), true, "身份对不上就不敢杀 —— 那个号可能已经是别人的了");
  assert.equal(await debtRow(monId), undefined,
    "也不记账:没有任何证据说这一组是我们的,记下来就是一笔永远销不掉的账");
  killTree(pid, "SIGKILL"); // 测试自己收场
  await until("收掉旁路进程", async () => !isPidAlive(pid));
}

{
  // ⑩-8 **组长退出不等于整组后代已退出**。命令自己跑完、重启探活都是按组长身份判结束的,
  // 而外层壳退了、它派生的那个还留在组里才是最常见的泄漏形态。收尾那一层要按**整组**收。
  const taskId = await makeTask({ status: "done" });
  const leader = spawn("sh", ["-lc", `(${STUBBORN}) & exit 0`], { detached: true, stdio: "ignore" });
  leader.unref();
  const pid = leader.pid!;
  await until("组长退干净、后代还在组里", async () => !isPidAlive(pid) && isProcessGroupAlive(pid));
  const monId = await insertMonitorRow(taskId, { pid, pidStartedAt: inspectProcess(pid)?.startedAt ?? null });

  await stopMonitorsForTask(taskId, "任务已删除", "destroy");
  assert.equal(isProcessGroupAlive(pid), false,
    "组长已经不在了,组里剩的只能是它的后代（这个号现在是空的,没人能当这一组的组长）—— 收尾时必须把它们一起收掉");
  assert.equal(await debtRow(monId), undefined, "确认整组空了才销账");
}

{
  // ⑩-9 **启动恢复也要覆盖「已停止但退出未确认」**:接回只枚举 running,债务清扫只认账本上
  // 已有的那几笔,中间漏的正是这一类(上一辈子停了它、信号发出去了、命令没死、又没留责任)。
  const taskId = await makeTask({ status: "done" });
  const stray = spawn("sh", ["-lc", STUBBORN], { detached: true, stdio: "ignore" });
  stray.unref();
  const pid = stray.pid!;
  await until("旁路进程起来了", async () => isProcessGroupAlive(pid));
  const monId = await insertMonitorRow(taskId, {
    status: "stopped", pid, pidStartedAt: inspectProcess(pid)?.startedAt ?? null,
  });

  await reclaimUnconfirmedStops();
  assert.equal(isProcessGroupAlive(pid), false, "开机这一遍要把它收掉（身份对得上,敢下刀）");
  assert.equal(await debtRow(monId), undefined, "收干净了就不留账");
}

await teardown();
console.log("✓ 撤销期不许创建 / 枚举失败整笔不走 / 停止返回前确认退出或留下持久回收责任 / 接回问同一份出口资格 / 点停也走记责那一圈 / 删除按资源责任核对而非卡片状态 / 认不出身份不记不杀 / 组长退出按整组收 / 开机重收「已停止但没确认退出」");
