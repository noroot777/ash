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
//
// 第 2 轮审查又加了三条,钉的都是**「局部查空」不许当「整次运行清空」**:
//  ⑤ 即时清理:记号与追踪 fd 都答「没有」、而输出文件还被活后代握着 ⇒ 结论不是 empty,
//     而且落得下责任(这一条实测过的原形是:三问全答没有,孤儿继续写文件,债 0 笔);
//  ⑥ 重试清扫:记号确证空、输出文件这一问答「名字没了」(unknown)⇒ **不许销账**;
//  ⑦ 披露与重试这两个端点是实例级的 ⇒ 普通成员读不到、也发不动。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, openSync, closeSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "ash-cleanup-debt-"));
process.env.ASH_DB = join(root, "ash.db");

const { ensureSchema } = await import("../src/db/index.js");
await ensureSchema();
const {
  noteCleanupDebt, listAllCleanupDebts, settleCleanupDebt, sweepAgentCleanupDebts,
} = await import("../src/executors/cleanup-debt.js");

/** 披露面上这一刻有哪几笔(读失败直接判失败 —— 那正是不许长成空列表的那一档)。 */
async function debts(): Promise<Awaited<ReturnType<typeof listAllCleanupDebts>> & { ok: true }> {
  const listing = await listAllCleanupDebts();
  if (!listing.ok) throw new Error(`债表读不出来:${listing.reason}`);
  return listing;
}
const sweep = async () => {
  const r = await sweepAgentCleanupDebts();
  if (!r.ok) throw new Error(`清扫这一问没答出来:${r.reason}`);
  return r;
};
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
  assert.equal(noted, "noted", "落账本身要成功");
  ok("落账成功");

  const mine = (await debts()).debts.find((d) => d.unitToken === token);
  if (mine) ok("披露面上看得到它(刷新页面仍看得出「我没收干净」)");
  else fail("披露面上找不到这一笔");

  const swept = await sweep();
  const after = (await debts()).debts.find((d) => d.unitToken === token);
  // **断言按平台实际能力分档**(第 2 轮审查 N9):`ours` 档(Linux 的 `/proc/<pid>/environ`)
  // 有权真的把它杀掉,那时销账是**正确**结果 —— 上一版无条件要求「扫完还留着」,等于让
  // 正确的清理在 Linux 上把这条用例判失败。判据取清扫之后那个进程还在不在,而不是平台名。
  const stillAlive = (() => { try { process.kill(pid, 0); return true; } catch { return false; } })();
  if (stillAlive) {
    if (!after) {
      fail("进程还活着、记号还查得到,这一笔却被销账了 —— 正是责任闭环要堵的那一下");
    } else {
      ok(`杀不掉的那一档:账仍然留着(${swept.left} 笔还没收干净)`);
      if (after.attempts >= 1) ok("重试次数记上了(看得出追过几回)");
      else fail(`attempts 没涨:${after.attempts}`);
      if (after.detail) ok(`状态如实:${after.detail.slice(0, 60)}`);
      else fail("detail 空着:用户看不出卡在哪");
      if (!after.closedAt) ok("还没收档(这条线索下次还问得出来)");
      else fail("记号还查得到就收档了:那是「追不下去」,不是这个现场");
    }
  } else if (after) {
    fail(`进程已经被清扫杀掉了,账却还留着:${after.state} / ${after.detail}`);
  } else {
    ok("这个平台给得出可下刀的落点:真杀掉了,而且销了账");
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
    await sweep();
    const left = (await debts()).debts.find((d) => d.unitToken === token);
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
  assert.equal(noted, "noted", "没有记号也要记得下(键退回路径线索)");
  ok("没有记号也落下了账");

  await sweep();
  const mine = (await debts()).debts.find((d) => d.outPath === outPath);
  if (mine) {
    ok("重试过后仍然留着(文件还被握着 ⇒ 确有残留)");
    if (mine.state === "remaining") ok("而且状态升成了「确证还有」—— 路径线索问出了东西");
    else fail(`state=${mine.state},应当是 remaining`);
  } else {
    fail("文件还被活进程握着,这一笔却被销账了");
  }

  try { process.kill(holder.pid!, "SIGKILL"); } catch { /* 已经没了 */ }
  await wait(400);
  await sweep();
  const gone = (await debts()).debts.find((d) => d.outPath === outPath);
  if (!gone) ok("持有者走了、文件也没人握 ⇒ 销账");
  else fail(`没人握着了却还留着:${gone.state} / ${gone.detail}`);
}

console.log("\n4) 三条线索都没有的那种:不记(记了也追不出任何东西)");
{
  const noted = await noteCleanupDebt({
    unitToken: null, rootPid: 4242, state: "unknown",
    detail: "夹具:没有任何线索", unitVerdict: "unprovable",
  });
  // 三档要分得开(第 2 轮审查 F1 末条):`untrackable` 是「本来没什么可追的」,
  // `failed` 是「有线索、库没写进去」—— 后者是一次真正的责任丢失,不许印成前者。
  if (noted === "untrackable") ok("没有记号、没有运行专属文件 ⇒ 不往披露面上塞谁也处置不了的行");
  else fail(`记下了一笔追不出任何东西的账:${noted}`);
}

console.log("\n5) 即时清理:记号与追踪 fd 都答「没有」,输出文件还被活后代握着 ⇒ 不是 empty");
if (IS_WINDOWS) {
  console.log("   ~ Windows 不开运行专属文件,跳过");
} else {
  // 钉的是第 2 轮审查 F1 的原形:**一条线索都没说谎,只是没被问**。
  // 真实形状:父进程 stdout 重定向到这次运行的输出文件 → 它派生一个继承 stdout 的后代
  // 并退出 → 后代被改挂到 1 号名下继续写。此时记号没有(这一问不参与)、追踪 fd 没开
  // (这一问答没有)、句柄树是空的(根已 reap),上一版于是答 empty 并释放证据。
  const { cleanupAfterRun } = await import("../src/executors/kill.js");
  const { registerRunOutPath, adoptUnitToken } = await import("../src/executors/unit-token.js");
  // 记号**要有、而且要读成 `none`** —— 那才是报告实测的那个形状:记号确证空、追踪 fd 没开、
  // 句柄树是空的,三问全答「没有」。钉的就是「局部的 none 不许压过文件那一问」。
  const token = `ash-agent-test-outfile-${Date.now().toString(36)}`;
  const outPath = join(root, `run-out-live-${Date.now()}.jsonl`);
  temps.push(outPath);
  const beat = join(root, `beat-${Date.now()}.txt`);
  temps.push(beat);
  const out = openSync(outPath, "a");
  // 父进程:派生一个脱离进程组、继承 stdout 的后代,然后自己退出。
  const parent = spawn(process.execPath, ["-e", `
    const { spawn } = require("node:child_process");
    const fs = require("node:fs");
    const kid = spawn(process.execPath, ["-e",
      "let n=0; setInterval(()=>{ n++; require('node:fs').writeFileSync(process.argv[1], String(n)); }, 100); setTimeout(()=>{}, 60000);",
      ${JSON.stringify(beat)}], { stdio: ["ignore", 1, "ignore"], detached: true, env: {} });
    kid.unref();
    fs.writeFileSync(${JSON.stringify(beat)}, "0");
    setTimeout(() => process.exit(0), 200);
  `], { stdio: ["ignore", out, "ignore"], env: { ...process.env, [MONITOR_UNIT_ENV]: token } });
  closeSync(out);
  registerRunOutPath(parent, outPath);
  adoptUnitToken(parent, token);
  await new Promise<void>((r) => parent.on("close", () => r()));
  await wait(500);

  invalidateMonitorUnitScan();
  const markerVerdict = processUnitEvidence(token, { fresh: true }).verdict;
  const result = await cleanupAfterRun(parent);
  const beforeBeat = Number(readFileSync(beat, "utf8") || "0");
  await wait(400);
  const afterBeat = Number(readFileSync(beat, "utf8") || "0");
  const orphanAlive = afterBeat > beforeBeat;

  if (!orphanAlive) {
    console.log("   ~ 这台机器上那个后代没活下来,这一组没有现场可验,跳过");
  } else if (result.kind === "empty") {
    fail("孤儿还在写文件,清理却答「确证清空」—— 正是 F1 实测的那一下");
  } else {
    ok(`孤儿还在写(心跳 ${beforeBeat}→${afterBeat}),记号答 ${markerVerdict},`
      + `结论是 ${result.kind}:${result.detail.slice(0, 70)}`);
    if (markerVerdict === "none") ok("记号确证空也没能把文件那一问压过去(none 不是整项资源的空)");
    if (result.detail.includes("输出文件")) ok("而且说得出是哪条线索问出来的");
    else fail(`detail 里没提输出文件:${result.detail}`);
    const row = (await debts()).debts.find((d) => d.outPath === outPath);
    if (row) ok("责任落了盘(开机还会再追一次,不是只剩一条日志)");
    else fail("没收干净却一笔债都没留下");
  }
}

console.log("\n6) 重试清扫:记号确证空 + 输出文件「名字没了」⇒ 不许销账");
if (IS_WINDOWS) {
  console.log("   ~ Windows 不开运行专属文件,跳过");
} else {
  // 这一组的原形:`unlink` 只摘掉名字,握着那个 inode 的进程继续活、继续写 —— 路径这一问
  // 于是答 `unknown{lost}`。上一版只排除了 `held` 分支,于是「没答出来」被当成了「空」,
  // 行被删掉,心跳继续涨(第 2 轮审查 F1 第二处实测)。
  const token = `ash-agent-test-lost-${Date.now().toString(36)}`;
  const outPath = join(root, `run-out-lost-${Date.now()}.jsonl`);
  writeFileSync(outPath, "");
  const fd = openSync(outPath, "r");
  const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
    stdio: ["ignore", "ignore", "ignore", fd], detached: true,
  });
  holder.unref();
  strays.push(holder.pid!);
  closeSync(fd);
  await wait(300);
  await noteCleanupDebt({
    unitToken: token, rootPid: holder.pid!, outPath,
    state: "remaining", detail: "夹具:先记一笔", unitVerdict: "suspected",
  });
  unlinkSync(outPath);                            // 名字没了,持有者还在
  invalidateMonitorUnitScan();
  const verdict = processUnitEvidence(token, { fresh: true }).verdict;
  if (verdict !== "none") {
    console.log(`   ~ 这个平台给不出「记号确证空」(答 ${verdict}),这一组的前提不成立,跳过`);
    await settleCleanupDebt(token);
  } else {
    await sweep();
    const row = (await debts()).debts.find((d) => d.unitToken === token);
    if (!row) fail("记号空了、路径这一问却没答出来,行照样被删了 —— 正是 F1 要堵的那一下");
    else {
      ok(`行还在(state=${row.state})`);
      if (row.closedAt) ok(`收档而不是销账:${(row.closedNote ?? "").slice(0, 60)}`);
      else ok("留着继续追");
      await settleCleanupDebt(token);
    }
  }
  try { process.kill(holder.pid!, "SIGKILL"); } catch { /* 已经没了 */ }
}

console.log("\n7) 披露与重试这两个端点是实例级的:普通成员读不到、也发不动");
{
  // 钉的是第 2 轮审查 F2:认证中间件只管「登录了没有」,资源授权是每条端点自己的义务。
  // 挂的是**真的** authGate() + 真的 api,凭证也是真 store 发的 —— 不塞假 actor。
  // 这一组放在最后:它要把实例切成多人模式,那是全局状态。
  const mkMode = await import("../src/auth/mode.js");
  const store = await import("../src/auth/store.js");
  const { Hono } = await import("hono");
  const { authGate } = await import("../src/auth/middleware.js");
  const { api } = await import("../src/routes.js");

  const home = join(root, "users");
  mkdirSync(home, { recursive: true });
  await mkMode.setInstanceMode("multi", home);
  const admin = await store.createUser({
    name: "Admin", role: "admin", dirName: "admin",
    gitName: "A", gitEmail: "a@example.test", createdBy: null,
  });
  const member = await store.createUser({
    name: "Member", role: "member", dirName: "member",
    gitName: "M", gitEmail: "m@example.test", createdBy: admin.id,
  });
  const adminKey = await store.resetUserKey(admin.id);
  const memberKey = await store.resetUserKey(member.id);

  const app = new Hono();
  app.use("*", authGate());
  app.route("/api", api);
  const call = async (method: "GET" | "POST", path: string, key?: string) => {
    const res = await app.fetch(new Request(`http://127.0.0.1:4317${path}`, {
      method, headers: key ? { authorization: `Bearer ${key}` } : {},
    }));
    return { status: res.status, body: await res.text() };
  };

  // 先落一笔别人的账,这样「读到了」就等于读到了别人的 taskId/sessionId。
  await noteCleanupDebt({
    unitToken: `ash-agent-test-authz-${Date.now().toString(36)}`,
    taskId: "someone-elses-task", sessionId: "someone-elses-session", rootPid: 4243,
    state: "remaining", detail: "夹具:别人的残留", unitVerdict: "suspected",
  });

  const anon = await call("GET", "/api/cleanup-debts");
  if (anon.status === 401) ok("没登录:401");
  else fail(`没登录却不是 401:${anon.status}`);

  const read = await call("GET", "/api/cleanup-debts", memberKey);
  if (read.status === 403) ok("普通成员读:403(读不到别人任务的残留)");
  else fail(`普通成员读到了:${read.status} ${read.body.slice(0, 120)}`);

  const swept = await call("POST", "/api/cleanup-debts/sweep", memberKey);
  if (swept.status === 403) ok("普通成员发起全实例清扫:403(写端同样拦住,不是只保护读端)");
  else fail(`普通成员发动了全实例清扫:${swept.status} ${swept.body.slice(0, 120)}`);

  const asAdmin = await call("GET", "/api/cleanup-debts", adminKey);
  if (asAdmin.status === 200) ok("管理员本人读:200(闸没有把该放的也拦掉)");
  else fail(`管理员被拦了:${asAdmin.status} ${asAdmin.body.slice(0, 120)}`);
}

for (const pid of strays) {
  try { process.kill(pid, "SIGKILL"); } catch { /* 已经没了 */ }
}
for (const p of temps) {
  try { unlinkSync(p); } catch { /* 已经没了 */ }
}
console.log(bad ? `\n✗ ${bad} 项未通过` : "\n✓ 全部通过");
process.exit(bad ? 1 : 0);
