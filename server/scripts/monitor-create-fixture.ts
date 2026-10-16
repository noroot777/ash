// 创建协议那两份回归的共用台子:一份注入器 + 一个记号 + 一次真的 `ps` 不可用。
//
// 为什么单独一份:创建协议的回归分成了两份 —— 「顺序本身对不对」
// (test-monitor-create-protocol.ts:先落行、起进程停在闸前、回填 pid、放行)和「创建是一段
// 时间,这中间发生的事归谁收尾」(test-monitor-create-window.ts)。两份用的是同一副台子,
// 各抄一遍迟早漂移:漂的那一刻,两边对「命令到底开工了没有」的判据就分家了,而那正是这组
// 回归唯一要钉的东西。
//
// 台子本身必须排在任何 `src/` 模块之前落定,所以这里只转手 monitors-fixture 的那份环境,
// 不自己再建一套库。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { db, root, schema } from "./monitors-fixture.js";
import { inspectProcess } from "../src/proc.js";

export const { dbClient } = await import("../src/db/index.js");

export const debtRow = async (monId: string) => (await db.select().from(schema.monitorReclaimDebts)
  .where(eq(schema.monitorReclaimDebts.monitorId, monId))).at(0);

/**
 * 「现在有几个进程的命令行里带着这个记号」。
 *
 * 放行闸那段壳前缀是**拼在用户命令前面**的,所以记号在 `sh -lc …` 的 argv 里 —— 壳还停在
 * 闸前面时 `pgrep -f` 就数得到它。于是这一个数既能证明「连壳都没起」,也能证明「壳起了但
 * 已经收掉了」。
 */
export const psCount = (token: string): number => {
  try {
    const out = execFileSync("pgrep", ["-f", token], { encoding: "utf8" });
    return out.split("\n").filter((line: string) => line.trim()).length;
  } catch {
    return 0;   // pgrep 没找到时退出码 1
  }
};

/** 每个用例一个独一无二的记号 + 一个「命令真的开工了才会出现」的文件。 */
let tokenSeq = 0;
export const marker = (): { token: string; path: string; command: string } => {
  const token = `ash-create-probe-${++tokenSeq}-${process.pid}`;
  const path = join(root, `${token}.touched`);
  // `touch` 是命令的第一句:闸放行之后它立刻出现,不放行就永远不出现。
  return { token, path, command: `touch '${path}'; while :; do sleep 0.2; done` };
};

/** 让某个任务的哨兵 insert 真的失败(SQLite 触发器,不替换产品里的任何函数)。 */
export const blockInsert = async (taskId: string) => {
  await dbClient.execute(`CREATE TRIGGER fixture_block_insert BEFORE INSERT ON monitors`
    + ` WHEN NEW.task_id='${taskId}' BEGIN SELECT RAISE(ABORT, 'INJECTED_MONITOR_INSERT_FAILURE'); END`);
};
export const healInsert = () => dbClient.execute("DROP TRIGGER IF EXISTS fixture_block_insert");

/**
 * 让**回填 pid 那一条 UPDATE** 失败,而失败分支自己要写的 `status/ended_reason` 照旧写得进去。
 * `BEFORE UPDATE OF pid` 只在 pid 出现在 SET 列表里时才触发,所以这两条语句分得开。
 */
export const blockPidBackfill = async (taskId: string) => {
  await dbClient.execute(`CREATE TRIGGER fixture_block_pid BEFORE UPDATE OF pid ON monitors`
    + ` WHEN NEW.task_id='${taskId}' AND OLD.pid IS NULL AND NEW.pid IS NOT NULL`
    + ` BEGIN SELECT RAISE(ABORT, 'INJECTED_PID_BACKFILL_FAILURE'); END`);
};
export const healPidBackfill = () => dbClient.execute("DROP TRIGGER IF EXISTS fixture_block_pid");

/** 让「身份这一问」在一段时间里真的失败:PATH 前置一个退出码 1 的 `ps`(同 reclaim-debt 那份)。 */
const brokenBin = join(root, "create-broken-bin");
mkdirSync(brokenBin, { recursive: true });
writeFileSync(join(brokenBin, "ps"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
export async function withPsOutage<T>(body: () => Promise<T>): Promise<T> {
  const real = process.env.PATH ?? "";
  process.env.PATH = `${brokenBin}:${real}`;
  try {
    assert.equal(inspectProcess(process.pid), null, "台子前提:这段时间 ps 真的问不出来");
    return await body();
  } finally {
    process.env.PATH = real;
  }
}
