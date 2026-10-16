// 回收那两份回归的共用台子:一个顽固命令、一张债表查询、一次真的 `ps` 不可用。
//
// 为什么单独一份:回收的回归分成了两份 ——「撤销是一段时间,而停止函数正常返回不等于资源已经
// 回收」(test-monitor-reclaim-debt.ts)和「身份这一问的判定本身」
// (test-monitor-reclaim-identity.ts)。两边用的是同一副台子,各抄一遍迟早漂移:漂的那一刻
// 两份测试对「什么算证明了这个号还是它」的理解就分家了,而那正是这组回归唯一要钉的东西。
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { db, isPidAlive, root, schema } from "./monitors-fixture.js";
import { inspectProcess } from "../src/proc.js";


// 忽略 TERM 的命令:壳自己 trap 掉,每轮重起一个 sleep —— TERM 打到整组时组里始终有人,
// 只有 +2 秒那把 SIGKILL 才收得掉它。(同一招在 test-project-commands.ts 里也用着)
export const STUBBORN = "trap '' TERM HUP INT; while :; do sleep 0.2; done";

export const debtRow = async (monId: string) => (await db.select().from(schema.monitorReclaimDebts)
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
export async function withPsOutage(pid: number, body: () => Promise<void>): Promise<void> {
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
