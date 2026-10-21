// **身份这一问的判定本身:问出来的那个答案到底证明了什么。**
//
// 姊妹篇 test-monitor-reclaim-debt.ts 钉的是回收这一侧的流程(撤销期、确认退出、记责那一圈)。
// 这一份钉它依赖的那个前提 —— 「这个号上的进程还是当初那一个」到底算不算证明出来了,以及
// 「证不出来」那一刻卡片上该写什么:
//
// ⑤ **说法要跟事实同步**:接回时那句「已记下回收责任」必须由最终 verdict 决定。先写肯定、
//    再在 server 日志里纠正不算纠正 —— 卡片上那句话会一直留着(第 7 轮审查 N1)。
// ⑧ **身份不全有两面,回收资格和补全机会都要照顾到**(第 10 轮审查 F2):孤儿组(组长已退、
//    组里还有后代)上一版不看代次就直接算「我们的」⇒ `fresh` 下发组击杀 —— 活根那条路被拒掉
//    之后又从这条路绕回了下刀资格;另一面是**补全机会不许丢**:接回那一刻 ps 不可用时只回填
//    了 pid、启动时刻留空,而那之后再没有人会去读身份边条,于是「这一刻问不出来」被永久固化成
//    「这条永远证不出身份」。锚(边条 + 债上那一列)和重试要一起留着。
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
  db, insertMonitorRow, isPidAlive, makeTask, monitors, reattachMonitors,
  detachAllMonitors, root, schema, startMonitor, stopMonitor, teardown, until,
} from "./monitors-fixture.js";
import { STUBBORN, assertDebtClosed, debtRow, withPsOutage } from "./monitor-reclaim-fixture.js";
import { inspectProcess } from "../src/proc.js";

const { stopMonitorsForTask } = await import("../src/monitor-reclaim.js");
const { deleteTaskCompletely } = await import("../src/task-delete-routes.js");
const { sweepMonitorReclaimDebts } = await import("../src/monitor-reclaim-debts.js");
const { reclaimState } = await import("../src/monitor-reclaim-evidence.js");
const { isProcessGroupAlive, killTree } = await import("../src/platform.js");
const { dbClient } = await import("../src/db/index.js");

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

// ── ⑪ 身份只许查一次:locale 不同 ≠ 另一个进程,第二次查询失败 ≠ 确证身份不符 ──────────
//
// 第 7 轮审查 F1。判定本体收在 `proc.ts` 的 `processIdentity`(一次快照 + 纯比较 + 三档),
// 这三条钉的就是那三件事:判得对、只查一次、以及端到端不会因此杀掉一条活着的哨兵。
{
  const taskId = await makeTask({ status: "running" });   // 任务还在跑 ⇒ 出口是通的
  const started = await startMonitor({ taskId, command: STUBBORN, description: "记录是旧 locale 的", untilExpiry: true });
  assert.equal(started.ok, true);
  const row = (await db.select().from(monitors).where(eq(monitors.taskId, taskId))).at(0)!;
  const pid = row.pid!;
  // 把库里那一列换成**中文写法的同一秒**(= 旧 server 留下的存量行)。记号那一列一起清掉:
  // 旧 server 根本不记它,而**有记号的行由记号直接判归属,走不到 locale 比较这一步**——
  // 留着它这一节就变成在考记号,locale 这条路反而没人钉了。
  const zh = zhLstart(row.pidStartedAt!);
  assert.notEqual(zh, row.pidStartedAt, "台子前提:两串原文确实不相等");
  await db.update(monitors).set({ pidStartedAt: zh, unitToken: null }).where(eq(monitors.id, row.id));
  const legacy = { unitToken: null, command: row.command };   // 存量行:只有 pid + 启动时刻

  // ⑪-1 原文不等但指向同一秒 ⇒ 还是我们的那个;而且**整个判定只查一次 ps**。
  //
  // 「只查一次」是这一条的要点,不是性能讲究:在确证分支里再调一次会吞掉失败信息的查询,
  // 正是 F1 的根。它只有在这里被钉住,下一个人才不会又在消费者那边补一次重试。
  //
  // **这一节钉的是「判得对」,不是「可以下刀」**(第 19 轮审查 F1 改的就是后半句):存量行只有
  // 秒级读数这一条粗判据,所以它落在 `unverifiable`(记责任、不下刀)而不是 `ours-alive`。
  // 要紧的是它**不是** `not-ours` —— locale 不同仍然被认成同一个进程,否则接回就会把一条活着
  // 的哨兵写成 lost(F1 的那条路)。
  await withCountedPs("count", async () => {
    const state = reclaimState(pid, zh, legacy);
    assert.notEqual(state, "not-ours", "locale 不同不是「这个号现在是另一个进程」");
    assert.equal(state, "unverifiable", "但存量行的秒级读数只是粗判据:记责任、不下刀");
    assert.equal(psCallCount(), 1, "身份判定只许查一次 —— 补第二次查询就是 F1 的根");
  });

  // ⑪-2 **第二次查询失败不许改写身份**:奇数次正常、偶数次失败的间歇性故障现场。
  await withCountedPs("flaky", async () => {
    assert.equal(reclaimState(pid, zh, legacy), "unverifiable",
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
  assert.equal(reclaimState(pid, "这不是任何 locale 的 lstart", legacy), "unknown",
    "比不出来是 `unknown` 那一档:留责任、不下刀,而不是确证的 `not-ours`");

  // 收尾:把那一列改回去也收不掉它 —— 这一节整段都是**存量行**(记号那一列被清空了),而秒级
  // 读数是粗判据(第 19 轮审查 F1)。点停照旧只记责任,进程由台子自己清场。
  await db.update(monitors).set({ pidStartedAt: row.pidStartedAt }).where(eq(monitors.id, row.id));
  await stopMonitor(row.id, "测试收尾");
  assert.equal(isProcessGroupAlive(pid), true, "存量行点停只记责任:证不出排他归属就一刀不发");
  assert.ok(await debtRow(row.id), "责任落在表上");
  killTree(pid, "SIGKILL");
  await until("台子自己把它收掉", async () => !isProcessGroupAlive(pid));
}

// ── ⑫ 卡片上那句话由**最终 verdict**决定,不是「先写肯定、再在日志里纠正」(第 7 轮审查 N1)──
//
// 接回判出 `not-ours`/`ours-orphans` 时,上一版无论回收结果是什么都先把「已记下回收责任」写进
// 卡片,只有 `unaccounted` 那一档在 server 日志里被纠正过 —— 于是债表其实一个字都没写进去,
// 而卡片上那句肯定会一直留着(刷新页面也还在)。这跟前几轮那些洞是同一个形状:**把一次没做成
// 的事说成已经做成**。
{
  const taskId = await makeTask({ status: "running" });
  const started = await startMonitor({ taskId, command: STUBBORN, description: "接回时责任落不下来的", untilExpiry: true });
  assert.equal(started.ok, true);
  const row = (await db.select().from(monitors).where(eq(monitors.taskId, taskId))).at(0)!;
  const pid = row.pid!;
  // 把记录的启动时刻挪**一秒**(格式仍然合法、仍然解析得出)⇒ 接回时判成 `not-ours`:这个号上
  // 现在是别人,原来那个退没退证明不了。`fresh:false` 这一档不许下刀,所以进程留着,正好。
  const shifted = row.pidStartedAt!.replace(/(\d{2}):(\d{2}):(\d{2})/,
    (_m, h, mi, se) => `${h}:${mi}:${String((Number(se) + 1) % 60).padStart(2, "0")}`);
  assert.notEqual(shifted, row.pidStartedAt, "台子前提:换成了另一个时刻");
  // 记号一起清掉:`not-ours` 只可能落在**存量行**上 —— 带着记号的行归属是证得出来的,
  // 一个对不上的时刻改不了它(那正是上一轮 F1-A 要的:时刻和命令都不是凭证)。
  await db.update(monitors).set({ pidStartedAt: shifted, unitToken: null }).where(eq(monitors.id, row.id));
  assert.equal(reclaimState(pid, shifted, { unitToken: null }), "not-ours", "台子前提:这一档确实是 not-ours");
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
  assert.equal(reclaimState(pid, null, { unitToken: null }), "unverifiable",
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

  // 把真实启动时刻回填到债上(= 运行时后来补了一次身份)。**这一行没有记号**,而秒级读数是
  // 粗判据:同一秒里起来的两个进程读数逐字相同(第 19 轮审查 F1 实测 `coarse-identity-risk.log`
  // ——按这条粗判据下刀的那一次,挨刀的是审查自己起的无关进程)。所以存量行补到这一步也只
  // 到「责任留着」,一刀不发;带记号的行才补得出第二份独立证据(create-protocol ③ 走那条路)。
  await db.update(schema.monitorReclaimDebts)
    .set({ pidStartedAt: inspectProcess(pid)?.startedAt ?? null })
    .where(eq(schema.monitorReclaimDebts.monitorId, monId));
  await sweepMonitorReclaimDebts();
  assert.equal(isProcessGroupAlive(pid), true, "存量行的粗档认不出排他归属 ⇒ 补刀一律不发");
  assert.ok(await debtRow(monId), "责任照旧留着");
  killTree(pid, "SIGKILL");
  await until("台子自己把这个陌生进程收掉", async () => !isProcessGroupAlive(pid));
  await sweepMonitorReclaimDebts();                 // 线索真追空了,这一遍才收得了档
  await assertDebtClosed(monId, "线索追空之后才收档");
}

{
  // ⑧-1 **孤儿组也要有可验证的代次**(第 10 轮审查 F2-A)。
  //    组长已退、组里还有后代,而这一行没记下代次 —— 这一刻我们手里什么都证不出来:组号就是
  //    当初那个 pid,老组退干净、同号被另一组复用且新组长先退出时,长得跟这一幕一模一样。
  //    上一版这一档直接回 `ours-orphans`,而它在 `fresh` 下是**发组击杀信号**的。
  const taskId = await makeTask({ status: "done" });
  const leader = spawn("sh", ["-lc", `(${STUBBORN}) & exit 0`], { detached: true, stdio: "ignore" });
  leader.unref();
  const pid = leader.pid!;
  await until("组长退干净、后代还在组里", async () => !isPidAlive(pid) && isProcessGroupAlive(pid));
  assert.equal(reclaimState(pid, null, { unitToken: null }), "unverifiable",
    "组长已退 + 没记代次 ⇒ 证不出这一组是不是我们的,不许落到 ours-orphans 那一档");

  const monId = await insertMonitorRow(taskId, { status: "stopped", pid, pidStartedAt: null });
  await stopMonitorsForTask(taskId, "任务已删除", "destroy");
  assert.equal(isProcessGroupAlive(pid), true, "**一刀都不许下** —— 这个号可能已经被别人当过组长");
  const debt = await debtRow(monId);
  assert.ok(debt, "照记责任:证不出身份恰恰最该留责任");
  assert.match(debt.reason, /证不出/, "账上说清是「证不出代次」,不是「组长已退、组里还有后代」");

  killTree(pid, "SIGKILL");   // 测试自己收场
  await until("后代被收掉", async () => !isProcessGroupAlive(pid));
  await db.delete(schema.monitorReclaimDebts).where(eq(schema.monitorReclaimDebts.monitorId, monId));
}

await teardown();
console.log("✓ 身份只查一次:locale 不同与第二次查询失败都不是「另一个进程」/ 接回文案由最终 verdict 决定,责任没落盘就照实说 / 身份不全只留「证不出」:记责、不下刀,补全后才收 / 孤儿组没代次、或者只有一个对不上的旧时刻都不下刀 / 姊妹篇 test-monitor-reclaim-unit.ts 钉记号凭证那一半 均受回归保护");
