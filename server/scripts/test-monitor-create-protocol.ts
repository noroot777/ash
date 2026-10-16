// **命令开工 ⇒ 身份已经可恢复。** 等价说法:身份没落库 ⇒ 那条命令一个字都没跑过。
//
// 第 7 轮审查 F3 的现场:原来的顺序是「先 spawn 再 insert」—— 命令已经独立跑起来了 ash 才去
// 登记,登记失败时只能事后追(落责任 → 发信号 → 确认退出 → 销账)。而当身份查询那一刻也不可用、
// 责任表又写不进去时,那个进程的唯一线索只剩 `scheduleReclaimPersist` 的内存参数(unref 定时器,
// 活不过服务退出);重启恢复只枚举 monitors 和债表,两张表都没有它 —— 命令还在后台跑着,谁都
// 再也找不到它。「以后定时再保存」不构成资源交接,所以修法不是多兜一层,而是**换顺序**:
// 先落身份行(pid 空着 = 创建意图)→ 起进程(停在放行闸前)→ 回填 pid → 挂运行时 → 放行。
//
// 这一份钉四件事:
//
// ① **登记失败 ⇒ 什么都没起。** insert 被拒时既没有进程、也没有行、更不许声称回收了什么。
// ② **回填 pid 失败 ⇒ 不放行 ⇒ 命令从未开工。** 这是闸的全部意义:失败路径上没有外部资源
//    需要交接,所以收得干净(行删掉、无债),而不是留一个追不回来的后台进程。
// ③ **收不干净时不许冒充收干净。** 同一个失败点上让身份查询也不可用:那一刻什么都证明不了,
//    于是**身份行必须留着**(它是唯一线索)、回收责任必须落盘,措辞照实说。
// ④ **闸本身的两面**:写端关闭(= ash 在放行前没了)⇒ 壳在 exec 之前退出(97),命令从未开工;
//    放行 ⇒ 命令照常跑起来。少了后半句,一个「永远不放行」的实现也能骗过前三条。
// ⑤ **重启接回一条 pid 还空着的意图行**:它是「身份先落库」唯一的用处 —— 接回时照实说。
//
// 创建**开始之后**那段时间里发生的事(点停、撤销、壳先退、起壳后的异常、交接与补偿失败)
// 归 test-monitor-create-window.ts,台子两边共用 monitor-create-fixture.ts。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import {
  db, isPidAlive, makeTask, monitors, insertMonitorRow, reattachMonitors, root, schema, sleep,
  startMonitor, teardown, until,
} from "./monitors-fixture.js";
import {
  blockInsert, blockPidBackfill, debtRow, healInsert, healPidBackfill, marker, psCount, withPsOutage,
} from "./monitor-create-fixture.js";
import { inspectProcess } from "../src/proc.js";

const { spawnMonitor } = await import("../src/monitor-spawn.js");
const { abandonRegistration } = await import("../src/monitor-create.js");
const { sweepMonitorReclaimDebts } = await import("../src/monitor-reclaim-debts.js");

// ── ① 登记失败:什么都没起,所以没有任何要回收的东西 ──────────────────────────────
{
  const taskId = await makeTask();
  const m = marker();
  await blockInsert(taskId);
  let refused: Awaited<ReturnType<typeof startMonitor>>;
  try {
    refused = await startMonitor({ taskId, command: m.command, description: "登记就失败的" });
  } finally {
    await healInsert();
  }
  assert.equal(refused.ok, false, "登记失败要如实失败");
  assert.equal(refused.ok === false && refused.status, 409);
  assert.match(refused.ok === false ? refused.error : "", /一个字都没开始跑/,
    "措辞要说清「命令从未开工」—— 这是它跟「已经回收」完全不同的一档");
  assert.equal((await db.select().from(monitors).where(eq(monitors.taskId, taskId))).length, 0, "没有留下行");
  assert.equal((await db.select().from(schema.monitorReclaimDebts)).length, 0, "也没有凭空记一笔回收责任");
  assert.equal(psCount(m.token), 0, "连壳都没起:身份落不下去的时候,进程还一个都没有");
  assert.equal(existsSync(m.path), false, "用户的命令一个字都没跑");
}

// ── ② 回填 pid 失败:不放行 ⇒ 命令从未开工 ⇒ 收得干净 ───────────────────────────
{
  const taskId = await makeTask();
  const m = marker();
  await blockPidBackfill(taskId);
  let refused: Awaited<ReturnType<typeof startMonitor>>;
  try {
    refused = await startMonitor({ taskId, command: m.command, description: "回填就失败的" });
  } finally {
    await healPidBackfill();
  }
  assert.equal(refused.ok, false, "回填不上就不能报成功");
  assert.match(refused.ok === false ? refused.error : "", /已回收它的进程/,
    "这一档是确认收干净了(壳停在闸前,不 trap 信号,那一刀必中)");
  await until("闸前那个壳被收掉", async () => psCount(m.token) === 0);
  // 这一条抓的是闸的全部意义:登记没成的那一条,用户的命令一个字都没跑过。**但它本身是概率
  // 性的** —— 拆掉闸之后,命令能不能在那一刀落下之前吐出第一个字取决于 `sh -l` 启动和一次
  // DB 写谁先谁后(实测拆闸跑三遍,这一条红了两遍)。确定性的那一条在下面第 ④ 块:闸前的
  // 进程必然还没开工,而那不取决于任何时序。
  assert.equal(existsSync(m.path), false,
    "**闸的全部意义**:登记没成的那一条,用户的命令一个字都没跑过");
  assert.equal((await db.select().from(monitors).where(eq(monitors.taskId, taskId))).length, 0,
    "确认收干净了,这条意图行也没有留着的理由");
  assert.equal((await db.select().from(schema.monitorReclaimDebts)).length, 0, "没有悬着的回收责任");
}

// ── ③ 同一个失败点,但这一次收不干净:不许冒充收干净 ──────────────────────────────
//
// 这一档在 POSIX 上端到端**造不出来**,而那恰恰是闸的功劳:壳停在闸前面、不 trap 信号,所以
// 回填失败时那一刀必中(上一块实测)。它仍然要钉,因为 win32 那一侧没有闸,同一个失败点上命令
// 可能已经在跑 —— 于是这里直接钉那个分支本身:一个真的顽固进程(trap 掉 TERM,只有 +2 秒那把
// SIGKILL 收得掉)配上真的 ps 不可用(PATH 前置一个退出码 1 的 `ps`),两样都不是替身。
{
  const taskId = await makeTask();
  const stubborn = spawn("sh", ["-lc", "trap '' TERM HUP INT; while :; do sleep 0.2; done"], {
    detached: true, stdio: "ignore",
  });
  stubborn.unref();
  const pid = stubborn.pid!;
  await until("顽固进程起来了", async () => isPidAlive(pid));
  const monId = await insertMonitorRow(taskId, { pid, pidStartedAt: inspectProcess(pid)?.startedAt ?? null });
  const row = (await db.select().from(monitors).where(eq(monitors.id, monId))).at(0)!;

  const refused = await withPsOutage(() => abandonRegistration(row, "INJECTED_PID_BACKFILL_FAILURE"));
  assert.equal(refused.ok, false);
  const said = refused.ok === false ? refused.error : "";
  assert.match(said, /回收责任已记下/, "问不出来的那一刻只能说「责任已记下」");
  assert.doesNotMatch(said, /已回收它的进程/, "**不许**声称收干净了 —— 这一刻什么都证明不了");
  const after = (await db.select().from(monitors).where(eq(monitors.id, monId))).at(0);
  assert.ok(after, "身份行必须留着:它是这个进程唯一的线索(行一删就谁都找不到它了)");
  assert.equal(after.status, "lost");
  assert.match(after.endedReason ?? "", /没能记下它的 pid/);
  assert.equal(after.pid, pid, "pid 要留在行上 —— 回收那一圈靠它");
  const debt = await debtRow(monId);
  assert.ok(debt, "回收责任落盘(不是只放在内存定时器里)");
  assert.equal(debt.pid, pid);
  // ps 恢复之后,紧随其后的那一圈清扫自己把账销掉 —— 这才是「责任已记下」该兑现的东西。
  await until("清扫把账销掉", async () => {
    await sweepMonitorReclaimDebts();
    return !(await debtRow(monId));
  }, 20_000);
  assert.equal(isPidAlive(pid), false, "而那个顽固进程最终真的被收掉了");
}

// ── ④ 闸的两面:写端关闭 ⇒ exec 之前退出;放行 ⇒ 命令照常跑 ────────────────────
{
  const m = marker();
  const spawned = spawnMonitor({ command: m.command, cwd: root, logPath: join(root, "gate-abandon.log") });
  assert.ok(!("error" in spawned), "台子前提:进程起得来");
  if ("error" in spawned) throw new Error(spawned.error);
  let code: number | null | undefined;
  spawned.onExit((c) => { code = c; });
  assert.equal(psCount(m.token), 1, "此刻壳已经在了 —— 但它停在闸前面");
  assert.equal(existsSync(m.path), false, "闸前:用户的命令还没开始");
  spawned.abandon();   // = ash 在放行之前没了:写端关闭,壳读到 EOF
  await until("壳自己退出", async () => code !== undefined);
  assert.equal(code, 97, "它在 exec 用户命令之前就按约定的退出码退了");
  assert.equal(existsSync(m.path), false, "所以那条命令一个字都没跑过");

  const ok = marker();
  const live = spawnMonitor({ command: ok.command, cwd: root, logPath: join(root, "gate-release.log") });
  assert.ok(!("error" in live), "台子前提:进程起得来");
  if ("error" in live) throw new Error(live.error);
  assert.equal(existsSync(ok.path), false, "放行之前照样不动");
  live.release();
  // 这一条是**反向保险**:少了它,一个「永远不放行」的实现也能让前三块全绿。
  await until("放行之后命令真的开工", async () => existsSync(ok.path));
  try { process.kill(-live.pid, "SIGKILL"); } catch { /* 已经没了 */ }
}

// ── ⑤ 重启接回一条 pid 还空着的意图行:照实说,别冒充「它已经不在了」 ─────────────
{
  const taskId = await makeTask();
  // ash 恰好死在「落了身份」与「回填 pid」之间留下的就是这样一行。
  const monId = await insertMonitorRow(taskId);
  const before = (await db.select().from(monitors).where(eq(monitors.id, monId))).at(0);
  assert.equal(before?.pid, null, "台子前提:这一行的 pid 还空着");
  const { lost } = await reattachMonitors();
  assert.ok(lost >= 1, "它不能被当成接回成功");
  const row = (await db.select().from(monitors).where(eq(monitors.id, monId))).at(0);
  assert.equal(row?.status, "lost");
  assert.match(row?.endedReason ?? "", /没有真正开工/,
    "POSIX 上这等于命令从未开工(壳停在闸前,ash 一死写端就关了)");
  assert.doesNotMatch(row?.endedReason ?? "", /这个进程已经不在了/,
    "**不许**跟「确认它退了」共用一句话 —— 我们手里连 pid 都没有,证明不了任何事");
  assert.equal((await db.select().from(schema.monitorReclaimDebts)
    .where(eq(schema.monitorReclaimDebts.monitorId, monId))).length, 0,
    "没有 pid 就记不出回收责任,也不该假装记了一笔");
}

console.log("✓ 创建协议：登记失败什么都没起 / 回填失败不放行且命令从未开工 / 问不出身份时不冒充收干净 / 闸的两面 / pid 空着的行照实接回 均受回归保护");
await teardown();
