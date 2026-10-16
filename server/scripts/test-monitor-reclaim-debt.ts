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
// ⑤ **说法要跟事实同步**:接回时那句「已记下回收责任」必须由最终 verdict 决定。先写肯定、
//    再在 server 日志里纠正不算纠正 —— 卡片上那句话会一直留着(第 7 轮审查 N1)。
// ⑦ **身份不全不等于有权回收。** `pid_started_at` 为空的行(存量行,或 pid 回填那一刻 ps 恰好
//    答不出启动时刻的行)原来在 `processIdentity` 里走到 `same` —— 「没什么可比对的,那就是同
//    一个」⇒ `ours-alive` ⇒ 下刀。那条路上**「这个号上有进程活着」被当成了「已证明有权回收
//    它」**:原命令早已跑完、号被系统复用时,打的是别人的进程(第 9 轮审查 F3)。
// ⑥ **身份这一问只许查一次,而且三档都要带回来。** 判定在 `proc.ts` 的 `processIdentity`:
//    `ps -o lstart` 跟随 locale,原文不等**不等于**不是同一个进程。上一版在原文不等时又查了
//    一次 ps 去兼容 locale,第二次恰好失败就被写成确证的「这个号现在是别人」—— 一条还在跑的
//    哨兵因此被接回判成 lost、随后按债杀掉(第 7 轮审查 F1)。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import {
  db, insertMonitorRow, isPidAlive, makeTask, monitors, reattachMonitors, reviewInFlight,
  detachAllMonitors, root, schema, startMonitor, stopMonitor, tasks, teardown, until,
} from "./monitors-fixture.js";
import { inspectProcess } from "../src/proc.js";

const { stopMonitorsForTask, reclaimUnconfirmedStops } = await import("../src/monitor-reclaim.js");
const { monitorWakeGate } = await import("../src/monitor-session.js");
const { beginTaskRevocation, isTaskRevoked, releaseTaskRevocation } = await import("../src/claude-monitor-revoked.js");
const { deleteTaskCompletely } = await import("../src/task-delete-routes.js");
const { reclaimState, sweepMonitorReclaimDebts } = await import("../src/monitor-reclaim-debts.js");
const { isProcessGroupAlive, killTree } = await import("../src/platform.js");
const { dbClient } = await import("../src/db/index.js");

// 忽略 TERM 的命令:壳自己 trap 掉,每轮重起一个 sleep —— TERM 打到整组时组里始终有人,
// 只有 +2 秒那把 SIGKILL 才收得掉它。(同一招在 test-project-commands.ts 里也用着)
const STUBBORN = "trap '' TERM HUP INT; while :; do sleep 0.2; done";

const debtRow = async (monId: string) => (await db.select().from(schema.monitorReclaimDebts)
  .where(eq(schema.monitorReclaimDebts.monitorId, monId))).at(0);

/**
 * 让「身份这一问」在一段时间里真的失败:PATH 前置一个退出码 1 的 `ps`。
 *
 * 不替换产品里的任何函数 —— `inspectProcessSync` 就是 `execFileSync("ps", …)` 带着
 * `process.env`,所以这是真实的故障现场(审查的复现脚本用的也是这一招)。`kill(pid,0)` 和
 * `kill(-pgid,0)` 不走 ps,所以「它还活着吗」照旧问得出来 —— 这正是两档能分开的依据。
 */
const brokenBin = join(root, "broken-bin");
mkdirSync(brokenBin, { recursive: true });
writeFileSync(join(brokenBin, "ps"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
async function withPsOutage(pid: number, body: () => Promise<void>): Promise<void> {
  const real = process.env.PATH ?? "";
  process.env.PATH = `${brokenBin}:${real}`;
  try {
    assert.equal(inspectProcess(pid), null, "台子前提:这段时间 ps 真的问不出来");
    assert.equal(isPidAlive(pid), true, "台子前提:而它确实还活着（kill(pid,0) 不走 ps）");
    await body();
  } finally {
    process.env.PATH = real;
  }
}

/**
 * 另一副台子:**ps 答得出来,但每一次调用都记一笔**,而且可以切成「奇数次正常、偶数次失败」
 * 的间歇性故障(第 7 轮审查 F1 的复现脚本用的也是这一招)。
 *
 * 它回答的是另一个问题 —— 不是「这段时间问不出来」(`withPsOutage`),而是「**问了几次**、
 * 第二次失败会不会被当成一个确证的答案」。同样不替换产品里的任何函数:包装器就叫 `ps`,
 * 放在 PATH 最前面,真实的 `execFileSync("ps", …)` 打到的就是它。
 */
const flakyBin = join(root, "flaky-ps-bin");
mkdirSync(flakyBin, { recursive: true });
const psCalls = join(root, "ps-calls");
const psMode = join(root, "ps-mode");
writeFileSync(join(flakyBin, "ps"), `#!/bin/sh
printf x >> "${psCalls}"
if [ "$(cat "${psMode}" 2>/dev/null)" = "flaky" ]; then
  n=$(wc -c < "${psCalls}" | tr -d ' ')
  if [ $((n % 2)) -eq 0 ]; then exit 1; fi
fi
if [ -x /bin/ps ]; then exec /bin/ps "$@"; fi
exec /usr/bin/ps "$@"
`, { mode: 0o755 });
const psCallCount = (): number => readFileSync(psCalls, "utf8").length;
async function withCountedPs(mode: "count" | "flaky", body: () => Promise<void>): Promise<void> {
  const real = process.env.PATH ?? "";
  writeFileSync(psCalls, "");
  writeFileSync(psMode, mode);
  process.env.PATH = `${flakyBin}:${real}`;
  try {
    await body();
  } finally {
    process.env.PATH = real;
  }
}

/**
 * 同一秒的**中文 locale 写法** —— 旧 server(没有 `LC_ALL=C` 那一版)存进 DB 的就是这个样子,
 * 而现在 `inspectProcessSync` 固定问出英文。两串原文不相等、指向同一秒,是代码**明确支持**
 * 的历史兼容场景(见 `proc.ts` 的 `parseStartedAt`),不是假造一个错误身份。
 */
const zhLstart = (lstart: string): string => {
  const d = new Date(Date.parse(lstart));
  const p = (n: number) => String(n).padStart(2, "0");
  return `${"日一二三四五六"[d.getDay()]} ${d.getMonth() + 1}月/ ${d.getDate()}`
    + ` ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} ${d.getFullYear()}`;
};


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
  // 库恢复之后那一笔要**自己补记上**:落盘失败挂的是补记梯子,不是销账梯子 —— 销账梯子读
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
    assert.match(debt.reason, /判不出身份|查询不可用/, "账上写清这一档是「问不出来」,不是「别人的进程」");
    assert.equal(isProcessGroupAlive(row.pid!), true, "问不出身份就不许下刀 —— 这个号可能已经是别人的");

    // 删除:责任已经在册 ⇒ 允许销毁身份,但那一笔必须活过删除。
    await deleteTaskCompletely(taskId);
    assert.equal((await db.select().from(monitors).where(eq(monitors.taskId, taskId))).length, 0, "哨兵行跟着任务没了");
    assert.ok(await debtRow(row.id), "任务行、哨兵行都没了,责任是这个进程最后的线索");
  });

  // ps 恢复 = 下一次开机。这一刻才第一次能判出身份,于是补杀 + 销账。
  await sweepMonitorReclaimDebts();
  assert.equal(isProcessGroupAlive(row.pid!), false, "ps 恢复后开机清扫必须把它收掉");
  assert.equal(await debtRow(row.id), undefined, "确认收干净了才销账");
}

{
  // ⑩-11 **删除核对那一侧的「问不出来」**:行已经非运行态、账本上还没人认它,偏偏这一刻
  // ps 又不可用。第 5 轮这一格是「不记也不杀」(理由是「没有证据说这一组是我们的」)——
  // 可那是**唯一**能留下线索的时刻,删除紧接着就把哨兵行连 pid 一起抹掉(第 6 轮审查 F1)。
  const taskId = await makeTask({ status: "done" });
  const stray = spawn("sh", ["-lc", STUBBORN], { detached: true, stdio: "ignore" });
  stray.unref();
  const pid = stray.pid!;
  await until("旁路进程起来了", async () => isProcessGroupAlive(pid));
  const monId = await insertMonitorRow(taskId, {
    status: "stopped", pid, pidStartedAt: inspectProcess(pid)?.startedAt ?? null,
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
  assert.equal(await debtRow(monId), undefined, "确认收干净了才销账");
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

// ── ⑪ 身份只许查一次:locale 不同 ≠ 另一个进程,第二次查询失败 ≠ 确证身份不符 ──────────
//
// 第 7 轮审查 F1。判定本体收在 `proc.ts` 的 `processIdentity`(一次快照 + 纯比较 + 三档),
// 这三条钉的就是那三件事:判得对、只查一次、以及端到端不会因此杀掉一条活着的哨兵。
{
  const taskId = await makeTask({ status: "running" });   // 任务还在跑 ⇒ 出口是通的
  const started = await startMonitor({ taskId, command: STUBBORN, description: "记录是旧 locale 的" });
  assert.equal(started.ok, true);
  const row = (await db.select().from(monitors).where(eq(monitors.taskId, taskId))).at(0)!;
  const pid = row.pid!;
  // 把库里那一列换成**中文写法的同一秒**(= 旧 server 留下的存量行)。
  const zh = zhLstart(row.pidStartedAt!);
  assert.notEqual(zh, row.pidStartedAt, "台子前提:两串原文确实不相等");
  await db.update(monitors).set({ pidStartedAt: zh }).where(eq(monitors.id, row.id));

  // ⑪-1 原文不等但指向同一秒 ⇒ 还是我们的那个;而且**整个判定只查一次 ps**。
  //
  // 「只查一次」是这一条的要点,不是性能讲究:在确证分支里再调一次会吞掉失败信息的查询,
  // 正是 F1 的根。它只有在这里被钉住,下一个人才不会又在消费者那边补一次重试。
  await withCountedPs("count", async () => {
    assert.equal(reclaimState(pid, zh), "ours-alive", "locale 不同不是「这个号现在是另一个进程」");
    assert.equal(psCallCount(), 1, "身份判定只许查一次 —— 补第二次查询就是 F1 的根");
  });

  // ⑪-2 **第二次查询失败不许改写身份**:奇数次正常、偶数次失败的间歇性故障现场。
  await withCountedPs("flaky", async () => {
    assert.equal(reclaimState(pid, zh), "ours-alive",
      "第一次就已经答出来了;再查一次、那一次恰好失败,不构成「这个号现在是别人」");
  });

  // ⑪-3 端到端:接回不许写 lost、不许留责任,随后的开机清扫更不许杀它。
  detachAllMonitors();                                     // = server 进程没了
  await withCountedPs("flaky", async () => {
    const recovery = await reattachMonitors();
    assert.equal(recovery.attached, 1, "它还是我们起的那个命令:接回来");
    assert.equal(recovery.lost, 0, "一次查询故障不许把它说成已经没了");
  });
  const after = (await db.select().from(monitors).where(eq(monitors.id, row.id))).at(0)!;
  assert.equal(after.status, "running", "不许写成 lost —— 那之后它就再也点不停了");
  assert.equal(await debtRow(row.id), undefined, "没有要回收的责任:它好好地在盯着");
  await sweepMonitorReclaimDebts();
  assert.equal(isProcessGroupAlive(pid), true, "清扫绝不许碰一条还活着的哨兵");

  // ⑪-4 **还原不出时间戳 ⇒ 这一次比不出来**,不是「不是同一个」。存量行里有一条记成了谁也
  // 不认识的写法时,我们能证明的只有「问不出结果」—— 据此声称「这个号现在是别人」同样是在
  // 把一次失败当成确证的事实(跟 F1 是同一个错,只是失败发生在还原那一步而不是查询那一步)。
  await db.update(monitors).set({ pidStartedAt: "这不是任何 locale 的 lstart" })
    .where(eq(monitors.id, row.id));
  assert.equal(reclaimState(pid, "这不是任何 locale 的 lstart"), "unknown",
    "比不出来是 `unknown` 那一档:留责任、不下刀,而不是确证的 `not-ours`");

  // 收尾前把那一列改回去:`unknown` 这一档**不许下刀**(所以点停收不掉它,见 ⑩-11),
  // 而这个进程确实是我们的,台子自己负责清场。
  await db.update(monitors).set({ pidStartedAt: row.pidStartedAt }).where(eq(monitors.id, row.id));
  await stopMonitor(row.id, "测试收尾");
  assert.equal(isProcessGroupAlive(pid), false, "点停才收掉它");
}

// ── ⑫ 卡片上那句话由**最终 verdict**决定,不是「先写肯定、再在日志里纠正」(第 7 轮审查 N1)──
//
// 接回判出 `not-ours`/`ours-orphans` 时,上一版无论回收结果是什么都先把「已记下回收责任」写进
// 卡片,只有 `unaccounted` 那一档在 server 日志里被纠正过 —— 于是债表其实一个字都没写进去,
// 而卡片上那句肯定会一直留着(刷新页面也还在)。这跟前几轮那些洞是同一个形状:**把一次没做成
// 的事说成已经做成**。
{
  const taskId = await makeTask({ status: "running" });
  const started = await startMonitor({ taskId, command: STUBBORN, description: "接回时责任落不下来的" });
  assert.equal(started.ok, true);
  const row = (await db.select().from(monitors).where(eq(monitors.taskId, taskId))).at(0)!;
  const pid = row.pid!;
  // 把记录的启动时刻挪**一秒**(格式仍然合法、仍然解析得出)⇒ 接回时判成 `not-ours`:这个号上
  // 现在是别人,原来那个退没退证明不了。`fresh:false` 这一档不许下刀,所以进程留着,正好。
  const shifted = row.pidStartedAt!.replace(/(\d{2}):(\d{2}):(\d{2})/,
    (_m, h, mi, se) => `${h}:${mi}:${String((Number(se) + 1) % 60).padStart(2, "0")}`);
  assert.notEqual(shifted, row.pidStartedAt, "台子前提:换成了另一个时刻");
  await db.update(monitors).set({ pidStartedAt: shifted }).where(eq(monitors.id, row.id));
  assert.equal(reclaimState(pid, shifted), "not-ours", "台子前提:这一档确实是 not-ours");
  detachAllMonitors();   // = server 进程没了

  // 债表这一刻写不进去(真触发器,不替换产品里的任何函数)⇒ verdict = unaccounted。
  await dbClient.execute("CREATE TRIGGER fixture_block_debt BEFORE INSERT ON monitor_reclaim_debts"
    + " BEGIN SELECT RAISE(ABORT, 'INJECTED_DEBT_INSERT_FAILURE'); END");
  try {
    await reattachMonitors();
  } finally {
    await dbClient.execute("DROP TRIGGER IF EXISTS fixture_block_debt");
  }
  const after = (await db.select().from(monitors).where(eq(monitors.id, row.id))).at(0)!;
  assert.equal(after.status, "lost");
  assert.equal(await debtRow(row.id), undefined, "台子前提:这一轮责任确实一个字都没落进去");
  assert.match(after.endedReason ?? "", /回收责任尚未保存/,
    "卡片上要照实说「还没保存」—— 只在 server 日志里纠正等于没纠正(刷新页面那句肯定还在)");
  assert.doesNotMatch(after.endedReason ?? "", /已记下回收责任/,
    "**不许**在责任没落盘的时候说它已经记下了");

  // 清场:这一档不下刀,所以进程还活着 —— 台子自己收掉它,别让它活过这次测试。
  killTree(pid, "SIGKILL");
  await until("顽固进程被收掉", async () => !isProcessGroupAlive(pid));
  await db.delete(schema.monitorReclaimDebts).where(eq(schema.monitorReclaimDebts.monitorId, row.id));
}

{
  // ⑦ **身份不全不等于有权回收**(第 9 轮审查 F3-A,判定本体在 `proc.ts`:缺原代次时留
  //    「证不出」而不是「就是同一个」)。现场:行上只记得一个号、没记启动时刻,而这个号上
  //    现在确实有个顽固进程 —— 它不是我们起的。
  const taskId = await makeTask({ status: "done" });
  const stranger = spawn("sh", ["-lc", STUBBORN], { detached: true, stdio: "ignore" });
  stranger.unref();
  const pid = stranger.pid!;
  await until("旁路进程起来了", async () => isProcessGroupAlive(pid));
  assert.equal(reclaimState(pid, null), "unverifiable",
    "「号上有进程、但当初没记启动时刻」必须自成一档 —— 折进 ours-alive 就是拿「存在」当「所有权」");

  const monId = await insertMonitorRow(taskId, { status: "stopped", pid, pidStartedAt: null });
  assert.equal(await debtRow(monId), undefined, "现场前提:账本上还没人认它");
  await deleteTaskCompletely(taskId);
  const debt = await debtRow(monId);
  assert.ok(debt, "证不出身份恰恰最该留责任:这一行马上就没了,pid 是它最后的线索");
  assert.equal(debt.pid, pid);
  assert.match(debt.reason, /证不出|不敢下刀/,
    "账上要写清这一档是「证不出是原来那个」—— 既不是「还活着」(那是在声称所有权)也不是「别人的」");
  assert.equal(isProcessGroupAlive(pid), true, "**一刀都不许下**:证不出是原来那个就不许杀");

  // 身份补全(例如运行时后来把真实启动时刻回填到了债上)= 这一刻第一次证得出 ⇒ 才轮到补杀销账。
  await db.update(schema.monitorReclaimDebts)
    .set({ pidStartedAt: inspectProcess(pid)?.startedAt ?? null })
    .where(eq(schema.monitorReclaimDebts.monitorId, monId));
  await sweepMonitorReclaimDebts();
  assert.equal(isProcessGroupAlive(pid), false, "身份补全之后才收得掉它");
  assert.equal(await debtRow(monId), undefined, "确认收干净了才销账");
}

await teardown();
console.log("✓ 撤销期不许创建 / 枚举失败整笔不走 / 停止返回前确认退出或留下持久回收责任 / 接回问同一份出口资格 / 点停也走记责那一圈 / 删除按资源责任核对而非卡片状态 / 另一个进程与问不出来分档记责、都不下刀 / 组长退出按整组收 / 开机重收「已停止但没确认退出」/ ps 不可用时接回不撒谎、删除不丢责任、恢复后收掉 / 落盘失败走补记梯子 / 身份只查一次:locale 不同与第二次查询失败都不是「另一个进程」/ 接回文案由最终 verdict 决定,责任没落盘就照实说 / 身份不全只留「证不出」:记责、不下刀,补全后才收");
