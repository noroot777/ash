// **号被复用的那几笔账:能证明原进程已经不在,就自己了结;证明不了,一笔都不许了结。**
//
// 开机账上那批永远对不平的记录(2026-11-13 实测 11 笔,单笔重试 52–340 次)全是同一个现场:
// 记录的那个号上现在是**更晚起来的另一个进程**,记号在任何活进程上都读不到。上一版把它停在
// `not-ours`(「原进程退出无法确认」),每次开机重试、重报一遍。可号被复用本身就是证明 ——
// POSIX 在一个号的进程**和以它为组号的进程组**都结束之前不会把它分配出去(判据与理由见
// monitor-reclaim-evidence.ts 的 `rootSuperseded`)。
//
// 这一份钉两面:
//  ① 能证明的那一种:收档、戳上写清依据、之后清扫不再碰它、也不碰号上的新主人;
//     接回那一侧遇到同样的现场,责任行生下来就是收档态(不再新添一笔永远平不了的账);
//  ② 证明不了的几种**一笔都不许了结**:原进程的后代还带着记号活着(开机账上那笔 colima 守护
//     进程就是这一幕)、读出来的新主人反而更早(读数不可信)、ps 这一刻问不出来。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  db, insertMonitorRow, isPidAlive, makeTask, monitors, reattachMonitors, schema, teardown, until,
} from "./monitors-fixture.js";
import { STUBBORN, debtRow, withPsOutage } from "./monitor-reclaim-fixture.js";
import { inspectProcess } from "../src/proc.js";
import { MONITOR_UNIT_ENV, invalidateMonitorUnitScan, monitorUnitProofGrade } from "../src/monitor-unit-scan.js";

const { sweepMonitorReclaimDebts } = await import("../src/monitor-reclaim-debts.js");
const { isTracelessState, reclaimState } = await import("../src/monitor-reclaim-evidence.js");
const { killTree } = await import("../src/platform.js");

const SUPERSEDED_NOTE = /原进程已不存在.*已被更晚起来的另一个进程占用/;

/** 台子自己起的进程:各条用例结束各收各的,teardown 前再兜一遍。 */
const spawned: number[] = [];
async function spawnStubborn(env: NodeJS.ProcessEnv = {}): Promise<number> {
  const child = spawn("sh", ["-c", STUBBORN], { detached: true, stdio: "ignore", env: { ...process.env, ...env } });
  child.unref();
  const pid = child.pid!;
  spawned.push(pid);
  await until("进程起来了", async () => inspectProcess(pid) !== null);
  invalidateMonitorUnitScan();   // 判档吃 400ms 备忘:刚起的进程要让下一问看得见
  return pid;
}
async function reap(pid: number): Promise<void> {
  if (isPidAlive(pid)) killTree(pid, "SIGKILL");
  await until(`台子收掉 pid=${pid}`, async () => !isPidAlive(pid));
  invalidateMonitorUnitScan();
}

/** 按 `ps -o lstart`(C locale)的样子写一个时刻 —— 存进库里的就是这个形状。 */
const lstartAt = (ms: number): string => {
  const d = new Date(ms);
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()];
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getMonth()];
  const two = (n: number) => String(n).padStart(2, "0");
  return `${day} ${mon} ${String(d.getDate()).padStart(2, " ")} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())} ${d.getFullYear()}`;
};
const startedMsOf = (pid: number): number => inspectProcess(pid)!.startedAtMs!;

/** 一笔「上一辈子没收掉」的账:号是 `pid`,记录的那一代起在 `recorded`,记号是 `token`。 */
async function insertDebt(pid: number, recorded: string, token: string): Promise<string> {
  const monitorId = `mon-superseded-${randomUUID()}`;
  await db.insert(schema.monitorReclaimDebts).values({
    monitorId, taskId: "task-gone", pid, pidStartedAt: recorded, spawnAnchorMs: null,
    unitToken: token, identityDisprovedAt: null, command: "sleep 600",
    reason: "上一辈子把它停了，但退出从没被确认（这个号现在是另一个进程，原进程退出无法确认）",
    lastError: null, attempts: 0, createdAt: new Date().toISOString(), lastAttemptAt: null,
    closedAt: null, closedNote: null,
  });
  return monitorId;
}

try {
  {
    // ① 号上是**更晚**起来的另一个进程,记号一个都读不到 ⇒ 原进程与原进程组都已结束,收档。
    const stranger = await spawnStubborn();
    const recorded = lstartAt(startedMsOf(stranger) - 3_600_000);
    const monId = await insertDebt(stranger, recorded, `fixture-${randomUUID()}`);
    assert.equal(reclaimState(stranger, recorded, (await debtRow(monId))!), "superseded",
      "号被更晚的一代占着、记号问全了也没有 ⇒ 这一档是 superseded,不再是「原进程退出无法确认」");

    await sweepMonitorReclaimDebts();
    const closed = (await debtRow(monId))!;
    assert.ok(closed.closedAt, "能证明原进程已不在 ⇒ 开机清扫当场了结这一笔");
    assert.match(closed.closedNote ?? "", SUPERSEDED_NOTE, "戳上要写清依据:号已被更晚的另一个进程占用");
    assert.equal(closed.attempts, 0, "了结不是「重试够了」:一次都没记成失败");
    assert.equal(isPidAlive(stranger), true, "号上的新主人一刀都不许碰");

    // 之后再开机:不重试、不报。
    await sweepMonitorReclaimDebts();
    const again = (await debtRow(monId))!;
    assert.equal(again.closedAt, closed.closedAt, "收档戳是了结那一刻,不许被后来的清扫刷新");
    assert.equal(again.lastAttemptAt, null, "已了结的账不再参与清扫");
    await reap(stranger);
  }

  {
    // ② 原进程的后代**还带着记号活着**,只是根的号被别人占了 —— 开机账上 colima 那一笔就是这样。
    const token = `fixture-${randomUUID()}`;
    const survivor = await spawnStubborn({ [MONITOR_UNIT_ENV]: token });
    const stranger = await spawnStubborn();
    const recorded = lstartAt(startedMsOf(stranger) - 3_600_000);
    const monId = await insertDebt(stranger, recorded, token);
    assert.equal(isTracelessState(reclaimState(stranger, recorded, (await debtRow(monId))!)), false,
      "记号还在活进程上 ⇒ 不管号被谁占了,都不许判成「追空了」");

    await sweepMonitorReclaimDebts();
    const row = (await debtRow(monId))!;
    if (row.closedAt) {
      // 只有真实环境项读得出记号(Linux)时才可能走到这里:那一档认得出它、补刀收掉,然后才追空。
      assert.equal(monitorUnitProofGrade(), "exact", "展示文本那一档证不出归属,不许据此收掉它");
      assert.equal(isPidAlive(survivor), false, "收档之前那个带记号的后代必须已经不在");
    } else {
      assert.equal(isPidAlive(survivor), true, "证不出归属就不下刀");
      assert.doesNotMatch(row.lastError ?? "", /原进程已不存在/, "账上不许说原进程已经不在了");
    }
    assert.equal(isPidAlive(stranger), true, "号上的新主人一刀都不许碰");
    await reap(survivor);
    await reap(stranger);
  }

  {
    // ③ 读出来的新主人反而**更早** —— 复用的新主人不可能起得比原主人早,这次读数不配当证明。
    const stranger = await spawnStubborn();
    const recorded = lstartAt(startedMsOf(stranger) + 3_600_000);
    const monId = await insertDebt(stranger, recorded, `fixture-${randomUUID()}`);
    assert.equal(reclaimState(stranger, recorded, (await debtRow(monId))!), "not-ours",
      "对不上、但方向不对 ⇒ 停在 not-ours,不升成可收档的那一档");
    await sweepMonitorReclaimDebts();
    const row = (await debtRow(monId))!;
    assert.equal(row.closedAt, null, "证明不了就留着");
    assert.equal(row.attempts, 1, "照旧记一次没收掉");
    await reap(stranger);
  }

  {
    // ④ ps 这一刻问不出来 —— 什么都不许声称,账留着。
    const stranger = await spawnStubborn();
    const recorded = lstartAt(startedMsOf(stranger) - 3_600_000);
    const monId = await insertDebt(stranger, recorded, `fixture-${randomUUID()}`);
    await withPsOutage(stranger, async () => {
      invalidateMonitorUnitScan();
      assert.equal(isTracelessState(reclaimState(stranger, recorded, (await debtRow(monId))!)), false,
        "问不出来不是「追空了」");
      await sweepMonitorReclaimDebts();
    });
    assert.equal((await debtRow(monId))!.closedAt, null, "故障期间不许了结任何一笔");
    // 故障过去,同一笔账下一次清扫就能了结:判据没变,只是这一次答得出来了。
    invalidateMonitorUnitScan();
    await sweepMonitorReclaimDebts();
    assert.match((await debtRow(monId))!.closedNote ?? "", SUPERSEDED_NOTE, "答得出来之后照判据了结");
    await reap(stranger);
  }

  {
    // ⑤ 接回那一侧遇到同样的现场:责任行生下来就是收档态,不再新添一笔永远平不了的账。
    const taskId = await makeTask({ status: "running" });
    const stranger = await spawnStubborn();
    const recorded = lstartAt(startedMsOf(stranger) - 3_600_000);
    const monId = await insertMonitorRow(taskId, {
      status: "running", pid: stranger, pidStartedAt: recorded, unitToken: `fixture-${randomUUID()}`,
    });
    await reattachMonitors();
    const mon = (await db.select().from(monitors).where(eq(monitors.id, monId))).at(0)!;
    assert.equal(mon.status, "lost");
    assert.match(mon.endedReason ?? "", /另一个进程/, "卡片照实说这个号已经是另一个进程了");
    assert.doesNotMatch(mon.endedReason ?? "", /已记下回收责任/, "能证明原进程已不在,就没有欠着的责任");
    const debt = await debtRow(monId);
    assert.ok(debt?.closedAt, "身份留档,生下来就是收档态");
    assert.match(debt.closedNote ?? "", SUPERSEDED_NOTE);
    assert.equal(isPidAlive(stranger), true, "号上的新主人一刀都不许碰");
    await reap(stranger);
  }
} finally {
  for (const pid of spawned) if (isPidAlive(pid)) killTree(pid, "SIGKILL");
  await teardown();
}
console.log("✓ 号被更晚一代占用、记号无残留 ⇒ 开机/接回当场了结并写明依据,之后不再重试 / 原进程后代还带记号、读数方向不对、ps 不可用 ⇒ 一笔都不了结 均受回归保护");
