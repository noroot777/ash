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
// ⑤ **起了进程之后的每一个失败出口都归同一个收尾**(第 9 轮审查 F2)。那一段里任何一次
//    await 抛出来,进程都已经存在、行写着 running、运行时却还没接手 —— 不会到期、不会收尾、
//    不会有任何结束事件,除了重启或人工再没人碰它(实测 `stored.status=running` +
//    `shellAliveAfterDeadline=true`)。所以钉的是「整段兜住」,不是某一个已知会抛的函数。
// ⑥ **身份不全不许开工 / pid 空着的行要能被身份边条按代次认回来**(第 9 轮审查 F3)。
// ⑦ **来源那一轮过去了就不上膛**(第 9 轮审查 F1):上膛是一条原子语句,它同时证明「行还
//    running」「还是那一轮」「绑的那次审查还在那一轮上」—— 不是在每个新发现的 await 前补读。
// ⑧ **交接恢复不了就拒,收进程要收整棵树**(第 10 轮审查 F2-C):闸和身份边条**两样都没有**时,
//    那条命令可能已经开工而重启后谁都定位不到它 —— 这一档只有「拒」一个正确答案。反过来只少
//    一样(POSIX 上边条写不下来)不致命,照旧放行,把一次正常创建搞失败同样是错。
// ⑨ **补偿自己失败时也得有人接管**(第 10 轮审查 F3):收尾那几笔读写一样会抛,而抛出去就连
//    收口一起跳过,留下一条 running、无人接管、也没有重试者的行。
// ④ **闸本身的两面**:写端关闭(= ash 在放行前没了)⇒ 壳在 exec 之前退出(97),命令从未开工;
//    放行 ⇒ 命令照常跑起来。少了后半句,一个「永远不放行」的实现也能骗过前三条。
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import {
  db, detachAllMonitors, inTurnCaller, isPidAlive, makeTask, monitors, insertMonitorRow,
  reattachMonitors, reviewInFlight, root, runs, schema, sleep, startMonitor, stopMonitor,
  teardown, until,
} from "./monitors-fixture.js";
import { inspectProcess } from "../src/proc.js";

const { dbClient } = await import("../src/db/index.js");
const { handoverRecoverable, monitorSpawnIdentityPath, spawnMonitor } = await import("../src/monitor-spawn.js");
const { abandonRegistration } = await import("../src/monitor-create.js");
const { sweepMonitorReclaimDebts } = await import("../src/monitor-reclaim-debts.js");
const { beginTaskRevocation, releaseTaskRevocation } = await import("../src/claude-monitor-revoked.js");

const debtRow = async (monId: string) => (await db.select().from(schema.monitorReclaimDebts)
  .where(eq(schema.monitorReclaimDebts.monitorId, monId))).at(0);

/**
 * 「现在有几个进程的命令行里带着这个记号」。
 *
 * 放行闸那段壳前缀是**拼在用户命令前面**的,所以记号在 `sh -lc …` 的 argv 里 —— 壳还停在
 * 闸前面时 `pgrep -f` 就数得到它。于是这一个数既能证明「连壳都没起」,也能证明「壳起了但
 * 已经收掉了」。
 */
const psCount = (token: string): number => {
  try {
    const out = execFileSync("pgrep", ["-f", token], { encoding: "utf8" });
    return out.split("\n").filter((line: string) => line.trim()).length;
  } catch {
    return 0;   // pgrep 没找到时退出码 1
  }
};

/** 每个用例一个独一无二的记号 + 一个「命令真的开工了才会出现」的文件。 */
let tokenSeq = 0;
const marker = (): { token: string; path: string; command: string } => {
  const token = `ash-create-probe-${++tokenSeq}-${process.pid}`;
  const path = join(root, `${token}.touched`);
  // `touch` 是命令的第一句:闸放行之后它立刻出现,不放行就永远不出现。
  return { token, path, command: `touch '${path}'; while :; do sleep 0.2; done` };
};

/** 让某个任务的哨兵 insert 真的失败(SQLite 触发器,不替换产品里的任何函数)。 */
const blockInsert = async (taskId: string) => {
  await dbClient.execute(`CREATE TRIGGER fixture_block_insert BEFORE INSERT ON monitors`
    + ` WHEN NEW.task_id='${taskId}' BEGIN SELECT RAISE(ABORT, 'INJECTED_MONITOR_INSERT_FAILURE'); END`);
};
const healInsert = () => dbClient.execute("DROP TRIGGER IF EXISTS fixture_block_insert");

/**
 * 让**回填 pid 那一条 UPDATE** 失败,而失败分支自己要写的 `status/ended_reason` 照旧写得进去。
 * `BEFORE UPDATE OF pid` 只在 pid 出现在 SET 列表里时才触发,所以这两条语句分得开。
 */
const blockPidBackfill = async (taskId: string) => {
  await dbClient.execute(`CREATE TRIGGER fixture_block_pid BEFORE UPDATE OF pid ON monitors`
    + ` WHEN NEW.task_id='${taskId}' AND OLD.pid IS NULL AND NEW.pid IS NOT NULL`
    + ` BEGIN SELECT RAISE(ABORT, 'INJECTED_PID_BACKFILL_FAILURE'); END`);
};
const healPidBackfill = () => dbClient.execute("DROP TRIGGER IF EXISTS fixture_block_pid");

/** 让「身份这一问」在一段时间里真的失败:PATH 前置一个退出码 1 的 `ps`(同 reclaim-debt 那份)。 */
const brokenBin = join(root, "create-broken-bin");
mkdirSync(brokenBin, { recursive: true });
writeFileSync(join(brokenBin, "ps"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
async function withPsOutage<T>(body: () => Promise<T>): Promise<T> {
  const real = process.env.PATH ?? "";
  process.env.PATH = `${brokenBin}:${real}`;
  try {
    assert.equal(inspectProcess(process.pid), null, "台子前提:这段时间 ps 真的问不出来");
    return await body();
  } finally {
    process.env.PATH = real;
  }
}

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


// ── ⑥⑦⑧ 创建是**一段时间**:这中间的撤销与结局都要被同一份协议接住(第 8 轮审查 F1/F3)──
//
// ①—⑤ 钉的是「身份先落库」。但创建不是一个瞬间:登记、起进程、回填 pid、放行之间都有真实的
// 等待,而这中间会发生三件事 —— 用户点停、任务被删、壳自己退掉。前两件要让命令**不开工**,
// 第三件要被**恰好结算一次**。下面三块逐个钉,共用一副把回填 pid 停在边界上的台子。

/**
 * 把「回填 pid」那一条 UPDATE 停在边界上。
 *
 * 真 SQL、真边界:只是让那一条语句晚一点执行,不伪造状态、不替换产品里的任何判断(审查的
 * 复现脚本用的也是这一招)。
 */
function pausePidBackfill(): { reached: Promise<void>; open: () => void; restore: () => void } {
  const real = dbClient.execute.bind(dbClient);
  let signal!: () => void;
  const reached = new Promise<void>((r) => { signal = r; });
  let openGate!: () => void;
  const gate = new Promise<void>((r) => { openGate = r; });
  let paused = false;
  (dbClient as { execute: typeof real }).execute = (async (statement: unknown) => {
    const sql = typeof statement === "string" ? statement : String((statement as { sql?: string })?.sql ?? "");
    if (!paused && /^update "monitors" set "pid"/i.test(sql)) {
      paused = true;
      signal();
      await gate;
    }
    return real(statement as Parameters<typeof real>[0]);
  }) as typeof real;
  return { reached, open: openGate, restore: () => { (dbClient as { execute: typeof real }).execute = real; } };
}

/**
 * 让**上膛那一条 UPDATE** 抛一次,然后立刻还原真实数据库。
 *
 * 跟 `pausePidBackfill` 是一对:那个把它停在边界上(测撤销),这个让它**抛**(测所有权边界)。
 * 只抛一次 —— 收尾自己还要写库,把收尾也打掉就测不出「收尾到底做了什么」。
 */
function failNextArm(): { restore: () => void } {
  const real = dbClient.execute.bind(dbClient);
  let fired = false;
  (dbClient as { execute: typeof real }).execute = (async (statement: unknown) => {
    const sql = typeof statement === "string" ? statement : String((statement as { sql?: string })?.sql ?? "");
    if (!fired && /^update "monitors" set "pid"/i.test(sql)) {
      fired = true;
      throw new Error("INJECTED_ARM_WRITE_FAILURE");
    }
    return real(statement as Parameters<typeof real>[0]);
  }) as typeof real;
  return { restore: () => { (dbClient as { execute: typeof real }).execute = real; } };
}

/**
 * 先让**上膛**抛一次,再让**收口那一笔**抛一次 —— 然后就放手。
 *
 * 为的是第 10 轮审查 F3 那一幕:上一版收尾里是一次裸读 + 一次裸写,抛出去就既没人接管、也没人
 * 重试。所以这里要的不是「收尾能不能成功」,而是**它失败之后那一行最终有没有落定**。
 */
function failArmThenSettle(): { restore: () => void; settleFailed: () => boolean } {
  const real = dbClient.execute.bind(dbClient);
  let stage: "arm" | "settle" | "done" = "arm";
  (dbClient as { execute: typeof real }).execute = (async (statement: unknown) => {
    const sql = typeof statement === "string" ? statement : String((statement as { sql?: string })?.sql ?? "");
    if (stage === "arm" && /^update "monitors" set "pid"/i.test(sql)) {
      stage = "settle";
      throw new Error("INJECTED_ARM_WRITE_FAILURE");
    }
    // 收口只有这两笔:确认收干净了就删掉那一行,收不干净就写成 lost。
    if (stage === "settle" && /^(delete from "monitors"|update "monitors" set "status")/i.test(sql)) {
      stage = "done";
      throw new Error("INJECTED_SETTLE_WRITE_FAILURE");
    }
    return real(statement as Parameters<typeof real>[0]);
  }) as typeof real;
  return {
    restore: () => { (dbClient as { execute: typeof real }).execute = real; },
    settleFailed: () => stage === "done",
  };
}

// ⑥ **创建期点停:页面说停了,后台就不许随后才开工。**
//
// 上一版的现场:点停读到一条 pid 还空着的运行行 → 回收层按「没有待收资源」放过 → 写成
// stopped 并成功返回;创建随后照旧放行,命令这才开工;再点停时状态已经不是 running,收尾函数
// 第一行就返回 —— 页面写着已停止、进程活着、而且再也停不掉(实测 `aliveAfterSecondStop=true`)。
{
  const taskId = await makeTask();
  const m = marker();
  const paused = pausePidBackfill();
  const creating = startMonitor({ taskId, command: m.command, description: "创建期被点停的" });
  await paused.reached;
  const intent = (await db.select().from(monitors).where(eq(monitors.taskId, taskId))).at(0)!;
  assert.equal(intent.pid, null, "台子前提:此刻身份已登记、pid 还空着");
  assert.equal(existsSync(m.path), false, "台子前提:命令还没开工");

  // 点停。**它跟创建共用那条 `task:<id>` 队列**,所以这一步会一直等到创建收口 —— 先确认它
  // 确实还没返回,再放开回填。
  const stopping = stopMonitor(intent.id, "用户在创建期点的停");
  let settled = false;
  void stopping.then(() => { settled = true; });
  await sleep(150);
  assert.equal(settled, false, "停止要排进创建那条队列,不能在半成品上自己下结论");
  paused.open();
  const created = await creating;
  const stopped = await stopping;
  paused.restore();

  assert.equal(created.ok, false, "创建期被撤销 ⇒ 这次创建就该如实失败");
  assert.match(created.ok === false ? created.error : "", /已经被停掉了/);
  assert.match(created.ok === false ? created.error : "", /没有开工/);
  await sleep(300);
  assert.equal(existsSync(m.path), false,
    "**页面说停了,命令就一个字都不许跑** —— 放行之前要重读那一行,读到非 running 就不放行");
  const row = (await db.select().from(monitors).where(eq(monitors.id, intent.id))).at(0)!;
  assert.equal(row.status, "stopped", "用户点出来的「已停止」要留着(刷新页面还看得见)");
  assert.equal(stopped?.status, "stopped", "停止也要如实回「已停止」");
  assert.ok(row.pid, "pid 仍然落在那一行上 —— 它是那个壳的唯一线索");
  await until("闸前那个壳被收掉", async () => !isPidAlive(row.pid!));
  assert.equal((await db.select().from(schema.monitorReclaimDebts)
    .where(eq(schema.monitorReclaimDebts.monitorId, intent.id))).length, 0, "确认退出了就不留责任");
}

// ⑦ **创建期任务被撤销(删除)**:同一条判据,另一条不排队的撤销路径。
//
// `beginTaskRevocation` 是同步关闸、之后才去抢 `task:<id>` 队列,所以入口那一问可能在关闸
// 之前就过了 —— 放行之前必须再问一次。
{
  const taskId = await makeTask();
  const m = marker();
  const paused = pausePidBackfill();
  const creating = startMonitor({ taskId, command: m.command, description: "创建期任务被删的" });
  await paused.reached;
  const intent = (await db.select().from(monitors).where(eq(monitors.taskId, taskId))).at(0)!;
  beginTaskRevocation(taskId);
  paused.open();
  const created = await creating;
  paused.restore();
  releaseTaskRevocation(taskId);

  assert.equal(created.ok, false);
  assert.match(created.ok === false ? created.error : "", /已经开始删除/);
  await sleep(300);
  assert.equal(existsSync(m.path), false, "撤销之后命令不许开工");
  // **这里钉的是那条不变量本身,不是某一种实现**:撤销之后要么已经确认没有资源留下(那就
  // 连这条意图行一起撤掉,界面上跟没点过一样),要么身份必须留着(pid 在行上 —— 删除那一侧
  // 按资源责任核对,空 pid 会被它当成「没东西要收」)。两者缺一不可、不许都不成立。
  const row = (await db.select().from(monitors).where(eq(monitors.id, intent.id))).at(0);
  if (row) {
    assert.ok(row.pid, "行留着的那一档:pid 必须在上面,它是那个壳唯一的线索");
    await until("闸前那个壳被收掉", async () => !isPidAlive(row.pid!));
  } else {
    assert.equal(psCount(m.token), 0, "行撤掉的那一档:前提是进程已经确认不在了(句柄等到了它的 exit)");
    assert.equal((await db.select().from(schema.monitorReclaimDebts)
      .where(eq(schema.monitorReclaimDebts.monitorId, intent.id))).length, 0,
    "确认收干净了才许撤行,所以也不该留下回收责任");
  }
}

// ⑧ **壳在挂上运行时之前就退了**:结局要被恰好结算一次,不许假装还在盯。
//
// 上一版把 `child.on("exit")` 挂在 `onExit(cb)` 里,而订阅发生在回填 pid 这一次 await 之后:
// 命令有语法错误时壳在那之前就退掉了,那一次 exit 没有任何人听见,之后挂的监听器永远不会再
// 被叫 —— 于是一条已经死掉的哨兵在库里和界面上都写着 running,一直挂到约定时长到期
// (实测 `alive=false` 而 `row.status=running`、`exit_code=null`)。
{
  const taskId = await makeTask();
  const paused = pausePidBackfill();
  // `(` 过不了 sh 的语法检查:壳解析完当场失败,**在放行之前**就退了。
  const creating = startMonitor({ taskId, command: "(", description: "语法就错的" });
  await paused.reached;
  await sleep(700);   // 让它确确实实先死掉,再放开回填
  paused.open();
  const created = await creating;
  paused.restore();
  assert.equal(created.ok, true, "进程起得来、身份也落得下:这次创建本身是成功的");
  const monitorId = created.ok ? created.monitor.id : "";
  await until("已经发生的结局被结算", async () => {
    const row = (await db.select().from(monitors).where(eq(monitors.id, monitorId))).at(0);
    return row?.status === "exited";
  }, 5_000);
  const row = (await db.select().from(monitors).where(eq(monitors.id, monitorId))).at(0)!;
  assert.equal(row.status, "exited", "晚订阅也要收到已经发生的那次退出");
  assert.equal(isPidAlive(row.pid!), false, "它确实已经不在了");
  assert.ok((row.endedReason ?? "").length > 0, "结束原因要写上");
  assert.ok((await db.select().from(monitors).where(and(eq(monitors.taskId, taskId),
    eq(monitors.status, "running")))).length === 0, "更不许继续占着名额");
}


// ── ⑨ **起壳之后的任何异常都归同一个收尾**(第 9 轮审查 F2)─────────────────────────
//
// 这里打的是上膛那一条 UPDATE:它在所有权边界**里面**,抛出来的那一刻进程已经存在、行写着
// running、而运行时还没接手。上一版的边界只接住了 spawn 和回填两处失败,新加的那次读库漏在
// 外面 —— 于是留下一条永远 running、没有 tail、没有到期定时器的行。
//
// 钉这一条等于钉那个 try/catch 本身:把它去掉,`startMonitor` 会直接抛出去(下面这个 await
// 当场 reject),后面每一行都到不了。
{
  const taskId = await makeTask();
  const m = marker();
  const injected = failNextArm();
  let created: Awaited<ReturnType<typeof startMonitor>>;
  try {
    created = await startMonitor({ taskId, command: m.command, description: "上膛就抛的" });
  } finally {
    injected.restore();
  }
  assert.equal(created.ok, false, "交接没走完就不许报成功");
  assert.match(created.ok === false ? created.error : "", /中途出错/, "要说清是这一次创建自己没走完");
  await sleep(300);
  assert.equal(existsSync(m.path), false, "**没放行 ⇒ 命令一个字都没跑过**");
  await until("闸前那个壳被收掉", async () => psCount(m.token) === 0);
  const rows = await db.select().from(monitors).where(eq(monitors.taskId, taskId));
  assert.equal(rows.filter((r) => r.status === "running").length, 0,
    "**一条 running 却没人管的行都不许留** —— 它不会到期、不会收尾,还占着每任务 4 个的名额");
}

// ── ⑩ **身份问不全就不放行**(第 9 轮审查 F3-A)──────────────────────────────────
//
// 只有号、没有代次 = 跨代认不回来。上一版照旧回填、照旧放行,于是留下一行 `pid_started_at`
// 为空的身份,而回收判据在那一档上退化成存在性检查 —— 原命令跑完、号被系统复用之后,接回/
// 清扫/重复停止三条路都会拿着别人的进程当我们的下刀。
//
// 要收掉的那个壳由**句柄**证明所有权(ps 这会儿正不可用),所以这一档照样收得干净。
{
  const taskId = await makeTask();
  const m = marker();
  const refused = await withPsOutage(
    () => startMonitor({ taskId, command: m.command, description: "身份问不全的" }),
  );
  assert.equal(refused.ok, false, "问不出启动时刻就不许放行");
  assert.match(refused.ok === false ? refused.error : "", /启动时刻/, "要说清是哪一样问不出来");
  await sleep(300);
  assert.equal(existsSync(m.path), false, "命令一个字都没跑过");
  await until("壳被句柄收掉(ps 不可用也收得掉)", async () => psCount(m.token) === 0);
  const rows = await db.select().from(monitors).where(eq(monitors.taskId, taskId));
  assert.equal(rows.filter((r) => r.status === "running").length, 0, "不许留一条没人管的 running 行");
}

// ── ⑪ **来源那一轮过去了就不上膛**(第 9 轮审查 F1)──────────────────────────────
//
// 来源在入口一次抓全(这次创建代表的是第 1 轮),排队期间审查推到第 2 轮。上膛那一条语句同时
// 断言「绑的那次审查还在那一轮上」,所以它改到 0 行 —— 命令不开工,而不是被当成第 2 轮的输入
// 挂上去(审查实测:请求来自 round 1,行上却写着 `source_review_round=2`,命令照常开跑)。
{
  const taskId = await makeTask();
  await reviewInFlight(taskId, "run-arm-round", { round: 1 });
  // 审查来源由**占位方**交代(生产里是 free-review-round 的 `reviewSource`)。
  runs.claimTurn(taskId, "reviewer", { run: "run-arm-round", round: 1 });
  const caller = await inTurnCaller(taskId);
  const m = marker();
  const paused = pausePidBackfill();
  const creating = startMonitor({ taskId, command: m.command, description: "第 1 轮提交的", caller });
  await paused.reached;
  const intent = (await db.select().from(monitors).where(eq(monitors.taskId, taskId))).at(0)!;
  assert.equal(intent.sourceReviewRound, 1, "台子前提:来源绑的是入口抓到的那一轮");
  // 审查推到第 2 轮(真实流程里 `nextRound` 复用同一个 run,只把 current_round 加一)。
  await db.update(schema.freeReviewRuns).set({ currentRound: 2 })
    .where(eq(schema.freeReviewRuns.id, "run-arm-round"));
  paused.open();
  const created = await creating;
  paused.restore();
  runs.releaseTurn(taskId);

  assert.equal(created.ok, false, "上一轮提交的请求不许在新一轮里成立");
  assert.match(created.ok === false ? created.error : "", /不在进行|下一轮/,
    "措辞要说清是「那一轮过去了」,而不是凭据不对");
  await sleep(300);
  assert.equal(existsSync(m.path), false, "**没上膛 ⇒ 没放行 ⇒ 命令一个字都没跑**");
  await until("闸前那个壳被收掉", async () => psCount(m.token) === 0);
  const rows = await db.select().from(monitors).where(eq(monitors.taskId, taskId));
  assert.equal(rows.filter((r) => r.status === "running").length, 0, "不许留一条没人管的 running 行");
  assert.equal(rows.filter((r) => r.sourceReviewRound === 2).length, 0,
    "**更不许把它改绑到第 2 轮** —— 那就是把上一轮的结果送进下一轮");
}

// ── ⑫ **pid 空着的行:身份边条按代次认回来**(第 9 轮审查 F3-B)───────────────────
//
// ash 死在「落了身份」和「回填 pid」之间时,库里只剩一行没有 pid 的记录。win32 那一侧没有放行
// 闸,命令可能已经在跑 —— 而上一版到这里只能说一句「认不回来」:id、命令、日志路径都在,却没有
// 任何能定位那个进程的身份。现在 `spawn` 一返回就同步写下 `{pid, 这一刻}`,接回那一侧拿它
// **按代次**认(不是「这个号上有人」就算)。
{
  const taskId = await makeTask();
  const m = marker();
  const started = await startMonitor({ taskId, command: m.command, description: "要被重启打断的" });
  assert.ok(started.ok, `正常创建应该成功：${started.ok ? "" : started.error}`);
  const monitorId = started.ok ? started.monitor.id : "";
  const armed = (await db.select().from(monitors).where(eq(monitors.id, monitorId))).at(0)!;
  assert.ok(armed.pid && armed.pidStartedAt, "台子前提:正常创建落下的是完整身份");
  assert.ok(existsSync(monitorSpawnIdentityPath(armed.logPath)), "台子前提:身份边条也在盘上");
  await until("命令真的开工了", async () => existsSync(m.path));

  // 模拟「ash 恰好死在 spawn 和回填 pid 之间」:行回到 pid 空着的样子,运行时全撤掉。
  detachAllMonitors();
  await db.update(monitors).set({ pid: null, pidStartedAt: null }).where(eq(monitors.id, monitorId));
  const { attached } = await reattachMonitors();
  const back = (await db.select().from(monitors).where(eq(monitors.id, monitorId))).at(0)!;
  assert.equal(back.pid, armed.pid, "身份边条按代次把那个 pid 认回来了");
  assert.equal(back.pidStartedAt, armed.pidStartedAt, "启动时刻一起回填 —— 这才是**完整**身份");
  assert.equal(back.status, "running", "认回来的不许被写成 lost");
  assert.ok(attached >= 1, "它该算接回成功");
  await stopMonitor(monitorId, "测试收尾");
  await until("点停真的收掉了它", async () => psCount(m.token) === 0);

  // 反面:边条指的那个号现在是**另一个进程**(锚差了几分钟)⇒ 一律不认,更不许去碰它。
  const other = await makeTask();
  const monId = await insertMonitorRow(other);
  const row0 = (await db.select().from(monitors).where(eq(monitors.id, monId))).at(0)!;
  writeFileSync(
    monitorSpawnIdentityPath(row0.logPath),
    JSON.stringify({ pid: process.pid, spawnedAtMs: Date.now() }),
  );
  await reattachMonitors();
  const after = (await db.select().from(monitors).where(eq(monitors.id, monId))).at(0)!;
  assert.equal(after.pid, null, "锚对不上就不认 —— 存在性不是身份");
  assert.equal(after.status, "lost");
  assert.match(after.endedReason ?? "", /现在是另一个进程/, "照实说它为什么认不回来");
  assert.equal(isPidAlive(process.pid), true, "**绝不许去碰那个进程** —— 它不是我们的");
}

// ── ⑬ **交接要可恢复,收进程要收整棵树**(第 10 轮审查 F2-C)─────────────────────────
//
// 「可恢复」是两条路的或:有闸(命令还没开工,撒手即无残留)或者身份边条落了盘(认得回代次)。
// 两条都没有时命令可能在跑而谁都定位不到它 —— 那一档只有「拒」一个正确答案。
{
  // 1) 判据本身。它是这一条不变量的全部内容,所以先把真值表钉死。
  assert.equal(handoverRecoverable({ gated: true, identitySaved: true }), true);
  assert.equal(handoverRecoverable({ gated: true, identitySaved: false }), true,
    "有闸 ⇒ 命令还没开工:边条写不下来也没有需要定位的残留");
  assert.equal(handoverRecoverable({ gated: false, identitySaved: true }), true,
    "没有闸但记下了代次 ⇒ 重启后按代次认得回来");
  assert.equal(handoverRecoverable({ gated: false, identitySaved: false }), false,
    "**两样都没有 ⇒ 命令可能在跑而谁都收不掉它**,这一次创建必须被拒");

  // 2) 边条写不下来是真会发生的一档(盘满、那个路径被占)。POSIX 上闸兜着,所以这一次创建
  //    照旧该成功 —— 拿一个不致命的失败去毁一次正常创建同样是错。这里把写失败做成确定性的:
  //    边条要落的那个路径上先摆一个目录,`writeFileSync` 必然 EISDIR。
  const logPath = join(root, `handover-${process.pid}.log`);
  mkdirSync(monitorSpawnIdentityPath(logPath), { recursive: true });
  const token = `ash-handover-probe-${process.pid}`;
  const touched = join(root, `${token}.touched`);
  // 后代用 `( … ) &` 起:那个子壳跟父壳**同一份 argv**,所以 `pgrep -f` 数得到它 —— 于是
  // 「只打根进程」和「打整组/整棵树」两种实现在下面那句断言上分得开。
  const spawned = spawnMonitor({
    command: `: ${token}; touch '${touched}'; ( while :; do sleep 0.2; done ) & while :; do sleep 0.2; done`,
    cwd: root,
    logPath,
  });
  assert.ok(!("error" in spawned), `台子前提:起得起来（${"error" in spawned ? spawned.error : ""}）`);
  if ("error" in spawned) throw new Error(spawned.error);
  assert.equal(statSync(monitorSpawnIdentityPath(logPath)).isDirectory(), true,
    "台子前提:边条那一笔真的写失败了(路径上还是那个目录)");
  assert.equal(spawned.recoverable, true, "POSIX 上闸恒在 ⇒ 边条写不下来也照旧可恢复,不该拒");
  spawned.release();
  await until("命令照常开工了 —— 边条写失败不致命", async () => existsSync(touched));
  await until("后代也起来了(台子前提)", async () => psCount(token) >= 2);

  // 3) **根进程退出不证明这条命令结束了**:句柄这一刀要覆盖它派生的后代。
  spawned.kill();
  await until("**整棵树/整组一起没了**", async () => psCount(token) === 0);

  // win32 那两条 —— 没有闸时边条写失败就拒、`taskkill /T` 收整棵树 —— 在 macOS 上跑不到
  // (`gated` 恒为真)。所以这里只钉判据和 POSIX 那一面,win32 一侧仍是**未在真机验证**的代码
  // (根 AGENTS.md:那台机器现在连不上)。
}

// ── ⑭ **补偿自己失败时也得有人接管**(第 10 轮审查 F3)──────────────────────────────
//
// 上一版的收尾里先有一次裸读、再有一次裸写。读抛出去 ⇒ 下面的收口整段被跳过;写抛出去 ⇒ 只
// 在日志里留一句。两种都留下同一样东西:一条 `running` 行,没有 tail、没有到期定时器、没有退出
// 回调 —— 它不会产生任何结束事件,而**也没有任何人会再来重试**(实测 `stored.status=running`
// + `commandStarted=false` + `pending=[]`)。
//
// 所以钉的不是「收尾会不会失败」,而是**失败之后那一行最终有没有落定**。
{
  const taskId = await makeTask();
  const m = marker();
  const injected = failArmThenSettle();
  let created: Awaited<ReturnType<typeof startMonitor>>;
  try {
    created = await startMonitor({ taskId, command: m.command, description: "连收口都写不进库的" });
  } finally {
    injected.restore();
  }
  assert.equal(created.ok, false, "交接没走完就不许报成功");
  assert.equal(injected.settleFailed(), true, "台子前提:收口那一笔真的被打掉了一次");
  const stuck = (await db.select().from(monitors).where(eq(monitors.taskId, taskId))).at(0);
  assert.equal(stuck?.status, "running", "台子前提:这一刻库里就是那条没人管的 running 行");
  await sleep(300);
  assert.equal(existsSync(m.path), false, "**没放行 ⇒ 命令一个字都没跑过**");
  await until("闸前那个壳照旧被收掉", async () => psCount(m.token) === 0);
  // 重试阶梯第一级 1s。兜底仍然是开机接回,阶梯只是让这件事不用等到下次重启。
  await until(
    "那一行最终被收口 —— 补偿失败也有接管者",
    async () => (await db.select().from(monitors)
      .where(and(eq(monitors.taskId, taskId), eq(monitors.status, "running")))).length === 0,
    6_000,
  );
}

console.log("✓ 创建协议：登记失败什么都没起 / 回填失败不放行且命令从未开工 / 问不出身份时不冒充收干净 / 闸的两面 / pid 空着的行照实接回或按代次认回来 / 创建期点停与撤销都不放行 / 壳先退了也恰好结算一次 / 起壳之后每个失败出口都有人收尾 / 身份不全不放行 / 来源那一轮过去了就不上膛 / 交接恢复不了才拒、恢复得了就不许拒 / 句柄这一刀收整棵树 / 收口自己失败也有人重试 均受回归保护");
await teardown();