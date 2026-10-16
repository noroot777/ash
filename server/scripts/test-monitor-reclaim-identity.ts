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
// ⑧-7…⑧-12 **记号这一问答得有多实,决定它能签发什么**(第 13、14 两轮审查 F1)。`ps -E` 把
//    环境无分隔地接在 argv 后面,第 13 轮按「两次快照相减切出环境段」修了一版,第 14 轮实测
//    那仍然不够:**环境段自己也没有边界**,别的变量的**值**里写着 `ASH_MONITOR_UNIT=<记号>`
//    就足以让一个毫不相干的进程挨刀(⑧-11,审查实测 `risk.log:1`)。
//    所以证据分两档(`monitorUnitProofGrade`):Linux 的 `/proc/<pid>/environ` 是 NUL 分隔的
//    真实环境项 ⇒ `exact`,可以签发下刀凭证;macOS 只有展示文本 ⇒ `ambiguous`,**只授权
//    「不许说已经没了」**。两档下这几条的事实不同,台子就照各自的事实钉 —— 不拿一档的结论
//    去冒充另一档(⑧-4、⑧-5、⑧-7、⑧-8、⑩-8 都按 grade 分支)。
//    后代还能**同时**甩掉记号和进程组(⑧-9 实测):那一刻所有线索都空,但那只说明「追不下去
//    了」,所以只许收档、责任行必须活过删除与清扫 —— 它是这次创建最后的可定位身份;而**留档
//    自己失败时不许放行销毁**(⑧-12,第 14 轮审查 F2 实测)。每一次信号也都要有当代的证据:
//    晚两秒那一刀到点先重新取证,证不出就一刀都不发(⑧-10)。
// ⑧-3…⑧-6 **凭证只能是每次创建独有的那条资源记号**(第 12 轮审查 F1)。时刻对不上、命令原文
//    对得上(整串相等、或者记录的是实际命令的前缀)——这些**一律不构成归属**,两次创建完全
//    可以合法地跑同一条命令;反过来,**真实环境项**里认得出来的后代**隔了一次重启也照收**
//    (第 14 轮去掉了那把 `fresh` 锁:它唯一还想收口的「存量行孤儿组」在取证层根本到不了
//    可下刀的那一档)。整项退出同样只认记号:根退了、进程组也空了,带记号的后代仍
//    可能在另一个会话里跑着(⑧-5),而命令自己把环境清掉时记号问不着、那也不等于它退了
//    (⑧-6)—— POSIX 上「线索追空」(`traceless`)要两份独立证据,而且它**只授权收档,不授权
//    删掉最后那行身份**(第 13 轮审查 F1-B)。
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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import {
  db, insertMonitorRow, isPidAlive, makeTask, monitors, reattachMonitors,
  detachAllMonitors, root, schema, startMonitor, stopMonitor, teardown, until,
} from "./monitors-fixture.js";
import { STUBBORN, assertDebtClosed, debtRow, withPsOutage } from "./monitor-reclaim-fixture.js";
import { inspectProcess, processUnitEvidence } from "../src/proc.js";
import { monitorUnitProofGrade } from "../src/monitor-unit-scan.js";
import { monitorSpawnIdentityPath } from "../src/monitor-spawn.js";

const { stopMonitorsForTask } = await import("../src/monitor-reclaim.js");
const { deleteTaskCompletely } = await import("../src/task-delete-routes.js");
const { sweepMonitorReclaimDebts } = await import("../src/monitor-reclaim-debts.js");
const { killProvenUnit, reclaimState } = await import("../src/monitor-reclaim-evidence.js");
const { isProcessGroupAlive, killOne, killTree } = await import("../src/platform.js");
const { invalidateMonitorUnitScan } = await import("../src/monitor-unit-scan.js");
const { dbClient } = await import("../src/db/index.js");

/**
 * **这台机器上记号这一问能不能签发下刀凭证**(见 monitor-unit-scan.ts 的 `UnitProofGrade`)。
 *
 * `exact`(Linux)= 真实环境项读得出来 ⇒ 认得出自己的孤儿后代,也收得掉;
 * `ambiguous`(macOS)= 只有无边界展示文本 ⇒ 只证得出「可能还有残留」,照实留责任、不下刀。
 * 两档都要钉:**不许在 macOS 上假装有 Linux 的结论,也不许因为 macOS 收不掉就不要那条能力。**
 */
const EXACT_MARKS = monitorUnitProofGrade() === "exact";

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
  const started = await startMonitor({ taskId, command: STUBBORN, description: "记录是旧 locale 的" });
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
  await withCountedPs("count", async () => {
    assert.equal(reclaimState(pid, zh, legacy), "ours-alive", "locale 不同不是「这个号现在是另一个进程」");
    assert.equal(psCallCount(), 1, "身份判定只许查一次 —— 补第二次查询就是 F1 的根");
  });

  // ⑪-2 **第二次查询失败不许改写身份**:奇数次正常、偶数次失败的间歇性故障现场。
  await withCountedPs("flaky", async () => {
    assert.equal(reclaimState(pid, zh, legacy), "ours-alive",
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

  // 身份补全(例如运行时后来把真实启动时刻回填到了债上)= 这一刻第一次证得出 ⇒ 才轮到补杀收档。
  await db.update(schema.monitorReclaimDebts)
    .set({ pidStartedAt: inspectProcess(pid)?.startedAt ?? null })
    .where(eq(schema.monitorReclaimDebts.monitorId, monId));
  await sweepMonitorReclaimDebts();
  assert.equal(isProcessGroupAlive(pid), false, "身份补全之后才收得掉它");
  await assertDebtClosed(monId, "补杀之后才收档");
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

{
  // ⑧-3 **命令原文(整串也好、前缀也好)不是归属凭证**(第 12 轮审查 F1-A)。
  //
  //    现场照审查的复现摆:组长已退、组里还有**陌生**后代,而行上**有**一个启动时刻 ——
  //    只是它早就对不上了(那个时刻属于已经不在的组长)。第 10 轮在这一档加的条件只是
  //    「这一列非空」,于是一条历史行照旧拿到了杀整组的资格;本轮第一版把判据换成「命令
  //    原文出现在成员的 argv 里」,实测照样误伤:记录 `command="sleep 1"`、组里跑着
  //    `sleep 120`,`includes` 当场认亲 → `ours-orphans` → `fresh` 下发组击杀,审查自己
  //    的测试组被杀(`foreignChildAliveAfter=false`)。
  //
  //    **命令原文是要干的活,不是凭证** —— 两次创建完全可以合法地跑同一条命令,所以整串
  //    相等也不算。凭证只能是**每次创建独有、起进程之前就落库**的那条资源记号
  //    (`ASH_MONITOR_UNIT`,见 `proc.ts` 的 `processUnitEvidence`)。下面把三种命令关系
  //    一次钉齐:完全不同 / 记录是实际命令的前缀 / 一模一样 —— 都必须是「证不出」。
  const taskId = await makeTask({ status: "done" });
  const stale = "Mon Jan  1 00:00:00 2001";
  const relations: Array<{ what: string; recorded: string }> = [
    { what: "完全不同的命令", recorded: "ash-identity-probe-毫不相干" },
    { what: "记录的命令是实际命令的前缀", recorded: "sleep 3" },   // 审查实测用的那一组
    { what: "两边命令一模一样", recorded: "sleep 300" },
  ];
  for (const rel of relations) {
    const stranger = spawn("sh", ["-lc", "(sleep 300) & exit 0"], { detached: true, stdio: "ignore" });
    stranger.unref();
    const pid = stranger.pid!;
    await until("组长退干净、组里还有陌生后代", async () => !isPidAlive(pid) && isProcessGroupAlive(pid));

    // 存量行(没有记号):命令怎么像都只能是「证不出」。
    assert.equal(reclaimState(pid, stale, { unitToken: null, command: rel.recorded }), "unverifiable",
      `${rel.what}:存量行上没有凭证,不许落到「可以下刀」那一档`);
    assert.equal(
      reclaimState(pid, inspectProcess(process.pid)?.startedAt ?? null,
        { unitToken: null, command: rel.recorded }), "unverifiable",
      `${rel.what}:换一个「像样」的时刻也一样 —— 时刻和命令都不是归属凭证`);
    // 带记号的行:记号在这一组里一个都找不着 ⇒ 既不许认亲,也不许据此收档(组里还有人,
    // 而命令自己把环境清掉时同样问不出记号,见 ⑧-6)。
    assert.equal(reclaimState(pid, stale, { unitToken: `unit-nobody-${pid}`, command: rel.recorded }),
      "unverifiable", `${rel.what}:记号对不上就是证不出,不许当成「整项已退」`);

    // 端到端:重复点停一条历史行走的就是这一档(`stopMonitor` 对非运行态行仍按 fresh 核账
    // —— 那正是审查实测触发误杀的入口)。
    const monId = await insertMonitorRow(taskId, {
      status: "stopped", pid, pidStartedAt: stale, command: rel.recorded,
    });
    await stopMonitor(monId, "再点一次停止");
    assert.equal(isProcessGroupAlive(pid), true, `${rel.what}:**一刀都不许下** —— 这一组根本不是我们的`);
    const debt = await debtRow(monId);
    assert.ok(debt, "照记责任:证不出归属恰恰最该留责任");
    assert.match(debt.reason, /证不出/, "账上说清是「证不出」,不是「组长已退、组里还有后代」");

    killTree(pid, "SIGKILL");   // 测试自己收场
    await until("陌生后代被收掉", async () => !isProcessGroupAlive(pid));
    await db.delete(schema.monitorReclaimDebts).where(eq(schema.monitorReclaimDebts.monitorId, monId));
  }
}

{
  // ⑧-4 **记号证明得出来的孤儿后代:隔了一次重启也照收**(第 12 轮审查 F1-A 的另一面)。
  //
  //    上面三条钉的是「不许误杀」,这一条钉的是**不许因此收不了自己的活**:后代各自带着
  //    这一次创建的那条记号,它们是谁的不是推断出来的,所以 `fresh` 那把锁(「刚刚还在我们
  //    手上才敢打」)在这一档不再适用 —— 删除核对、开机清扫这些 `fresh:false` 的入口必须
  //    真能把它们收掉。下刀落点是**证明过的那几个成员各自**,不是组:这个组号此刻可能已经
  //    是别人的组长了。
  const taskId = await makeTask({ status: "done" });
  const unitToken = `unit-orphan-${process.pid}-${Date.now()}`;
  const leader = spawn("sh", ["-lc", `(${STUBBORN}) & exit 0`],
    { detached: true, stdio: "ignore", env: { ...process.env, ASH_MONITOR_UNIT: unitToken } });
  leader.unref();
  // 生产里**只有 `spawnMonitor` 会凭空造出一个带记号的进程**,它起完就作废那份扫描备忘
  // (见 monitor-unit-scan.ts 的 `invalidateMonitorUnitScan`:备忘只敢把「还活着」留旧,不敢把
  // 「已经没了」留旧)。台子这几行是在替它起进程,所以同样要作废一次 —— 否则读到的可能是
  // 这个进程存在之前的那份快照,判出一个假的「线索已空」。
  invalidateMonitorUnitScan();
  const pid = leader.pid!;
  await until("组长退干净、带记号的后代还在", async () => !isPidAlive(pid) && isProcessGroupAlive(pid));
  assert.equal(reclaimState(pid, "Mon Jan  1 00:00:00 2001", { unitToken, command: "毫不相干" }),
    EXACT_MARKS ? "ours-orphans" : "suspected",
    EXACT_MARKS
      ? "真实环境项里读到记号 ⇒ 归属已证明,对不上的时刻和命令都不参与这一判"
      : "只有展示文本 ⇒ 只到「看得见这次创建的记号」这一档:不敢下刀,但绝不许当成已经退出");

  const monId = await insertMonitorRow(taskId, { status: "stopped", pid, pidStartedAt: null, unitToken });
  await stopMonitorsForTask(taskId, "任务已删除", "destroy");
  if (EXACT_MARKS) {
    await until("带记号的后代被收掉（TERM 之后两秒那把 KILL）", async () => !isProcessGroupAlive(pid), 20_000);
    await sweepMonitorReclaimDebts();   // 线索追空可能慢到上一步之后,收档由梯子补上
    await assertDebtClosed(monId, "带记号的后代收掉、线索追空之后才收档");
  } else {
    // **这是本平台的真实边界,照实钉住**(第 14 轮审查 F1):展示文本签不出杀进程的凭证,
    // 所以这一档只能留责任 —— 而责任和身份一个都不许少,也不许盖上「追到此为止」的戳。
    assert.equal(isProcessGroupAlive(pid), true, "证不出归属 ⇒ 一刀都不许下");
    await sweepMonitorReclaimDebts();
    const debt = await debtRow(monId);
    assert.ok(debt, "照记责任:证不出归属恰恰最该留责任");
    assert.equal(debt.closedAt, null, "而且不许收档:线索还看得见,远没有追空");
    assert.match(debt.reason, /证不出|记号/, "账上要说清是哪一种不确定");
    killTree(pid, "SIGKILL");   // 产品收不掉它,台子自己清
    await until("后代被台子收掉", async () => !isProcessGroupAlive(pid));
  }
}

{
  // ⑧-5 **根退了、组也空了,不等于整项资源退出**(第 12 轮审查 F1-B 的 POSIX 一侧)。
  //
  //    后代自己 `setsid` 跑掉(这里用 Node 的 `detached: true` 造这一幕,`sleep` 进了自己的
  //    会话),于是记录的那个号上既没有进程、整组也空了 —— 只看这两样会得出「已经收干净」,
  //    而那条 `sleep` 带着这一次创建的记号好好地活着。创建失败补偿据此收档 + 删掉最后一行
  //    身份,就再没有人能找到它(F1-B 在 win32 上的同一个形状)。
  const taskId = await makeTask({ status: "done" });
  const unitToken = `unit-escaped-${process.pid}-${Date.now()}`;
  const childPidFile = join(root, `escaped-${Date.now()}.pid`);
  const escape = "const{spawn}=require('child_process');const c=spawn('sleep',['300'],"
    + "{detached:true,stdio:'ignore'});require('fs').writeFileSync(process.argv[1],String(c.pid));c.unref();";
  const leader = spawn(process.execPath, ["-e", escape, childPidFile],
    { detached: true, stdio: "ignore", env: { ...process.env, ASH_MONITOR_UNIT: unitToken } });
  leader.unref();
  invalidateMonitorUnitScan();   // 同上:台子在替 `spawnMonitor` 起进程
  const pid = leader.pid!;
  await until("根退干净、组也空了", async () => !isPidAlive(pid) && !isProcessGroupAlive(pid) && existsSync(childPidFile));
  const escaped = Number(readFileSync(childPidFile, "utf8"));
  assert.equal(isPidAlive(escaped), true, "台子前提:跑掉的那条后代还活着");

  assert.equal(reclaimState(pid, null, { unitToken }), EXACT_MARKS ? "ours-orphans" : "suspected",
    "记号还看得见 ⇒ 整项资源没退,绝不许落到「线索已空」(收档 + 撤锚就是从这里出去的)");
  // 同一幕里的**存量行**只能看到「号没了、组也空了」—— 这正是记号补上的那一块,照实钉住。
  assert.equal(reclaimState(pid, null, { unitToken: null }), "traceless",
    "没有记号时这一幕确实判不出区别:它说明的是存量行的盲区,不是这一档可以放过有记号的行");

  const monId = await insertMonitorRow(taskId, { status: "stopped", pid, pidStartedAt: null, unitToken });
  await stopMonitorsForTask(taskId, "任务已删除", "destroy");
  if (EXACT_MARKS) {
    await until("跑掉的后代也要被收掉", async () => !isPidAlive(escaped), 20_000);
    await sweepMonitorReclaimDebts();
    await assertDebtClosed(monId, "跑掉的后代收掉之后才收档");
  } else {
    assert.equal(isPidAlive(escaped), true, "展示文本签不出下刀凭证 ⇒ 一刀都不许下");
    await sweepMonitorReclaimDebts();
    const debt = await debtRow(monId);
    assert.ok(debt && !debt.closedAt, "责任留着、不收档:它是这条命令唯一还能被找到的方式");
    killOne(escaped, "SIGKILL");   // 产品收不掉它,台子自己清
    await until("跑掉的后代被台子收掉", async () => !isPidAlive(escaped));
  }
}

{
  // ⑧-7 **argv 里的那段文字不是凭证 —— 哪怕它逐字就是我们的记号**(第 13 轮审查 F1-A 实测)。
  //
  //    `ps -A -E` 把环境**没有分隔符地接在 argv 后面**,所以上一版那条「整行里找
  //    `ASH_MONITOR_UNIT=(\S+)`」的正则根本分不出这段文字来自哪一边。审查起了一个诊断进程:
  //    环境里只有 PATH、记号只写在它的参数里,于是 `reclaimEvidence` 认它作「我们的后代」,
  //    真实的重复点停入口当场把它杀了(`R2_ARGV_TEXT_AUTHORIZES_FOREIGN_KILL`:
  //    `actualEnvironmentContainsUnit=false`、`evidence={"verdict":"ours"}`、
  //    `foreignAliveAfter=false`)。
  //
  //    第 13 轮的修法是「把两段切开」(两次快照相减);第 14 轮实测环境段自己也没有边界,所以
  //    现在按**证据等级**分:`exact`(真实环境项)这一档 argv 里的文字一个字都不算 ⇒ 这一问
  //    答「没找到」;`ambiguous`(只有展示文本)这一档照实答「看得见」⇒ `suspected`。
  //    **两档的共同结论是同一句:一刀都不许下。**
  const taskId = await makeTask({ status: "done" });
  const unitToken = `unit-argvtext-${process.pid}-${Date.now()}`;
  // 记号**只**出现在那个陌生进程的参数里:环境被换成只有 PATH 的一份。
  const stranger = spawn(
    "sh", ["-lc", `( exec sh -c 'while :; do sleep 0.2; done' ASH_MONITOR_UNIT=${unitToken} ) & exit 0`],
    { detached: true, stdio: "ignore", env: { PATH: process.env.PATH ?? "" } },
  );
  stranger.unref();
  invalidateMonitorUnitScan();
  const pid = stranger.pid!;
  await until("陌生进程起来了、它的组长也退干净了",
    async () => !isPidAlive(pid) && isProcessGroupAlive(pid));
  assert.equal(processUnitEvidence(unitToken, { fresh: true }).verdict,
    EXACT_MARKS ? "none" : "suspected",
    EXACT_MARKS
      ? "**argv 段里的记号一个字都不算** —— 真实环境项里没有这一项,这一问必须答「没找到」"
      : "展示文本切不出真实环境项 ⇒ 只能答「看得见」,**而它不是凭证**");
  assert.equal(reclaimState(pid, null, { unitToken }), EXACT_MARKS ? "unverifiable" : "suspected",
    "两档都只能落在「证不出」:有进程在,但证不出他们是这一次创建的");

  // 端到端走审查实测的那个入口:对一条非运行态的行再点一次停止。
  const monId = await insertMonitorRow(taskId, {
    status: "stopped", pid, pidStartedAt: null, unitToken, command: "sleep 3",
  });
  await stopMonitor(monId, "再点一次停止");
  assert.equal(isProcessGroupAlive(pid), true, "**一刀都不许下** —— 那是别人的进程");
  const debt = await debtRow(monId);
  assert.ok(debt, "照记责任:证不出归属恰恰最该留责任");
  assert.equal(debt.closedAt, null, "而且不许收档:组里还有人,线索远没有追空");

  killTree(pid, "SIGKILL");   // 测试自己收场
  await until("陌生组被收掉", async () => !isProcessGroupAlive(pid));
}

{
  // ⑧-8 **反过来也要成立:argv 里的一段假记号不许遮住环境里的真记号**(同一个歧义的另一面)。
  //
  //    上一版那条正则取的是整行里**第一个**匹配,而 argv 排在环境前面 —— 所以只要命令的参数
  //    里有一段 `ASH_MONITOR_UNIT=...`,自己的后代就会被读成「另一个记号的成员」,这一次创建
  //    于是「一个成员都找不到」⇒ 假的「线索已空」。这一半由「一行里出现几次全收」(全局匹配)
  //    修掉,两档都成立;「假记号算不算成员」那一半由证据等级分档(第 14 轮审查 F1)。
  const unitToken = `unit-realenv-${process.pid}-${Date.now()}`;
  const decoy = `unit-decoy-${process.pid}-${Date.now()}`;
  const leader = spawn(
    "sh", ["-lc", `( exec sh -c 'while :; do sleep 0.2; done' ASH_MONITOR_UNIT=${decoy} ) & exit 0`],
    { detached: true, stdio: "ignore", env: { ...process.env, ASH_MONITOR_UNIT: unitToken } },
  );
  leader.unref();
  invalidateMonitorUnitScan();
  const pid = leader.pid!;
  await until("组长退干净、带真记号的后代还在",
    async () => !isPidAlive(pid) && isProcessGroupAlive(pid));
  // **两档共同的那一条**:真记号不许被假的遮住(上一版那条正则只取整行第一个匹配,假记号
  // 排在前面就把真的吃掉了 —— 现在是全局匹配,一行里出现几次全收)。
  assert.notEqual(processUnitEvidence(unitToken, { fresh: true }).verdict, "none",
    "**环境里的真记号必须认得出来** —— argv 里那段假的不许把它遮住");
  assert.equal(reclaimState(pid, null, { unitToken }), EXACT_MARKS ? "ours-orphans" : "suspected",
    "真记号认出来之后:精确档可以下刀,展示文本档只到「证不出」");
  assert.equal(processUnitEvidence(decoy, { fresh: true }).verdict,
    EXACT_MARKS ? "none" : "suspected",
    EXACT_MARKS
      ? "而那段假记号在真实环境项里一个成员都不算:它只出现在 argv 里"
      : "展示文本档里假记号也只能算「看得见」—— 它同样签不出任何凭证");

  killTree(pid, "SIGKILL");   // 测试自己收场
  await until("后代被收掉", async () => !isProcessGroupAlive(pid));
}

{
  // ⑧-9 **后代同时甩掉两条线索 ⇒ 只许收档,责任行必须活过删除与清扫**(第 13 轮审查 F1-B
  //    的复现 `R1_RESOURCE_FALSE_GONE`:`rootAlive=false`、`oldGroupAlive=false`、
  //    `escapedAlive=true`,而 `debtRows=0`、`taskRows=0` —— 那条命令从此谁都找不到)。
  //
  //    这一幕里后代 `spawn(..., {detached:true, env:{PATH}})`:环境换掉(不带记号)、自己建会话
  //    (不在原组)。三条线索同时为空,所以判出来只能是 `traceless` —— 而 `traceless` 的含义是
  //    **「能追的线索到此为止」**,不是「整项退出已证明」。按上一版的做法(删掉债表那一行)就
  //    等于声称后者,于是这个活着的进程连最后一份可定位身份都没了。
  //
  //    所以这一条钉的是**留档**:行留着、盖上收档戳,命令/pid/记号都还在上面;删除任务、开机
  //    清扫都不许把它带走。「那条跑掉的后代没被收掉」是这个平台能力的真实边界,照实钉住,
  //    不拿「已回收」盖过去。
  const taskId = await makeTask({ status: "done" });
  const unitToken = `unit-shed-${process.pid}-${Date.now()}`;
  const childPidFile = join(root, `shed-${Date.now()}.pid`);
  // 子进程的环境只留 PATH ⇒ 记号没了;`detached` ⇒ 自己建会话,离开原进程组。
  const escape = "const{spawn}=require('child_process');const c=spawn('sleep',['300'],"
    + "{detached:true,stdio:'ignore',env:{PATH:process.env.PATH}});"
    + "require('fs').writeFileSync(process.argv[1],String(c.pid));c.unref();";
  const leader = spawn(process.execPath, ["-e", escape, childPidFile],
    { detached: true, stdio: "ignore", env: { ...process.env, ASH_MONITOR_UNIT: unitToken } });
  leader.unref();
  invalidateMonitorUnitScan();
  const pid = leader.pid!;
  await until("根退干净、组也空了、后代已经跑掉",
    async () => !isPidAlive(pid) && !isProcessGroupAlive(pid) && existsSync(childPidFile));
  const escaped = Number(readFileSync(childPidFile, "utf8"));
  assert.equal(isPidAlive(escaped), true, "台子前提:甩掉两条线索的那条后代还活着");
  assert.equal(processUnitEvidence(unitToken, { fresh: true }).verdict, "none",
    "台子前提:记号这一问真的找不到任何成员了");
  assert.equal(reclaimState(pid, null, { unitToken }), "traceless",
    "三条线索都空了 ⇒ 这一档叫「线索追到这里为止」,它**不叫**「整项退出已证明」");

  // 同一幕里,只要记号这一问自己答不出来(这里用真的 ps 不可用),连这一档都不许要:
  // 「问不出来」比「找不到」更弱,只能落 `unknown`。
  await withPsOutage(escaped, async () => {
    // 备忘要先作废:它保存的是**刚才真的问出来的**那个答案(「找不到」),拿它接着用是对的
    // —— 这里要造的是「这一刻第一次问,而且问不出来」,也就是开机清扫撞上 ps 不可用那一幕。
    invalidateMonitorUnitScan();
    assert.equal(reclaimState(pid, null, { unitToken }), "unknown",
      "记号这一问答不出来 + 根已退 ⇒ 什么都不许声称,更不许当成追空");
  });
  invalidateMonitorUnitScan();   // 别把「问不出来」那一份留给下面的用例

  const monId = await insertMonitorRow(taskId, {
    status: "stopped", pid, pidStartedAt: null, unitToken, command: "node -e <甩掉线索的那条>",
  });
  await stopMonitor(monId, "再点一次停止");
  assert.equal(isPidAlive(escaped), true,
    "照实钉住这个平台的边界:甩掉全部线索的后代**没有**被收掉(所以更不能把它的记录删掉)");

  // **删除是身份真正消失的那一刻**:哨兵行(命令、pid、记号都在它上面)跟着任务一起没了。
  // 所以留档发生在这里 —— 审查那份复现正是走到这一步之后 `taskRows=0`、`debtRows=0`。
  await deleteTaskCompletely(taskId);
  assert.equal((await db.select().from(monitors).where(eq(monitors.taskId, taskId))).length, 0,
    "哨兵行跟着任务没了");
  await assertDebtClosed(monId, "身份被销毁之前要留下最后一行档");
  const closed = await debtRow(monId);
  assert.match(closed!.closedNote ?? "", /线索|证不出/, "戳上要写清是「追到这里为止」,不是「已回收」");
  assert.equal(closed!.pid, pid, "行上还留着 pid");
  assert.equal(closed!.unitToken, unitToken, "以及记号 —— 它是这次创建最后的可定位身份");
  assert.equal(closed!.command, "node -e <甩掉线索的那条>", "还有命令原文:人要据此找到它");
  await sweepMonitorReclaimDebts();
  await assertDebtClosed(monId, "也必须活过开机清扫（收档的行不再追,但也不删）");

  killTree(escaped, "SIGKILL");   // 测试自己收场:产品收不掉它,台子得自己清
  await until("跑掉的后代被台子收掉", async () => !isPidAlive(escaped));
}

{
  // ⑧-10 **晚两秒那一刀也要有当代的证据**(第 13 轮审查 F1-C)。
  //
  //    上一版的补刀是个闭包里存着裸 pid 的定时器(借 `executors/spawn.ts` 的 `killByPid`,
  //    它那一刀是无条件的)。两秒里那个进程可以退出、它的号可以被别人接手 —— 于是一次性的
  //    授权被存成了永久授权。现在到点先 `fresh` 重新取证,**证不出就一刀都不发**。
  //
  //    现在连第一刀都由这个入口自己取证(第 14 轮审查 F1:外面不许把快照攒着跨 `await` 再
  //    传进来)。现场:一个陌生组(组长已退、组里还有人),拿一个谁都对不上的记号走这条路 ——
  //    两刀各自取证,各自只能得到「证不出」⇒ 一刀都不发。整三秒之后那一组必须一个不少。
  const stranger = spawn("sh", ["-lc", `(${STUBBORN}) & exit 0`], { detached: true, stdio: "ignore" });
  stranger.unref();
  const pid = stranger.pid!;
  await until("陌生组起来了、组长退干净", async () => !isPidAlive(pid) && isProcessGroupAlive(pid));

  killProvenUnit(pid, null, { unitToken: `unit-nobody-${pid}` });
  await new Promise((r) => setTimeout(r, 3_000));   // 跨过 +2 秒那一刀
  assert.equal(isProcessGroupAlive(pid), true,
    "**没有当代证据就一刀都不发** —— 补刀不许拿闭包里的裸 pid 当永久授权");

  killTree(pid, "SIGKILL");   // 测试自己收场
  await until("陌生组被收掉", async () => !isProcessGroupAlive(pid));
}

{
  // ⑧-6 **命令自己把环境清掉 ⇒ 记号问不着,但那不等于它退了**。
  //
  //    `env -i` 之后的后代不再带记号。只认记号就会把这一幕判成「线索已空」并收档,而组里
  //    明明还有人 —— 所以 POSIX 上 `traceless` 要**两份**独立证据:记号一个都找不着,且进程组
  //    也空了。少一份就是「证不出」:记责任、不收档、一刀都不许下。
  const taskId = await makeTask({ status: "done" });
  const unitToken = `unit-scrubbed-${process.pid}-${Date.now()}`;
  const leader = spawn("sh", ["-lc", "(env -i sleep 300) & exit 0"],
    { detached: true, stdio: "ignore", env: { ...process.env, ASH_MONITOR_UNIT: unitToken } });
  leader.unref();
  invalidateMonitorUnitScan();   // 同上
  const pid = leader.pid!;
  await until("组长退干净、不带记号的后代还在", async () => !isPidAlive(pid) && isProcessGroupAlive(pid));
  assert.equal(reclaimState(pid, null, { unitToken }), "unverifiable",
    "记号问不着 + 组里还有人 ⇒ 线索还没空,不许收档");

  const monId = await insertMonitorRow(taskId, { status: "stopped", pid, pidStartedAt: null, unitToken });
  await stopMonitorsForTask(taskId, "任务已删除", "destroy");
  assert.equal(isProcessGroupAlive(pid), true, "**一刀都不许下** —— 证不出这些后代是不是这一次创建的");
  assert.ok(await debtRow(monId), "责任留在表上,等下一次开机再问");

  killTree(pid, "SIGKILL");   // 测试自己收场
  await until("后代被收掉", async () => !isProcessGroupAlive(pid));
  await sweepMonitorReclaimDebts();
  await assertDebtClosed(monId, "两条线索都追空了才收档");
}

{
  // ⑧-2 **一次查询失败不许把这条行永久降级**(第 10 轮审查 F2-B)。
  //
  //    现场:行上 pid 在、启动时刻空着(接回那一刻 ps 恰好不可用,只回填得了 pid),而这段时间
  //    ps 仍然问不出来 ⇒ 停它只能记责任、不敢下刀。关键是**此刻留下的东西够不够让以后补全**:
  //    身份边条不许撤(欠着责任时它是唯一的时间锚),债上也要带一份锚(行和边条都可能先没了)。
  //    上一版两样都没有:边条在落终态时无条件撤掉、债表没有锚列,于是这条行永久停在
  //    `unverifiable` —— 既不敢杀,也收不了档。
  const taskId = await makeTask({ status: "running" });
  const started = await startMonitor({ taskId, command: STUBBORN, description: "身份要靠锚补全的" });
  assert.equal(started.ok, true);
  const row = (await db.select().from(monitors).where(eq(monitors.taskId, taskId))).at(0)!;
  const side = monitorSpawnIdentityPath(row.logPath);
  assert.ok(existsSync(side), "台子前提:身份边条在盘上");
  await db.update(monitors).set({ pidStartedAt: null }).where(eq(monitors.id, row.id));

  await withPsOutage(row.pid!, async () => {
    await stopMonitor(row.id, "用户点停");
  });
  assert.equal(isProcessGroupAlive(row.pid!), true, "这段时间证不出身份 ⇒ 不下刀");
  const owed = await debtRow(row.id);
  assert.ok(owed, "责任记下来了");
  assert.equal(owed.pidStartedAt, null, "身份确实还没补全");
  assert.ok(owed.spawnAnchorMs, "**锚要留在债上** —— 哨兵行和边条都可能先没了,那之后只剩这一笔");
  assert.ok(existsSync(side), "**欠着责任就不许撤掉边条** —— 它是补全身份的唯一线索");

  // ps 恢复 = 下一次开机清扫:这一刻第一次补得出身份 ⇒ 这才轮到补杀 + 收档。
  await sweepMonitorReclaimDebts();
  await until("补全身份之后才收掉它", async () => !isProcessGroupAlive(row.pid!));
  await assertDebtClosed(row.id, "补全身份、收掉它之后才收档");
  assert.ok((await db.select().from(monitors).where(eq(monitors.id, row.id))).at(0)?.pidStartedAt,
    "补回来的身份要落库,不是只在内存里用一次");
  assert.equal(existsSync(side), false, "收档之后边条才真的没用了");
}

await teardown();
console.log("✓ 身份只查一次:locale 不同与第二次查询失败都不是「另一个进程」/ 接回文案由最终 verdict 决定,责任没落盘就照实说 / 身份不全只留「证不出」:记责、不下刀,补全后才收 / 孤儿组没代次、或者只有一个对不上的旧时刻都不下刀 / 陌生组的命令同名、前缀、完全不同都不下刀 / 带记号的孤儿后代:真实环境项那一档隔了重启也照收,只有展示文本那一档留责任不下刀 / argv 里的记号文字既不授权下刀也不遮住环境里的真记号 / 环境被清掉只留「证不出」/ 追空只收档、责任行活过删除与清扫 / 补刀没有当代证据就一刀不发 / 锚与边条留到收档,恢复后补全身份才动手 均受回归保护");
