// 「这一次运行的后代没收干净」这件事的**责任闭环**:落账 → 披露 → 重试 → 销账/收档。
//
// 钉的是本轮审查 F2 的后半段:允许 macOS 给不出可下刀的落点(那种时候不贸然下刀是对的),
// **但不许把仍能检测到的残留宣布成清理完成、再销掉可重试的清理责任**。所以这里验的不是
// 「能不能杀掉」,而是:
//
//  ① 有记号 + 进程还活着 ⇒ 账留着、状态如实(macOS 上就是「看得见、给不出落点」);
//  ② 有记号 + 进程已退   ⇒ 记号确证空 ⇒ **销账**(账不会无限积压);
//  ③ 没有记号(升级前建的老会话行)⇒ 退回路径线索当键,照样记得下、追得动;
//  ④ 账活得过「句柄注销 / 回合结束 / 下一轮覆写会话列」—— 它不在内存里,也不按会话键控。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, openSync, closeSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "ash-cleanup-debt-"));
process.env.ASH_DB = join(root, "ash.db");

const { ensureSchema } = await import("../src/db/index.js");
await ensureSchema();
const {
  noteCleanupDebt, listOpenCleanupDebts, settleCleanupDebt, sweepAgentCleanupDebts,
} = await import("../src/executors/cleanup-debt.js");
const { MONITOR_UNIT_ENV, invalidateMonitorUnitScan } = await import("../src/monitor-unit-scan.js");
const { processUnitEvidence } = await import("../src/proc.js");
const { IS_WINDOWS } = await import("../src/platform.js");

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const strays: number[] = [];
const temps: string[] = [];
let bad = 0;
const ok = (m: string) => console.log(`   ✓ ${m}`);
const fail = (m: string) => { bad += 1; console.log(`   ✗ ${m}`); };

/** 起一个带着指定记号的真进程(记号靠环境继承,这是归属的那条线索)。 */
function markedSleeper(token: string): number {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
    stdio: "ignore", detached: true,
    env: { ...process.env, [MONITOR_UNIT_ENV]: token },
  });
  child.unref();
  invalidateMonitorUnitScan();
  strays.push(child.pid!);
  return child.pid!;
}

console.log("1) 有记号、进程还活着:账留着,状态如实");
{
  const token = `ash-agent-test-alive-${Date.now().toString(36)}`;
  const pid = markedSleeper(token);
  await wait(400);
  const noted = await noteCleanupDebt({
    unitToken: token, rootPid: pid, state: "remaining",
    detail: "夹具:这一轮没收干净", unitVerdict: processUnitEvidence(token, { fresh: true }).verdict,
  });
  assert.equal(noted, true, "落账本身要成功");
  ok("落账成功");

  const open = await listOpenCleanupDebts();
  const mine = open.find((d) => d.unitToken === token);
  if (mine) ok("披露面上看得到它(刷新页面仍看得出「我没收干净」)");
  else fail("披露面上找不到这一笔");

  const swept = await sweepAgentCleanupDebts();
  const after = (await listOpenCleanupDebts()).find((d) => d.unitToken === token);
  if (after) {
    ok(`重试之后账仍然留着(${swept.left} 笔还没收干净)`);
    if (after.attempts >= 1) ok("重试次数记上了(看得出追过几回)");
    else fail(`attempts 没涨:${after.attempts}`);
    if (after.detail) ok(`状态如实:${after.detail.slice(0, 60)}`);
    else fail("detail 空着:用户看不出卡在哪");
  } else {
    fail("进程还活着、记号还查得到,这一笔却被销账了 —— 正是 F2 要堵的那一下");
  }
  try { process.kill(pid, "SIGKILL"); } catch { /* 已经没了 */ }
}

console.log("\n2) 有记号、进程已退:记号确证空 ⇒ 销账(账不会无限积压)");
{
  const token = `ash-agent-test-gone-${Date.now().toString(36)}`;
  const pid = markedSleeper(token);
  await wait(300);
  await noteCleanupDebt({
    unitToken: token, rootPid: pid, state: "remaining",
    detail: "夹具:先记一笔", unitVerdict: "suspected",
  });
  try { process.kill(pid, "SIGKILL"); } catch { /* 已经没了 */ }
  await wait(500);
  invalidateMonitorUnitScan();
  const verdict = processUnitEvidence(token, { fresh: true }).verdict;
  if (verdict === "none") {
    await sweepAgentCleanupDebts();
    const left = (await listOpenCleanupDebts()).find((d) => d.unitToken === token);
    if (!left) ok("记号确证空 ⇒ 这一笔销账(行也删掉)");
    else fail(`记号已空却还留着:state=${left.state}`);
  } else {
    // 这台机器读不到别的进程的环境(win32)⇒ 这一档本来就证不出,不当失败。
    console.log(`   ~ 这个平台给不出「确证空」(记号答 ${verdict}),跳过销账断言`);
    await settleCleanupDebt(token);
  }
}

console.log("\n3) 没有记号的老会话行:退回路径线索当键,照样记得下");
if (IS_WINDOWS) {
  console.log("   ~ Windows 不开这两个运行专属文件,跳过");
} else {
  const outPath = join(root, `run-out-${Date.now()}.jsonl`);
  writeFileSync(outPath, "");
  temps.push(outPath);
  const fd = openSync(outPath, "r");
  const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
    stdio: ["ignore", "ignore", "ignore", fd], detached: true,
  });
  holder.unref();
  strays.push(holder.pid!);
  closeSync(fd);
  await wait(400);

  const noted = await noteCleanupDebt({
    unitToken: null, rootPid: holder.pid!, outPath,
    state: "unknown", detail: "夹具:老会话行,没有记号", unitVerdict: "unprovable",
  });
  assert.equal(noted, true, "没有记号也要记得下(键退回路径线索)");
  ok("没有记号也落下了账");

  await sweepAgentCleanupDebts();
  const mine = (await listOpenCleanupDebts()).find((d) => d.outPath === outPath);
  if (mine) {
    ok("重试过后仍然留着(文件还被握着 ⇒ 确有残留)");
    if (mine.state === "remaining") ok("而且状态升成了「确证还有」—— 路径线索问出了东西");
    else fail(`state=${mine.state},应当是 remaining`);
  } else {
    fail("文件还被活进程握着,这一笔却被销账了");
  }

  try { process.kill(holder.pid!, "SIGKILL"); } catch { /* 已经没了 */ }
  await wait(400);
  await sweepAgentCleanupDebts();
  const gone = (await listOpenCleanupDebts()).find((d) => d.outPath === outPath);
  if (!gone) ok("持有者走了、文件也没人握 ⇒ 销账");
  else fail(`没人握着了却还留着:${gone.state} / ${gone.detail}`);
}

console.log("\n4) 三条线索都没有的那种:不记(记了也追不出任何东西)");
{
  const noted = await noteCleanupDebt({
    unitToken: null, rootPid: 4242, state: "unknown",
    detail: "夹具:没有任何线索", unitVerdict: "unprovable",
  });
  if (noted === false) ok("没有记号、没有运行专属文件 ⇒ 不往披露面上塞谁也处置不了的行");
  else fail("记下了一笔追不出任何东西的账");
}

for (const pid of strays) {
  try { process.kill(pid, "SIGKILL"); } catch { /* 已经没了 */ }
}
for (const p of temps) {
  try { unlinkSync(p); } catch { /* 已经没了 */ }
}
console.log(bad ? `\n✗ ${bad} 项未通过` : "\n✓ 全部通过");
process.exit(bad ? 1 : 0);
