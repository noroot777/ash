// **创建意图/收尾交接那两份回归共用的台子。**两份测试各自起一个进程、各自一个临时库,
// 所以这里只放「怎么造现场、怎么注故障」那几件事,不放任何断言。
//
// 拆出来的原因是行数上限(全局约定:单个代码文件不超过 700 行):幕越钉越多,原来那一份已经
// 顶到 688 行。按内容分两份:**认不回号那一族**(接回、认领、梯子)和**收尾交接那一族**
// (点停插进来、终态没落上)。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import filesystem, { writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { eq } from "drizzle-orm";
import { db, insertMonitorRow, isPidAlive, monitors, until } from "./monitors-fixture.js";
import { invalidateMonitorUnitScan, monitorUnitProofGrade } from "../src/monitor-unit-scan.js";

const { killTree } = await import("../src/platform.js");
const { dbClient } = await import("../src/db/index.js");
const { monitorSpawnIdentityPath } = await import("../src/monitor-spawn.js");

/** 记号那一问在这台机器上答得有多实:Linux 读得到真实环境项(`exact`),macOS 只有展示文本。 */
export const EXACT_MARKS = monitorUnitProofGrade() === "exact";
export const strays: number[] = [];

/** 生产同形的被盯进程:**真的带着这次创建的记号**,所以记号那一问认得出它(见 proc.ts)。 */
export function markedProcess(unitToken: string): number {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true, stdio: "ignore", env: { PATH: process.env.PATH!, ASH_MONITOR_UNIT: unitToken },
  });
  child.unref();
  invalidateMonitorUnitScan();   // 起了新进程 ⇒ 上一份全表扫描的备忘作废(生产里由 spawn 负责)
  strays.push(child.pid!);
  return child.pid!;
}

export const readRow = async (id: string) => (await db.select().from(monitors).where(eq(monitors.id, id))).at(0);

/** 一行「身份落了、进程起了、pid 还没回填」的创建意图行 —— 重启后库里剩下的就是这个样子。 */
export async function intentRow(taskId: string, unitToken: string, pid: number): Promise<string> {
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

/**
 * 让**某一个文件**的读抛 EIO(审查实测用的同一招),别的文件照常。
 *
 * `once: true` 时第一次读就自己把故障撤掉 —— 下一秒恢复梯子再问时读到的是真东西,这才量得出
 * 「故障过去之后它自己得出了什么结论」。
 */
export function failSidecarRead(path: string, opts: { once?: boolean } = {}): { reads: () => number; restore: () => void } {
  const real = filesystem.readFileSync;
  let reads = 0;
  const restore = () => { filesystem.readFileSync = real; syncBuiltinESMExports(); };
  filesystem.readFileSync = ((p: unknown, ...rest: unknown[]) => {
    if (String(p) === path) {
      reads += 1;
      if (opts.once) restore();
      throw Object.assign(new Error("fixture: transient sidecar read I/O error"), { code: "EIO" });
    }
    return (real as (...a: unknown[]) => unknown)(p, ...rest);
  }) as typeof filesystem.readFileSync;
  syncBuiltinESMExports();
  return { reads: () => reads, restore };
}

/** 只让**那一句** SELECT 抛一次(审查实测用的同一招),别的语句照常。 */
export const withLedgerReadFailure = async <T>(run: () => Promise<T>): Promise<[T, number]> => {
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

/** 台子起过的进程全收掉(每一份测试的 finally 都调它)。 */
export async function reapStrays(): Promise<void> {
  for (const p of strays) if (isPidAlive(p)) killTree(p, "SIGKILL");
  for (const p of strays) await until(`台子收掉 pid=${p}`, async () => !isPidAlive(p)).catch(() => {});
}
