// **半截查询不许当查全** —— 第 5 轮审查 F1 的机制本身。
//
// 「谁还握着这次运行的文件」这一问以前把两件事压在一条轴上:发现了谁、问全了没有。于是
// 「发现了两个、随后 lsof 自己出错」这种回答无法表达,只能挑一档 —— 挑的是「确证有人握着」,
// 而下游把它读成「正好这些」:逐个探活、都退了就答「空」,于是证据释放、责任销账。
//
// 审查者用真实故障 `lsof`(先把自己报成持有者、再退 2)实测:活后代心跳 21→33,库里那一行
// 被真的 DELETE 了。这份脚本按同一手法钉住四处:
//
//  ① 取证层:半截回答要同时说出「发现了谁」和「没问全」,不许塌成任何一档;
//  ② 即时清理:同样的半截回答下,结论不许是「空」,责任要留着;
//  ③ 持久清扫:同一行再扫一遍不许销账、不许收档(文件还在 ⇒ 下一轮还问得出来);
//  ④ 整张进程表:`ps` 退非零但吐了半截 ⇒ 整问作废,不拿半截表当一棵进程树。
//
// 故障只注入在**系统工具边界**(PATH 前置一个真实可执行的夹具),生产代码、SQL 与进程身份
// 都是真的 —— 跑的是 `cleanupAfterRun` / `sweepAgentCleanupDebts` 本体。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, openSync, closeSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const IS_WIN = process.platform === "win32";
if (IS_WIN) {
  console.log("   ~ Windows 上没有 lsof / ps 这两条路(见 track-evidence.ts 顶部),整份跳过");
  process.exit(0);
}

const root = mkdtempSync(join(tmpdir(), "ash-holder-scan-"));
process.env.ASH_DB = join(root, "ash.db");
const ORIGINAL_PATH = process.env.PATH;

const { ensureSchema } = await import("../src/db/index.js");
await ensureSchema();
const { mintUnitToken, registerUnitToken, registerRunOutPath } = await import("../src/executors/unit-token.js");
const { cleanupAfterRun } = await import("../src/executors/kill.js");
const { probeFileHolders, holderScanFault, provenNoHolders } = await import("../src/executors/track-evidence.js");
const { listAllCleanupDebts, sweepAgentCleanupDebts } = await import("../src/executors/cleanup-debt.js");
const { processUnitEvidence } = await import("../src/proc.js");
const { isPidAlive } = await import("../src/platform.js");
const { processTableSnapshot } = await import("../src/process-generation.js");

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const beats = (path: string) => Number(readFileSync(path, "utf8") || "0");
let orphan = 0;

/**
 * PATH 前置一个夹具,**真实可执行**(不是 monkey patch:要让生产那句 `execFile` 自己去撞)。
 *
 * lsof 夹具先把**自己**报成这个文件的写持有者(`p`/`f`/`a`/`n` 四行,与 `-F pfan` 同形),
 * 然后退 2 并写一句它自己的定型故障 —— 这正是「吐了一半再出错」的最小形状。它自己随即退出,
 * 所以那个被报出来的号在调用方探活时已经死了:上一版据此判「空」。
 */
function installShim(name: string, body: string): string {
  const dir = mkdtempSync(join(root, `shim-${name}-`));
  writeFileSync(join(dir, name), `#!/bin/sh\n${body}`, { mode: 0o755 });
  process.env.PATH = `${dir}:${ORIGINAL_PATH}`;
  return dir;
}
const restorePath = () => { process.env.PATH = ORIGINAL_PATH; };

const PARTIAL_LSOF = 'for argument do target="$argument"; done\n'
  + 'exec 5>>"$target"\n'
  + 'printf "p%s\\nf5\\naw\\nn%s\\n" "$$" "$target"\n'
  + 'printf "lsof: status error: simulated incomplete scan\\n" >&2\n'
  + "exit 2\n";

let bad = 0;
const ok = (m: string) => console.log(`   ✓ ${m}`);
const fail = (m: string) => { bad += 1; console.log(`   ✗ ${m}`); };

try {
  // ── 现场:根进程退出,一个脱离的真后代继续握着这次运行的输出文件并写心跳 ──────────
  const out = join(root, "run.out");
  const beat = join(root, "beat");
  const pidFile = join(root, "orphan.pid");
  const token = mintUnitToken();
  const outFd = openSync(out, "a");
  const parent = spawn(process.execPath, ["-e", `
    const { spawn } = require("node:child_process");
    const kid = spawn(process.execPath, ["-e",
      "let n=0;setInterval(()=>{require('fs').writeFileSync(process.argv[1],String(++n))},50)",
      ${JSON.stringify(beat)}], { detached: true, stdio: ["ignore", 1, "ignore"], env: {} });
    require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(kid.pid));
    kid.unref();
    setTimeout(() => process.exit(0), 150);
  `], { stdio: ["ignore", outFd, "ignore"], env: { ...process.env, ASH_MONITOR_UNIT: token } });
  closeSync(outFd);
  registerUnitToken(parent, token);
  registerRunOutPath(parent, out);
  await new Promise<void>((r) => parent.once("close", () => r()));
  await wait(300);
  orphan = Number(readFileSync(pidFile, "utf8"));
  assert.ok(orphan > 1 && isPidAlive(orphan), "这条用例要一个真的、还活着的脱离后代");
  // 它把环境洗掉了(`env: {}`),所以记号这一问确证空 —— 只剩输出文件这一条线索。
  assert.equal(processUnitEvidence(token, { fresh: true }).verdict, "none", "记号这一问该确证空");

  console.log("1) 取证层:半截回答要同时说出「发现了谁」和「没问全」");
  {
    const real = await probeFileHolders(out);
    if (real.scan === "complete" && real.found.some((h) => h.pid === orphan)) {
      ok("真实 lsof:问全了,而且点出了那个活后代");
    } else fail("真实 lsof 都没把活后代报出来,后面几组的前提不成立");

    const shim = installShim("lsof", PARTIAL_LSOF);
    const partial = await probeFileHolders(out);
    restorePath();
    rmSync(shim, { recursive: true, force: true });
    const fault = holderScanFault(partial);
    if (fault && !fault.lost) ok(`半截回答:如实说没问全(${fault.fault})`);
    else fail("出错的那一次 lsof 被当成问全了 —— 正是 F1 那一下");
    if (partial.found.length) ok("已经发现的那个持有者照样带上去(正面线索不因出错作废)");
    else fail("半截里的正面线索被一起丢掉了(逃逸枚举就少了树根)");
    if (!provenNoHolders(partial)) ok("它不是「确证空」那一档 —— 不允许据此销毁证据");
    else fail("半截回答被读成确证空");
  }

  console.log("2) 即时清理:同样的半截回答下,不许宣布清空");
  {
    const first = await cleanupAfterRun(parent);
    const noted = await listAllCleanupDebts();
    if (first.kind !== "empty" && noted.ok && noted.debts.length === 1) {
      ok(`真实取证:结论 ${first.kind},责任落下 1 笔`);
    } else fail(`前提不成立:结论 ${first.kind}、账 ${noted.ok ? noted.debts.length : "读不出"} 笔`);

    const shim = installShim("lsof", PARTIAL_LSOF);
    const again = await cleanupAfterRun(parent);
    restorePath();
    rmSync(shim, { recursive: true, force: true });
    const after = await listAllCleanupDebts();
    if (again.kind !== "empty") ok(`半截取证:结论仍是 ${again.kind},没有宣布清空`);
    else fail("半截取证把这一次运行判成了清空(F1 的生产后果)");
    if (after.ok && after.debts.length === 1) ok("那一行责任还在");
    else fail(`责任被销掉了(现在 ${after.ok ? after.debts.length : "读不出"} 笔)`);
  }

  console.log("3) 持久清扫:同一行再扫一遍,不许销账也不许收档");
  {
    const before = beats(beat);
    const shim = installShim("lsof", PARTIAL_LSOF);
    const swept = await sweepAgentCleanupDebts();
    restorePath();
    rmSync(shim, { recursive: true, force: true });
    const rows = await listAllCleanupDebts();
    if (swept.ok && swept.settled === 0) ok("一笔都没销");
    else fail(`销了 ${swept.ok ? swept.settled : "?"} 笔`);
    if (swept.ok && swept.closed === 0) ok("也没收档:文件还在 ⇒ 下一轮还问得出来 ⇒ 该重试");
    else fail(`收了 ${swept.ok ? swept.closed : "?"} 笔的档 —— 收过档的行不再进重试名单`);
    if (rows.ok && rows.debts.length === 1) ok("行还在");
    else fail("行没了");
    await wait(200);
    if (isPidAlive(orphan) && beats(beat) > before) {
      ok(`而那个后代确实还在写(心跳 ${before} -> ${beats(beat)})`);
    } else fail("后代已经不在了,这一组没测到东西");
  }

  console.log("4) 整张进程表:退非零但吐了半截 ⇒ 整问作废");
  if (existsSync("/proc")) {
    console.log("   ~ 这台机器有 /proc,进程表走的不是 ps 那条路,跳过");
  } else {
    const shim = installShim("ps", 'printf "    1     0 Mon Jan  1 00:00:00 2024\\n"\nexit 2\n');
    const table = await processTableSnapshot();
    restorePath();
    rmSync(shim, { recursive: true, force: true });
    if (table === null) ok("半截表不是一棵进程树:这一问答「没问出来」");
    else fail(`半截表被解析成了一棵树(${table.gens.size} 项)—— 缺席会被读成「不在树上」`);
  }
} finally {
  restorePath();
  if (orphan > 1) { try { process.kill(orphan, "SIGKILL"); } catch { /* 已经没了 */ } }
  rmSync(root, { recursive: true, force: true });
}

console.log(bad ? `\n✗ ${bad} 项未通过` : "\n✓ 全部通过:半截查询不会再被当成查全");
process.exit(bad ? 1 : 0);
