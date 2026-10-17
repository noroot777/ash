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
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import {
  db, insertMonitorRow, isPidAlive, makeTask, monitors, tasks, teardown, until,
} from "./monitors-fixture.js";
import { debtRow } from "./monitor-reclaim-fixture.js";
import { processUnitEvidence } from "../src/proc.js";
import { invalidateMonitorUnitScan, monitorUnitProofGrade } from "../src/monitor-unit-scan.js";

const { deleteTaskCompletely } = await import("../src/task-delete-routes.js");
const { reclaimUnconfirmedStops } = await import("../src/monitor-reclaim.js");
const { killTree } = await import("../src/platform.js");
const { dbClient } = await import("../src/db/index.js");
const { monitorSpawnIdentityPath } = await import("../src/monitor-spawn.js");
const { reattachMonitors } = await import("../src/monitors.js");

/** 记号那一问在这台机器上答得有多实:Linux 读得到真实环境项(`exact`),macOS 只有展示文本。 */
const EXACT_MARKS = monitorUnitProofGrade() === "exact";
const strays: number[] = [];

/** 生产同形的被盯进程:**真的带着这次创建的记号**,所以记号那一问认得出它(见 proc.ts)。 */
function markedProcess(unitToken: string): number {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true, stdio: "ignore", env: { PATH: process.env.PATH!, ASH_MONITOR_UNIT: unitToken },
  });
  child.unref();
  invalidateMonitorUnitScan();   // 起了新进程 ⇒ 上一份全表扫描的备忘作废(生产里由 spawn 负责)
  strays.push(child.pid!);
  return child.pid!;
}

const readRow = async (id: string) => (await db.select().from(monitors).where(eq(monitors.id, id))).at(0);

/** 一行「身份落了、进程起了、pid 还没回填」的创建意图行 —— 重启后库里剩下的就是这个样子。 */
async function intentRow(taskId: string, unitToken: string, pid: number): Promise<string> {
  const id = await insertMonitorRow(taskId, {
    status: "running", pidStartedAt: null, command: process.execPath, unitToken,
  });
  const row = (await readRow(id))!;
  assert.equal(row.pid, null, "台子前提:这一行的 pid 还空着,走的就是重启后认领那一支");
  writeFileSync(monitorSpawnIdentityPath(row.logPath), JSON.stringify({ pid, spawnedAtMs: Date.now() }));
  // 只留这一行给启动去问:别的行各有各的台子,混在一起看不出是谁的结论。
  await dbClient.execute(`UPDATE monitors SET status = 'stopped' WHERE id <> '${id}'`);
  return id;
}

/** 只让**那一句** SELECT 抛一次(审查实测用的同一招),别的语句照常。 */
const withLedgerReadFailure = async <T>(run: () => Promise<T>): Promise<[T, number]> => {
  const original = dbClient.execute;
  let injected = 0;
  dbClient.execute = (async function (statement: unknown, ...rest: unknown[]) {
    const sql = String(typeof statement === "string" ? statement : (statement as { sql?: string })?.sql);
    if (injected === 0 && /^\s*select\s+"identity_disproved_at"\s+from/i.test(sql)) {
      injected += 1;
      throw new Error("fixture: identity-ledger read failure");
    }
    return (original as (...a: unknown[]) => unknown).call(dbClient, statement, ...rest);
  }) as typeof dbClient.execute;
  try { return [await run(), injected]; } finally { dbClient.execute = original; }
};

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
  assert.deepEqual(first, { attached: 0, lost: 0, pending: 1 },
    "既不算接回来、也不算没了:混进任何一边都是撒谎");
  assert.equal(await debtRow(mon), undefined,
    "这一刻不记回收债:债是补刀授权,而这一行的进程多半正常跑着");
  assert.equal(isPidAlive(pid), true, "候选号一个信号都不授权");

  // ② 故障撤掉 ⇒ **同一条路自己认得回来**(台子一个字都不帮它改)。
  const second = await reattachMonitors();
  const adopted = (await readRow(mon))!;
  assert.equal(adopted.pid, pid, "「下一次启动会再问一遍」不是一句空话");
  assert.deepEqual({ attached: second.attached, pending: second.pending }, { attached: 1, pending: 0 },
    "这一遍照实算接回来了");
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

  console.log(
    "✓ 创建意图的责任接管：认不回来时行原样留着且一刀不发 / 故障撤掉后启动自己认得回来 /"
    + " 删除前那一问问得到 pid 还空着的意图行、责任落盘才许删 / 开机清扫按边条把它重新问一遍"
    + " 均受回归保护",
  );
} finally {
  for (const p of strays) if (isPidAlive(p)) killTree(p, "SIGKILL");
  for (const p of strays) await until(`台子收掉 pid=${p}`, async () => !isPidAlive(p)).catch(() => {});
  await teardown();
}
